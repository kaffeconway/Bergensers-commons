"""The HTTP client: allowlist, robots.txt, redirects, rate limit, retries, cache."""

import json
from pathlib import Path
from urllib.parse import urlsplit

import pytest

from commons_world import http as cw_http
from commons_world.http import (Client, HostNotAllowed, OfflineCacheMiss, RobotsDisallowed,
                                TooManyRedirects, TransportError, cache_key, canonical_url,
                                parse_retry_after)
from commons_world.sources import ALLOWED_HOSTS, NOT_ALLOWLISTED, REFUSED_HOSTS, USER_AGENT

from conftest import FakeTransport

API = "api.kartverket.no"
OK = (200, {"Content-Type": "application/json"}, b'{"ok": true}')


def sources_md_hosts():
    """{host: status cell} from the hosts table in SOURCES.md."""
    text = (Path(__file__).resolve().parents[1] / "SOURCES.md").read_text(encoding="ascii")
    out = {}
    for line in text.splitlines():
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) == 5 and cells[0].startswith("`") and cells[0].endswith("`"):
            out[cells[0].strip("`")] = cells[2]
    return out


def test_allowlist_is_exactly_sources_md():
    assert ALLOWED_HOSTS == {"api.kartverket.no", "hoydedata.no", "wcs.geonorge.no",
                             "wfs.geonorge.no", "nedlasting.geonorge.no"}
    table = sources_md_hosts()
    assert {h for h, status in table.items() if status.startswith("**allowed**")} == ALLOWED_HOSTS
    assert not ALLOWED_HOSTS & set(REFUSED_HOSTS)
    assert not ALLOWED_HOSTS & set(NOT_ALLOWLISTED)
    assert set(NOT_ALLOWLISTED) <= set(table)
    assert "ws.geonorge.no" in REFUSED_HOSTS and "overpass-api.de" in REFUSED_HOSTS


@pytest.mark.parametrize("url", [
    # urllib.parse reads the host as api.kartverket.no; requests would connect to evil.example
    "https://evil.example\\@api.kartverket.no/x",
    "https://evil.example@api.kartverket.no/x",          # user info
    "https://user:pw@api.kartverket.no/x",
    "https://api.kartverket.no:443/x",                   # a port
    "https://api.kartverket.no:8443/x",
    "https://api.kartverket.no./x",                      # trailing dot
    "https://api.kartverket.no /x",                      # whitespace
    "https://evil.example\t@api.kartverket.no/x",
    "https://api.kartverket.no/a\\b",                    # a backslash anywhere
    "https://[::1]/x",
])
def test_refuses_urls_whose_host_parsers_could_read_differently(make_client, url):
    transport = FakeTransport()
    with pytest.raises(HostNotAllowed):
        make_client(transport).get(url)
    assert transport.calls == []


def test_redirect_to_a_malformed_url_is_refused(make_client):
    transport = FakeTransport({("GET", API, "/a"): (
        302, {"Location": "https://evil.example\\@api.kartverket.no/b"}, b"")})
    with pytest.raises(HostNotAllowed):
        make_client(transport).get("https://api.kartverket.no/a")
    assert [urlsplit(u).path for u in transport.urls()] == ["/robots.txt", "/a"]


def test_robots_redirect_to_a_malformed_url_disallows_all(make_client):
    transport = FakeTransport({("GET", API, "/a"): OK}, robots={API: (
        301, {"Location": "https://evil.example\\@api.kartverket.no/robots.txt"}, b"")})
    with pytest.raises(RobotsDisallowed):
        make_client(transport).get("https://api.kartverket.no/a")
    assert transport.urls() == ["https://api.kartverket.no/robots.txt"]


