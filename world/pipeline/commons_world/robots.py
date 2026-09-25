"""robots.txt parsing and the pipeline's robots policy.

A parser for the Robots Exclusion Protocol, RFC 9309, plus the status policy
from world/pipeline/SOURCES.md:

- 2xx: parse the file;
- 401 or 403: disallow everything (stricter than RFC 9309, on purpose);
- any other 4xx: allow everything (RFC 9309 "unavailable");
- 5xx, unreachable, or a redirect chain that does not end: disallow everything.

Fetching is the HTTP client's job (commons_world.http); this module only turns
a status and a body into a decision.
"""

import re
from dataclasses import dataclass, field
from urllib.parse import urlsplit

# RFC 9309 s2.5: crawlers must parse at least the first 500 KiB.
MAX_ROBOTS_BYTES = 500 * 1024

# SOURCES.md: up to five redirects are followed when fetching robots.txt.
MAX_ROBOTS_REDIRECTS = 5

POLICY_PARSED = "parsed"
POLICY_ALLOW_ALL = "allow-all"
POLICY_DISALLOW_ALL = "disallow-all"

_UNRESERVED = frozenset(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
_HEX = frozenset("0123456789abcdefABCDEF")
_TOKEN_RE = re.compile(r"[A-Za-z_-]+")


def policy_for_status(status):
    """Map the final HTTP status of a robots.txt fetch to a policy name.

    `status` is None when the host could not be reached at all.
    """
    if status is None:
        return POLICY_DISALLOW_ALL
    if 200 <= status < 300:
        return POLICY_PARSED
    if status in (401, 403):
        return POLICY_DISALLOW_ALL
    if 400 <= status < 500:
        return POLICY_ALLOW_ALL
    # 5xx, and anything else (1xx, or a 3xx left over when redirects ran out).
    return POLICY_DISALLOW_ALL


def normalise(path):
    """Percent-encoding normalisation for comparing paths (RFC 9309 s2.2.2).

    - characters outside US-ASCII are UTF-8 encoded and percent-escaped;
    - spaces and control characters are percent-escaped;
    - an escape of an unreserved character (letters, digits, - . _ ~) is decoded;
    - every other escape is kept, with its hex digits in upper case;
    - reserved characters such as / ? = & * $ are left as they are.
    """
    out = []
    k = 0
    while k < len(path):
        ch = path[k]
        if ch == "%" and k + 2 < len(path) and path[k + 1] in _HEX and path[k + 2] in _HEX:
            byte = int(path[k + 1:k + 3], 16)
            if chr(byte) in _UNRESERVED:
                out.append(chr(byte))
            else:
                out.append("%" + path[k + 1:k + 3].upper())
            k += 3
            continue
        if ch == "%":
            out.append("%25")
        elif ord(ch) > 126 or ord(ch) <= 32:
            out.extend("%{:02X}".format(b) for b in ch.encode("utf-8"))
        else:
            out.append(ch)
        k += 1
    return "".join(out)


def _pattern_regex(pattern):
    """Compile a normalised rule path into an anchored regex.

    `*` matches any run of characters; a `$` at the very end anchors the match
    to the end of the path. Anywhere else, `$` is an ordinary character.
    """
    anchored = pattern.endswith("$")
    body = pattern[:-1] if anchored else pattern
    parts = [".*" if ch == "*" else re.escape(ch) for ch in body]
    return re.compile("".join(parts) + (r"\Z" if anchored else ""), re.DOTALL)


@dataclass(frozen=True)
class Rule:
    """One allow or disallow line, already normalised."""

    allow: bool
    pattern: str
    regex: re.Pattern = field(compare=False, repr=False)

    @classmethod
    def make(cls, allow, raw):
        pattern = normalise(raw)
        if not pattern.startswith(("/", "*")):
            pattern = "/" + pattern
        return cls(allow, pattern, _pattern_regex(pattern))

    def matches(self, path):
        return self.regex.match(path) is not None


@dataclass
class Group:
    """User-agent lines and the rules that follow them."""

    agents: list = field(default_factory=list)
    rules: list = field(default_factory=list)


def _agent_token(value):
    """The product token of a user-agent line value, lower case ("*" stays "*")."""
    value = value.strip()
    if value == "*":
        return "*"
    match = _TOKEN_RE.match(value)
    return match.group(0).lower() if match else value.lower()


class RobotsFile:
    """A parsed robots.txt."""

    def __init__(self, groups):
        self.groups = groups

    @classmethod
    def parse(cls, content):
        """Parse robots.txt bytes or text. Unknown records (Sitemap, ...) are ignored."""
        if isinstance(content, bytes):
            content = content[:MAX_ROBOTS_BYTES].decode("utf-8", errors="replace")
        if content.startswith("\ufeff"):
            content = content[1:]
        groups = []
        current = None
        in_agent_run = False
        for raw_line in content.splitlines():
            line = raw_line.split("#", 1)[0].strip()
            if ":" not in line:
                continue
            key, value = line.split(":", 1)
            key = key.strip().lower()
            value = value.strip()
            if key == "user-agent":
                if current is None or not in_agent_run:
                    current = Group()
                    groups.append(current)
                current.agents.append(value)
                in_agent_run = True
            elif key in ("allow", "disallow"):
                in_agent_run = False
                if current is None or value == "":
                    # Rules before any user-agent line belong to no group, and an
                    # empty value ("Disallow:") restricts nothing.
                    continue
                current.rules.append(Rule.make(key == "allow", value))
            # Any other record neither starts nor ends a group.
        return cls(groups)

    def rules_for(self, token):
        """The combined rules of every group naming `token`, else of every `*` group."""
        token = token.lower()
        named = [g for g in self.groups if any(_agent_token(a) == token for a in g.agents)]
        if not named:
            named = [g for g in self.groups if any(_agent_token(a) == "*" for a in g.agents)]
        return [rule for group in named for rule in group.rules]

    def allowed(self, path_or_url, token):
        """True if `token` may fetch the path (or the path of a full URL)."""
        path = path_of(path_or_url)
        if path == "/robots.txt":
            return True
        path = normalise(path)
        best = None
        for rule in self.rules_for(token):
            if rule.matches(path):
                rank = (len(rule.pattern), 1 if rule.allow else 0)
                if best is None or rank > best[0]:
                    best = (rank, rule)
        return True if best is None else best[1].allow


def path_of(path_or_url):
    """Path plus query of a URL; a bare path is returned as it is ("/" if empty)."""
    if "://" in path_or_url:
        parts = urlsplit(path_or_url)
        path = parts.path or "/"
        if parts.query:
            path += "?" + parts.query
        return path
    return path_or_url or "/"


@dataclass
class RobotsPolicy:
    """The robots decision for one host, as applied by the HTTP client."""

    host: str
    status: object
    policy: str
    checked_at: str
    robots: object = None
    detail: str = ""
    token: str = "CommonsWorld"

    def allowed(self, path_or_url):
        if self.policy == POLICY_ALLOW_ALL:
            return True
        if self.policy == POLICY_DISALLOW_ALL:
            return False
        return self.robots.allowed(path_or_url, self.token)

    def record(self):
        """The manifest's robots entry: host, status, policy, checked_at."""
        return {"host": self.host, "status": self.status, "policy": self.policy,
                "checked_at": self.checked_at}


def decide(host, status, content, checked_at, token, detail=""):
    """Build a RobotsPolicy from the final status and body of a robots.txt fetch."""
    policy = policy_for_status(status)
    robots = RobotsFile.parse(content or b"") if policy == POLICY_PARSED else None
    return RobotsPolicy(host=host, status=status, policy=policy, checked_at=checked_at,
                        robots=robots, detail=detail, token=token)
