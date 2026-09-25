"""The only way pipeline code reaches the network.

Every request goes through `Client`, which:

- refuses any host not on the allowlist (sources.ALLOWED_HOSTS), and any
  scheme but https. The host part must be a plain host name: no user info
  ("@"), no port, no backslash, whitespace or control character, so that
  every URL parser, including the one `requests` connects with, reads the
  same host that was checked;
- fetches each host's robots.txt before its first request and applies it,
  including to every hop of a redirect (redirects are followed by hand, at
  most five, and each new host is checked against the allowlist and its own
  robots.txt);
- waits at least `min_interval` seconds between requests to the same host;
- retries 429 and 5xx up to four times, after 2, 4, 8 and 16 s, waiting
  longer if Retry-After asks for it; if Retry-After asks for more than 60 s
  the client gives up rather than come back early;
- caches every 2xx response on disk, keyed by method, URL (parameters sorted)
  and body, so a rebuild does not refetch; with offline=True it answers only
  from that cache and raises on a miss. A cached response is served only if
  the host it finally came from (after redirects) is still allowed.

Tests pass `transport=` to inject fake responses. A transport is a callable
`(method, url, headers, body, timeout) -> (status, headers, content)` that
raises TransportError when the host cannot be reached.
"""

import email.utils
import hashlib
import json as jsonlib
import os
import re
import tempfile
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qsl, quote, urlencode, urljoin, urlsplit, urlunsplit

from urllib3.util import parse_url as urllib3_parse_url

from . import robots as robotslib
from .sources import ALLOWED_HOSTS, ROBOTS_TOKEN, USER_AGENT

REDIRECT_STATUSES = frozenset({301, 302, 303, 307, 308})
MAX_REDIRECTS = 5
BACKOFF_S = (2, 4, 8, 16)
MAX_RETRY_AFTER_S = 60
DEFAULT_TIMEOUT_S = 120.0

# A plain DNS host name: dot-separated labels of letters, digits and inner hyphens.
_LABEL = r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
_HOST_NAME = re.compile(r"^{0}(?:\.{0})+$".format(_LABEL))
# Characters that URL parsers disagree about: a backslash (WHATWG reads it as
# "/", urllib.parse does not), whitespace and control characters (stripped by
# some parsers, kept or escaped by others).
_UNSAFE_URL_CHARS = re.compile(r"[\x00-\x20\x7f\\]")

# Response headers that describe the transfer rather than the content, or that
# could carry state. They are not stored in the cache.
_DROP_HEADERS = frozenset({"content-encoding", "content-length", "transfer-encoding",
                           "connection", "set-cookie", "keep-alive"})


class HostNotAllowed(Exception):
    """The URL's host (or scheme) is not on the allowlist."""


class RobotsDisallowed(Exception):
    """robots.txt, or the robots policy for its status, forbids this URL."""


class OfflineCacheMiss(Exception):
    """offline=True and the response is not in the cache."""


class TransportError(Exception):
    """The host could not be reached (connection, TLS or timeout failure)."""


class TooManyRedirects(Exception):
    """More than five redirects."""


class HTTPError(Exception):
    """A non-2xx response where the caller required success."""

    def __init__(self, response, message=None):
        self.response = response
        super().__init__(message or "HTTP {} for {}".format(response.status, response.url))


@dataclass
class Response:
    """A response as the pipeline sees it."""

    status: int
    headers: dict
    content: bytes
    url: str
    from_cache: bool = False
    fetched_at: str = ""
    robots: list = field(default_factory=list, repr=False)

    @property
    def ok(self):
        return 200 <= self.status < 300

    @property
    def text(self):
        return self.content.decode("utf-8", errors="replace")

    def json(self):
        return jsonlib.loads(self.content.decode("utf-8"))

    def raise_for_status(self):
        if not self.ok:
            raise HTTPError(self)
        return self