def test_cached_redirect_to_a_host_no_longer_allowed_is_not_served(make_client):
    transport = FakeTransport({
        ("GET", API, "/r"): (302, {"Location": "https://hoydedata.no/final"}, b""),
        ("GET", "hoydedata.no", "/final"): OK})
    assert make_client(transport).get("https://api.kartverket.no/r").status == 200
    narrower = ALLOWED_HOSTS - {"hoydedata.no"}
    later = FakeTransport()
    with pytest.raises(HostNotAllowed):
        make_client(later, offline=True, allowed_hosts=narrower).get("https://api.kartverket.no/r")
    assert later.calls == []
    # still served while the final host is allowed
    assert make_client(FakeTransport(), offline=True).get(
        "https://api.kartverket.no/r").from_cache


@pytest.mark.parametrize("url", [
    "https://overpass-api.de/api/interpreter",
    "https://ws.geonorge.no/adresser/v1/sok",
    "https://example.org/",
    "https://api.kartverket.no.evil.example/x",
    "http://api.kartverket.no/adresser/v1/sok",   # https only
])
def test_refuses_hosts_not_on_the_allowlist(make_client, url):
    transport = FakeTransport()
    client = make_client(transport)
    with pytest.raises(HostNotAllowed):
        client.get(url)
    assert transport.calls == []  # not even robots.txt was fetched


def test_robots_fetched_once_before_the_first_request(make_client):
    transport = FakeTransport({("GET", API, "/a"): OK, ("GET", API, "/b"): OK})
    client = make_client(transport)
    client.get("https://api.kartverket.no/a")
    client.get("https://api.kartverket.no/b")
    assert transport.urls() == ["https://api.kartverket.no/robots.txt",
                                "https://api.kartverket.no/a", "https://api.kartverket.no/b"]
    log = client.robots_log()
    assert log == [{"host": API, "status": 404, "policy": "allow-all",
                    "checked_at": log[0]["checked_at"], "from_cache": False}]


def test_user_agent_is_sent_and_cannot_be_overridden(make_client):
    transport = FakeTransport({("GET", API, "/a"): OK})
    make_client(transport).get("https://api.kartverket.no/a", headers={"User-Agent": "x"})
    for call in transport.calls:
        assert call["headers"]["User-Agent"] == USER_AGENT
        assert list(call["headers"]).count("User-Agent") == 1


def test_robots_disallow_refuses(make_client):
    transport = FakeTransport({("GET", API, "/open/x"): OK},
                              robots={API: (200, {}, b"User-agent: *\nDisallow: /closed/\n")})
    client = make_client(transport)
    assert client.get("https://api.kartverket.no/open/x").status == 200
    with pytest.raises(RobotsDisallowed):
        client.get("https://api.kartverket.no/closed/x")
    assert "https://api.kartverket.no/closed/x" not in transport.urls()


def test_robots_group_for_our_token_is_used(make_client):
    text = b"User-agent: *\nDisallow: /\n\nUser-agent: CommonsWorld\nAllow: /\n"
    transport = FakeTransport({("GET", API, "/a"): OK}, robots={API: (200, {}, text)})
    assert make_client(transport).get("https://api.kartverket.no/a").status == 200


@pytest.mark.parametrize("status", [401, 403])
def test_robots_401_403_means_refusal(make_client, status):
    transport = FakeTransport({("GET", API, "/a"): OK}, robots={API: (status, {}, b"")})
    client = make_client(transport)
    with pytest.raises(RobotsDisallowed):
        client.get("https://api.kartverket.no/a")
    assert client.robots_log()[0]["policy"] == "disallow-all"


def test_robots_404_means_allowed(make_client):
    transport = FakeTransport({("GET", API, "/a"): OK}, robots={API: (404, {}, b"")})
    assert make_client(transport).get("https://api.kartverket.no/a").status == 200


def test_robots_5xx_means_refusal_after_retries(make_client, clock):
    transport = FakeTransport({("GET", API, "/a"): OK}, robots={API: (503, {}, b"")})
    client = make_client(transport)
    with pytest.raises(RobotsDisallowed):
        client.get("https://api.kartverket.no/a")
    assert len(transport.urls("/robots.txt")) == 5
    assert clock.sleeps[:4] == [2, 4, 8, 16]


def test_robots_unreachable_means_refusal(make_client):
    def down(method, url, query, headers, body):
        raise TransportError("connection refused")
    transport = FakeTransport({("GET", API, "/a"): OK}, robots={API: down})
    client = make_client(transport)
    with pytest.raises(RobotsDisallowed):
        client.get("https://api.kartverket.no/a")
    assert client.robots_log()[0]["status"] is None


def test_robots_redirect_is_followed_on_allowed_hosts(make_client):
    transport = FakeTransport({("GET", API, "/a"): OK}, robots={
        API: (301, {"Location": "https://api.kartverket.no/moved-robots.txt"}, b"")})
    transport.add(API, "/moved-robots.txt", (200, {}, b"User-agent: *\nDisallow: /a\n"))
    client = make_client(transport)
    with pytest.raises(RobotsDisallowed):
        client.get("https://api.kartverket.no/a")
    assert client.robots_log()[0]["status"] == 200


def test_robots_redirect_to_a_refused_host_disallows_all(make_client):
    transport = FakeTransport({("GET", API, "/a"): OK}, robots={
        API: (302, {"Location": "https://example.org/robots.txt"}, b"")})
    with pytest.raises(RobotsDisallowed):
        make_client(transport).get("https://api.kartverket.no/a")
    assert not any("example.org" in u for u in transport.urls())


def test_robots_redirect_loop_disallows_all(make_client):
    transport = FakeTransport({("GET", API, "/a"): OK}, robots={
        API: (301, {"Location": "/robots.txt"}, b"")})
    with pytest.raises(RobotsDisallowed):
        make_client(transport).get("https://api.kartverket.no/a")
    assert len(transport.urls("/robots.txt")) == 6  # the first fetch and five redirects


def test_redirect_to_a_host_off_the_allowlist_is_refused(make_client):
    transport = FakeTransport({("GET", API, "/a"): (
        302, {"Location": "https://overpass-api.de/api/interpreter"}, b"")})
    with pytest.raises(HostNotAllowed):
        make_client(transport).get("https://api.kartverket.no/a")
    assert not any("overpass" in u for u in transport.urls())


def test_redirect_hop_is_checked_against_its_own_robots(make_client):
    transport = FakeTransport(
        {("GET", API, "/a"): (302, {"Location": "https://hoydedata.no/closed/x"}, b"")},
        robots={"hoydedata.no": (200, {}, b"User-agent: *\nDisallow: /closed/\n")})
    with pytest.raises(RobotsDisallowed):
        make_client(transport).get("https://api.kartverket.no/a")
    assert "https://hoydedata.no/closed/x" not in transport.urls()
    assert "https://hoydedata.no/robots.txt" in transport.urls()


def test_redirect_to_a_forbidden_host_via_403_robots(make_client):
    transport = FakeTransport(
        {("GET", API, "/a"): (302, {"Location": "https://wfs.geonorge.no/x"}, b"")},
        robots={"wfs.geonorge.no": (403, {}, b"")})
    with pytest.raises(RobotsDisallowed):
        make_client(transport).get("https://api.kartverket.no/a")


def test_redirect_followed_and_cached_under_the_original_url(make_client, tmp_path):
    transport = FakeTransport({
        ("GET", API, "/old"): (301, {"Location": "/new"}, b""),
        ("GET", API, "/new"): OK})
    client = make_client(transport)
    resp = client.get("https://api.kartverket.no/old")
    assert resp.status == 200 and resp.url == "https://api.kartverket.no/new"
    again = make_client(FakeTransport(), offline=True).get("https://api.kartverket.no/old")
    assert again.from_cache and again.json() == {"ok": True}


def test_too_many_redirects(make_client):
    transport = FakeTransport({("GET", API, "/loop"): (302, {"Location": "/loop"}, b"")})
    with pytest.raises(TooManyRedirects):
        make_client(transport).get("https://api.kartverket.no/loop")