def utc_now_iso():
    """Current UTC time, to the second, as 2026-09-25T12:00:00Z."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def canonical_url(url, params=None):
    """The URL with its query parameters (existing and `params`) sorted by name.

    This is both the URL that is sent and the URL the cache is keyed on.
    """
    parts = urlsplit(url)
    pairs = parse_qsl(parts.query, keep_blank_values=True)
    for key, value in (params or {}).items():
        if value is None:
            continue
        if isinstance(value, bool):
            value = "true" if value else "false"
        pairs.append((str(key), str(value)))
    pairs.sort(key=lambda kv: kv[0])
    query = urlencode(pairs, quote_via=quote, safe=",:")
    return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), parts.path or "/", query, ""))


def cache_key(method, url, body=None):
    """sha256 over the method, the canonical URL and the request body."""
    digest = hashlib.sha256()
    digest.update(method.upper().encode("ascii"))
    digest.update(b"\n")
    digest.update(url.encode("utf-8"))
    digest.update(b"\n")
    digest.update(body or b"")
    return digest.hexdigest()


def host_of(url):
    return (urlsplit(url).hostname or "").lower()


def parse_retry_after(value, now=None):
    """Seconds asked for by a Retry-After header (delta-seconds or HTTP date), or None."""
    if value is None:
        return None
    value = value.strip()
    if value.isdigit():
        return int(value)
    try:
        when = email.utils.parsedate_to_datetime(value)
    except (TypeError, ValueError, IndexError):
        return None
    if when is None:
        return None
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    now = now or datetime.now(timezone.utc)
    return max(0, int((when - now).total_seconds() + 0.999))


_SESSION = None


def requests_transport(method, url, headers, body, timeout):
    """The real transport: `requests`, no automatic redirects, no cookies kept."""
    global _SESSION
    import http.cookiejar

    import requests

    if _SESSION is None:
        _SESSION = requests.Session()
        _SESSION.cookies.set_policy(http.cookiejar.DefaultCookiePolicy(allowed_domains=[]))
    try:
        resp = _SESSION.request(method, url, headers=headers, data=body, timeout=timeout,
                                allow_redirects=False)
    except requests.RequestException as exc:
        raise TransportError("{} {}: {}".format(method, url, exc)) from exc
    return resp.status_code, dict(resp.headers), resp.content


class Client:
    """Allowlisted, robots-aware, rate-limited, caching HTTP client."""

    def __init__(self, cache_dir, user_agent=USER_AGENT, allowed_hosts=ALLOWED_HOSTS,
                 min_interval=1.0, offline=False, transport=None, *,
                 sleep=time.sleep, clock=time.monotonic, now=utc_now_iso,
                 timeout=DEFAULT_TIMEOUT_S, robots_token=ROBOTS_TOKEN):
        self.cache_dir = Path(cache_dir) if cache_dir is not None else None
        self.user_agent = user_agent
        self.allowed_hosts = frozenset(h.lower() for h in allowed_hosts)
        self.min_interval = float(min_interval)
        self.offline = bool(offline)
        self.transport = transport if transport is not None else requests_transport
        self.sleep = sleep
        self.clock = clock
        self.now = now
        self.timeout = timeout
        self.robots_token = robots_token
        self._robots = {}          # host -> RobotsPolicy checked in this session
        self._cached_robots = {}   # host -> record attached to a cache entry served
        self._last_request = {}    # host -> clock() when the last request finished
        self.fetch_log = []        # one entry per response handed to a caller
        self.requests_made = 0     # network requests, robots.txt included

    # -- public API ---------------------------------------------------------

    def get(self, url, params=None, headers=None, cache_check=None):
        """GET `url` with `params`. See `request`."""
        return self.request("GET", url, params=params, headers=headers,
                            cache_check=cache_check)

    def post(self, url, json=None, data=None, headers=None, cache_check=None):
        """POST a JSON body (`json`) or raw/form data (`data`). See `request`."""
        headers = dict(headers or {})
        if json is not None:
            body = jsonlib.dumps(json, sort_keys=True, separators=(",", ":")).encode("utf-8")
            headers.setdefault("Content-Type", "application/json")
        elif isinstance(data, dict):
            body = urlencode(sorted((str(k), str(v)) for k, v in data.items())).encode("ascii")
            headers.setdefault("Content-Type", "application/x-www-form-urlencoded")
        elif isinstance(data, str):
            body = data.encode("utf-8")
        else:
            body = data
        return self.request("POST", url, headers=headers, body=body, cache_check=cache_check)

    def request(self, method, url, params=None, headers=None, body=None, cache_check=None):
        """Make one request, from the cache if possible.

        `cache_check(response) -> bool` can veto caching a 2xx response whose
        body is an error in disguise (ArcGIS answers some errors with 200).
        Non-2xx responses are returned, not raised; call raise_for_status().
        """
        method = method.upper()
        self._check_host(url)
        full = canonical_url(url, params)
        self._check_host(full)
        key = cache_key(method, full, body)
        cached = self._cache_get(key)
        if cached is not None:
            if cached.url and cached.url != full:
                self._check_host(cached.url)  # where a cached redirect finally led
            self._log(method, full, cached)
            return cached
        if self.offline:
            raise OfflineCacheMiss("{} {}: not in the cache, and the client is offline"
                                   .format(method, full))
        resp = self._fetch(method, full, headers or {}, body)
        if resp.ok and (cache_check is None or cache_check(resp)):
            self._cache_put(key, method, full, resp)
        self._log(method, full, resp)
        return resp

    def check_robots(self, host):
        """Fetch and decide robots.txt for `host`, once per client."""
        host = host.lower()
        if host in self._robots:
            return self._robots[host]
        if host not in self.allowed_hosts:
            raise HostNotAllowed("{} is not on the allowlist".format(host))
        url = "https://{}/robots.txt".format(host)
        status, content, detail, hops = None, b"", "", 0
        while True:
            try:
                resp = self._send_with_retries("GET", url, {}, None)
            except TransportError as exc:
                status, detail = None, "unreachable: {}".format(exc)
                break
            location = resp.headers.get("location")
            if resp.status in REDIRECT_STATUSES and location:
                hops += 1
                target = urljoin(url, location)
                if hops > robotslib.MAX_ROBOTS_REDIRECTS:
                    status, detail = resp.status, "more than {} redirects".format(
                        robotslib.MAX_ROBOTS_REDIRECTS)
                    break
                try:
                    self._check_host(target)
                except HostNotAllowed:
                    status, detail = resp.status, "redirected to {!r}, which is not allowed".format(
                        target)
                    break
                url = target
                continue
            status, content = resp.status, resp.content
            break
        policy = robotslib.decide(host, status, content, self.now(), self.robots_token, detail)
        self._robots[host] = policy
        return policy

    def robots_log(self):
        """Robots decisions behind the responses served: [{host, status, policy, checked_at}].

        A host checked in this session is reported as checked now. A host whose
        responses all came from the cache is reported with the decision stored
        alongside them, marked from_cache.
        """
        out = {}
        for host, record in self._cached_robots.items():
            out[host] = dict(record, from_cache=True)
        for host, policy in self._robots.items():
            out[host] = dict(policy.record(), from_cache=False)
        return [out[h] for h in sorted(out)]

    # -- internals ----------------------------------------------------------

    def _check_host(self, url):
        """Refuse anything but https to a plain, allowlisted host name.

        The host is read by urllib.parse and by urllib3 (which `requests`
        connects through), and the two must agree. A URL with user info, a
        port, a backslash, whitespace or a control character is refused
        outright: those are where URL parsers have been seen to disagree.
        """
        if _UNSAFE_URL_CHARS.search(url):
            raise HostNotAllowed("{!r}: whitespace, control characters and backslashes are "
                                 "refused in URLs".format(url))
        parts = urlsplit(url)
        if parts.scheme != "https":
            raise HostNotAllowed("{}: only https is allowed".format(url))
        host = (parts.hostname or "").lower()
        if parts.netloc.lower() != host or not _HOST_NAME.match(host):
            raise HostNotAllowed("{!r}: the host part must be a plain host name, with no user "
                                 "info or port".format(url))
        if host not in self.allowed_hosts:
            raise HostNotAllowed("{} is not on the allowlist (see SOURCES.md)".format(host))
        try:
            other = (urllib3_parse_url(url).host or "").lower()
        except ValueError as exc:
            raise HostNotAllowed("{!r}: urllib3 cannot parse it ({})".format(url, exc)) from exc
        if other != host:
            raise HostNotAllowed("{!r}: urllib.parse reads the host as {} but urllib3 as {}"
                                 .format(url, host, other))

    def _fetch(self, method, url, headers, body):
        """Send, following redirects by hand, checking every hop."""
        records = []
        hops = 0
        while True:
            self._check_host(url)
            host = host_of(url)
            policy = self.check_robots(host)
            records.append(policy.record())
            if not policy.allowed(url):
                raise RobotsDisallowed("{}: {} robots policy for {} ({}) forbids it".format(
                    url, policy.policy, host, policy.status))
            resp = self._send_with_retries(method, url, headers, body)
            location = resp.headers.get("location")
            if resp.status in REDIRECT_STATUSES and location:
                hops += 1
                if hops > MAX_REDIRECTS:
                    raise TooManyRedirects("{}: more than {} redirects".format(url, MAX_REDIRECTS))
                if resp.status == 303 or (resp.status in (301, 302) and method == "POST"):
                    method, body = "GET", None
                url = urljoin(url, location)
                continue
            resp.robots = records
            return resp

    def _wait_turn(self, host):
        last = self._last_request.get(host)
        if last is None:
            return
        wait = self.min_interval - (self.clock() - last)
        if wait > 0:
            self.sleep(wait)

    def _send_once(self, method, url, headers, body):
        host = host_of(url)
        self._wait_turn(host)
        out_headers = {k: v for k, v in headers.items() if k.lower() != "user-agent"}
        out_headers["User-Agent"] = self.user_agent
        try:
            self.requests_made += 1
            status, resp_headers, content = self.transport(method, url, out_headers, body,
                                                           self.timeout)
        finally:
            self._last_request[host] = self.clock()
        resp_headers = {str(k).lower(): v for k, v in (resp_headers or {}).items()
                        if str(k).lower() not in _DROP_HEADERS}
        return Response(status=int(status), headers=resp_headers, content=content or b"",
                        url=url, fetched_at=self.now())

    def _send_with_retries(self, method, url, headers, body):
        """One logical request: retries on 429, 5xx and transport failures."""
        last_error = None
        resp = None
        for attempt in range(len(BACKOFF_S) + 1):
            try:
                resp = self._send_once(method, url, headers, body)
                last_error = None
            except TransportError as exc:
                resp, last_error = None, exc
            if resp is not None and not (resp.status == 429 or resp.status >= 500):
                return resp
            if attempt == len(BACKOFF_S):
                break
            delay = BACKOFF_S[attempt]
            if resp is not None:
                asked = parse_retry_after(resp.headers.get("retry-after"))
                if asked is not None:
                    if asked > MAX_RETRY_AFTER_S:
                        break  # we will not come back sooner than asked
                    delay = max(delay, asked)
            self.sleep(delay)
        if resp is None:
            raise last_error
        return resp

    def _log(self, method, url, resp):
        self.fetch_log.append({"method": method, "url": url, "status": resp.status,
                               "fetched_at": resp.fetched_at, "from_cache": resp.from_cache})

    # -- disk cache ---------------------------------------------------------

    def _cache_paths(self, key):
        folder = self.cache_dir / key[:2]
        return folder / (key + ".bin"), folder / (key + ".json")

    def _cache_get(self, key):
        if self.cache_dir is None:
            return None
        body_path, meta_path = self._cache_paths(key)
        if not (meta_path.is_file() and body_path.is_file()):
            return None
        try:
            meta = jsonlib.loads(meta_path.read_text(encoding="ascii"))
            content = body_path.read_bytes()
        except (OSError, ValueError):
            return None
        if hashlib.sha256(content).hexdigest() != meta.get("sha256"):
            return None  # damaged entry: treat as a miss
        for record in meta.get("robots", []):
            host = record.get("host")
            previous = self._cached_robots.get(host)
            if host and (previous is None or record["checked_at"] > previous["checked_at"]):
                self._cached_robots[host] = record
        return Response(status=meta["status"], headers=meta.get("headers", {}), content=content,
                        url=meta.get("final_url", meta.get("url", "")), from_cache=True,
                        fetched_at=meta.get("fetched_at", ""), robots=meta.get("robots", []))

    def _cache_put(self, key, method, url, resp):
        if self.cache_dir is None:
            return
        body_path, meta_path = self._cache_paths(key)
        body_path.parent.mkdir(parents=True, exist_ok=True)
        meta = {"method": method, "url": url, "final_url": resp.url, "status": resp.status,
                "headers": resp.headers, "fetched_at": resp.fetched_at,
                "sha256": hashlib.sha256(resp.content).hexdigest(), "robots": resp.robots}
        _atomic_write(body_path, resp.content)
        _atomic_write(meta_path, jsonlib.dumps(meta, ensure_ascii=True, sort_keys=True,
                                               indent=1).encode("ascii"))


def _atomic_write(path, data):
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".tmp-", suffix=path.suffix)
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