def test_cache_hit_makes_no_request(make_client):
    transport = FakeTransport({("GET", API, "/a"): OK})
    client = make_client(transport)
    first = client.get("https://api.kartverket.no/a", params={"b": 2, "a": 1})
    count = len(transport.calls)
    second = client.get("https://api.kartverket.no/a", params={"a": 1, "b": 2})
    assert len(transport.calls) == count
    assert not first.from_cache and second.from_cache
    assert second.content == first.content and second.status == 200


def test_cache_is_keyed_on_body(make_client):
    seen = []

    def echo(method, url, query, headers, body):
        seen.append(body)
        return 200, {}, body
    transport = FakeTransport()
    transport.add(API, "/p", echo, method="POST")
    client = make_client(transport)
    assert client.post("https://api.kartverket.no/p", json={"x": 1}).content == b'{"x":1}'
    assert client.post("https://api.kartverket.no/p", json={"x": 2}).content == b'{"x":2}'
    assert client.post("https://api.kartverket.no/p", json={"x": 1}).from_cache
    assert len(seen) == 2


def test_errors_are_not_cached(make_client):
    transport = FakeTransport({("GET", API, "/missing"): (404, {}, b"no")})
    client = make_client(transport)
    assert client.get("https://api.kartverket.no/missing").status == 404
    with pytest.raises(OfflineCacheMiss):
        make_client(FakeTransport(), offline=True).get("https://api.kartverket.no/missing")


def test_cache_check_can_veto(make_client):
    transport = FakeTransport({("GET", API, "/a"): (200, {}, b'{"error": 1}')})
    client = make_client(transport)
    client.get("https://api.kartverket.no/a", cache_check=lambda r: b"error" not in r.content)
    with pytest.raises(OfflineCacheMiss):
        make_client(FakeTransport(), offline=True).get("https://api.kartverket.no/a")


def test_damaged_cache_entry_is_a_miss(make_client, tmp_path):
    transport = FakeTransport({("GET", API, "/a"): OK})
    make_client(transport).get("https://api.kartverket.no/a")
    for body in (tmp_path / "cache").rglob("*.bin"):
        body.write_bytes(b"tampered")
    with pytest.raises(OfflineCacheMiss):
        make_client(FakeTransport(), offline=True).get("https://api.kartverket.no/a")


def test_offline_miss_raises_without_network(make_client):
    transport = FakeTransport()
    with pytest.raises(OfflineCacheMiss):
        make_client(transport, offline=True).get("https://api.kartverket.no/a")
    assert transport.calls == []


def test_offline_hit_reports_cached_robots(make_client):
    make_client(FakeTransport({("GET", API, "/a"): OK})).get("https://api.kartverket.no/a")
    offline = make_client(FakeTransport(), offline=True)
    assert offline.get("https://api.kartverket.no/a").from_cache
    log = offline.robots_log()
    assert [(r["host"], r["policy"], r["from_cache"]) for r in log] == [
        (API, "allow-all", True)]
    assert offline.requests_made == 0


def test_offline_still_refuses_unlisted_hosts(make_client):
    with pytest.raises(HostNotAllowed):
        make_client(FakeTransport(), offline=True).get("https://overpass-api.de/api/x")


def test_retry_after_is_honoured(make_client, clock):
    replies = [(429, {"Retry-After": "7"}, b""), (503, {}, b""), OK]

    def flaky(method, url, query, headers, body):
        return replies.pop(0)
    transport = FakeTransport({("GET", API, "/a"): flaky})
    resp = make_client(transport, min_interval=0.0).get("https://api.kartverket.no/a")
    assert resp.status == 200
    assert clock.sleeps == [7, 4]  # max(2, Retry-After 7), then the 4 s back-off


def test_retry_after_longer_than_the_cap_gives_up(make_client, clock):
    transport = FakeTransport({("GET", API, "/a"): (429, {"Retry-After": "120"}, b"")})
    resp = make_client(transport, min_interval=0.0).get("https://api.kartverket.no/a")
    assert resp.status == 429
    assert len(transport.urls("/a")) == 1
    assert 120 not in clock.sleeps


def test_retries_stop_after_four(make_client, clock):
    transport = FakeTransport({("GET", API, "/a"): (500, {}, b"")})
    resp = make_client(transport, min_interval=0.0).get("https://api.kartverket.no/a")
    assert resp.status == 500
    assert len(transport.urls("/a")) == 5
    assert clock.sleeps == [2, 4, 8, 16]
    with pytest.raises(cw_http.HTTPError):
        resp.raise_for_status()


def test_transport_errors_are_retried_then_raised(make_client, clock):
    def down(method, url, query, headers, body):
        raise TransportError("timeout")
    transport = FakeTransport({("GET", API, "/a"): down})
    with pytest.raises(TransportError):
        make_client(transport).get("https://api.kartverket.no/a")
    assert len(transport.urls("/a")) == 5


def test_min_interval_between_requests_to_one_host(make_client, clock):
    transport = FakeTransport({("GET", API, "/a"): OK, ("GET", API, "/b"): OK,
                               ("GET", API, "/d"): OK, ("GET", "hoydedata.no", "/c"): OK})
    client = make_client(transport, min_interval=1.0)
    client.get("https://api.kartverket.no/a")   # robots.txt, then /a after a 1 s wait
    client.get("https://hoydedata.no/c")        # its own robots.txt, then a 1 s wait
    client.get("https://api.kartverket.no/b")   # 1 s has passed since /a: no wait
    client.get("https://api.kartverket.no/d")   # straight after /b: a 1 s wait
    assert clock.sleeps == [1.0, 1.0, 1.0]


def test_min_interval_not_needed_when_time_has_passed(make_client, clock):
    transport = FakeTransport({("GET", API, "/a"): OK, ("GET", API, "/b"): OK})
    client = make_client(transport, min_interval=1.0)
    client.get("https://api.kartverket.no/a")
    clock.t += 5
    client.get("https://api.kartverket.no/b")
    assert clock.sleeps == [1.0]


def test_canonical_url_sorts_and_merges_params():
    url = canonical_url("https://API.kartverket.no/x?z=1", {"b": "2", "a": True, "n": None})
    assert url == "https://api.kartverket.no/x?a=true&b=2&z=1"
    assert canonical_url("https://h/x", {"bbox": "1,2,3,4", "sok": "a b"}) == \
        "https://h/x?bbox=1,2,3,4&sok=a%20b"


def test_cache_key_depends_on_method_url_and_body():
    keys = {cache_key("GET", "https://h/x"), cache_key("POST", "https://h/x"),
            cache_key("POST", "https://h/x", b"1"), cache_key("GET", "https://h/y")}
    assert len(keys) == 4


def test_parse_retry_after():
    assert parse_retry_after("12") == 12
    assert parse_retry_after(None) is None
    assert parse_retry_after("soon") is None
    from datetime import datetime, timezone
    now = datetime(2026, 1, 1, 0, 0, 0, tzinfo=timezone.utc)
    assert parse_retry_after("Thu, 01 Jan 2026 00:00:30 GMT", now=now) == 30


def test_cached_metadata_is_ascii_json(make_client, tmp_path):
    make_client(FakeTransport({("GET", API, "/a"): OK})).get("https://api.kartverket.no/a")
    metas = list((tmp_path / "cache").rglob("*.json"))
    assert len(metas) == 1
    meta = json.loads(metas[0].read_bytes().decode("ascii"))
    assert meta["status"] == 200 and meta["robots"][0]["host"] == API


def test_default_transport_is_blocked_in_tests(tmp_path):
    with pytest.raises(AssertionError, match="network"):
        Client(tmp_path).get("https://api.kartverket.no/a")
