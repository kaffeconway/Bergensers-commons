"""robots.txt parsing (RFC 9309) and the pipeline's status policy.

The files in fixtures/robots/ are the robots.txt texts those hosts served on
25 Sept 2026, saved verbatim.
"""

import pytest

from commons_world import robots
from commons_world.robots import RobotsFile, normalise, policy_for_status

from conftest import FIXTURES

TOKEN = "CommonsWorld"

RFC_SIMPLE = """\
User-Agent: *
Disallow: *.gif$
Disallow: /example/
Allow: /publications/

User-Agent: foobot
Disallow:/
Allow:/example/page.html
Allow:/example/allowed.gif

User-Agent: barbot
User-Agent: bazbot
Disallow: /example/page.html

User-Agent: quxbot
"""


def fixture_text(host):
    return (FIXTURES / "robots" / (host + ".txt")).read_bytes()


# -- RFC 9309 section 5.1, the simple example --------------------------------

@pytest.mark.parametrize("agent,path,allowed", [
    ("anybot", "/example/page.html", False),
    ("anybot", "/publications/", True),
    ("anybot", "/images/cat.gif", False),
    ("anybot", "/images/cat.gif?size=2", True),   # $ anchors at the end
    ("anybot", "/", True),
    ("foobot", "/example/page.html", True),
    ("foobot", "/example/allowed.gif", True),
    ("foobot", "/example/other.html", False),
    ("foobot", "/", False),
    ("barbot", "/example/page.html", False),
    ("bazbot", "/example/page.html", False),
    ("barbot", "/example/other.html", True),      # the * group does not apply to barbot
    ("barbot", "/images/cat.gif", True),
    ("quxbot", "/example/page.html", True),       # an empty group allows everything
    ("FOOBOT", "/example/other.html", False),     # product tokens match case-insensitively
])
def test_rfc_simple_example(agent, path, allowed):
    assert RobotsFile.parse(RFC_SIMPLE).allowed(path, agent) is allowed


def test_rfc_longest_match():
    text = "User-Agent: foobot\nAllow: /example/page/\nDisallow: /example/page/disallowed.gif\n"
    parsed = RobotsFile.parse(text)
    assert parsed.allowed("/example/page/", "foobot")
    assert parsed.allowed("/example/page/other.html", "foobot")
    assert not parsed.allowed("/example/page/disallowed.gif", "foobot")


def test_allow_wins_a_tie():
    parsed = RobotsFile.parse("User-agent: *\nDisallow: /page\nAllow: /page\n")
    assert parsed.allowed("/page", TOKEN)
    parsed = RobotsFile.parse("User-agent: *\nAllow: /page\nDisallow: /page\n")
    assert parsed.allowed("/page", TOKEN)


def test_wildcards():
    parsed = RobotsFile.parse(
        "User-agent: *\nDisallow: /this/*/exactly\nDisallow: /end/exactly$\nDisallow: /fish*\n")
    assert not parsed.allowed("/this/one/exactly", TOKEN)
    assert not parsed.allowed("/this/a/b/exactly/more", TOKEN)
    assert parsed.allowed("/this/exactly", TOKEN)
    assert not parsed.allowed("/end/exactly", TOKEN)
    assert parsed.allowed("/end/exactly/not", TOKEN)
    assert not parsed.allowed("/fish.html", TOKEN)
    assert not parsed.allowed("/fish", TOKEN)
    assert parsed.allowed("/Fish", TOKEN)  # paths are case-sensitive


def test_dollar_inside_a_pattern_is_literal():
    parsed = RobotsFile.parse("User-agent: *\nDisallow: /a$b\n")
    assert not parsed.allowed("/a$b/c", TOKEN)
    assert parsed.allowed("/a", TOKEN)


def test_product_token_matching():
    text = "User-agent: CommonsWorld/0.1\nDisallow: /private/\n\nUser-agent: *\nDisallow: /\n"
    parsed = RobotsFile.parse(text)
    assert parsed.allowed("/public", TOKEN)
    assert not parsed.allowed("/private/x", TOKEN)
    assert not parsed.allowed("/public", "otherbot")
    # A longer token is a different crawler.
    parsed = RobotsFile.parse("User-agent: CommonsWorldBot\nDisallow: /\n")
    assert parsed.allowed("/anything", TOKEN)


def test_groups_for_the_same_agent_are_combined():
    text = "User-agent: *\nDisallow: /a\n\nUser-agent: *\nDisallow: /b\n"
    parsed = RobotsFile.parse(text)
    assert not parsed.allowed("/a", TOKEN) and not parsed.allowed("/b", TOKEN)
    assert parsed.allowed("/c", TOKEN)


def test_comments_blank_lines_unknown_records_and_crlf():
    text = ("# comment\r\nUser-agent: *   # the rest\r\nSitemap: https://x/s.xml\r\n"
            "Crawl-delay: 5\r\nDisallow: /x # trailing\r\n")
    parsed = RobotsFile.parse(text)
    assert not parsed.allowed("/x/y", TOKEN)
    assert parsed.allowed("/y", TOKEN)


def test_rules_before_any_user_agent_are_ignored():
    assert RobotsFile.parse("Disallow: /\n").allowed("/anything", TOKEN)


def test_empty_disallow_allows_everything():
    assert RobotsFile.parse("User-agent: *\nDisallow:\n").allowed("/anything", TOKEN)


def test_robots_txt_itself_is_always_allowed():
    assert RobotsFile.parse("User-agent: *\nDisallow: /\n").allowed("/robots.txt", TOKEN)


def test_byte_order_mark_is_ignored():
    assert not RobotsFile.parse(b"\xef\xbb\xbfUser-agent: *\nDisallow: /\n").allowed("/a", TOKEN)


# -- percent-encoding (RFC 9309 s2.2.2) --------------------------------------

@pytest.mark.parametrize("raw,expected", [
    ("/foo/bar?baz=quz", "/foo/bar?baz=quz"),
    ("/foo/bar/\u30c4", "/foo/bar/%E3%83%84"),
    ("/foo/bar/%E3%83%84", "/foo/bar/%E3%83%84"),
    ("/foo/bar/%e3%83%84", "/foo/bar/%E3%83%84"),
    ("/foo/bar/%62%61%7A", "/foo/bar/baz"),
    ("/a%2Fb", "/a%2Fb"),          # a reserved character stays escaped
    ("/a b", "/a%20b"),
    ("/100%", "/100%25"),
])
def test_normalise(raw, expected):
    assert normalise(raw) == expected


def test_encoded_and_unencoded_forms_match_each_other():
    parsed = RobotsFile.parse("User-agent: *\nDisallow: /foo/bar/%62%61%7A\nDisallow: /\u30c4\n")
    assert not parsed.allowed("/foo/bar/baz", TOKEN)
    assert not parsed.allowed("/%E3%83%84", TOKEN)
    assert not parsed.allowed("https://example.org/%e3%83%84?q=1", TOKEN)


# -- the real files ----------------------------------------------------------

def test_overpass_api_is_disallowed():
    parsed = RobotsFile.parse(fixture_text("overpass-api.de"))
    assert not parsed.allowed("/api/interpreter", TOKEN)
    assert not parsed.allowed("https://overpass-api.de/api/interpreter?data=x", TOKEN)


def test_pvgis_is_disallowed():
    parsed = RobotsFile.parse(fixture_text("re.jrc.ec.europa.eu"))
    assert not parsed.allowed("/api/v5_3/printhorizon?lat=0&lon=0", TOKEN)
    assert not parsed.allowed("/", TOKEN)


def test_met_no_allows_us_but_not_googlebot():
    parsed = RobotsFile.parse(fixture_text("api.met.no"))
    assert parsed.allowed("/weatherapi/sunrise/3.0/sun", TOKEN)
    assert not parsed.allowed("/weatherapi/sunrise/3.0/sun", "Googlebot")
    assert parsed.allowed("/weatherapi/documentation", "Googlebot")


def test_openstreetmap_fr_extracts_are_disallowed():
    parsed = RobotsFile.parse(fixture_text("download.openstreetmap.fr"))
    assert not parsed.allowed("/extracts/x.osm.pbf", TOKEN)
    assert parsed.allowed("/extracts/x.osm.pbf.md5", TOKEN)
    assert not parsed.allowed("/replication/day/state.txt", TOKEN)  # the second * group


def test_planet_osm_allows_only_wget():
    parsed = RobotsFile.parse(fixture_text("planet.openstreetmap.org"))
    assert not parsed.allowed("/planet/planet-latest.osm.bz2", TOKEN)
    assert parsed.allowed("/planet/planet-latest.osm.bz2", "wget")


def test_open_files_allow_everything():
    for host in ("kartkatalog.geonorge.no", "www.kartverket.no"):
        assert RobotsFile.parse(fixture_text(host)).allowed("/any/path?x=1", TOKEN)


# -- status policy (SOURCES.md) ---------------------------------------------

@pytest.mark.parametrize("status,policy", [
    (200, robots.POLICY_PARSED), (204, robots.POLICY_PARSED),
    (401, robots.POLICY_DISALLOW_ALL), (403, robots.POLICY_DISALLOW_ALL),
    (404, robots.POLICY_ALLOW_ALL), (410, robots.POLICY_ALLOW_ALL),
    (500, robots.POLICY_DISALLOW_ALL), (503, robots.POLICY_DISALLOW_ALL),
    (None, robots.POLICY_DISALLOW_ALL), (301, robots.POLICY_DISALLOW_ALL),
])
def test_policy_for_status(status, policy):
    assert policy_for_status(status) == policy


def test_decide_applies_the_policy():
    denied = robots.decide("h", 403, b"User-agent: *\nAllow: /\n", "t", TOKEN)
    assert not denied.allowed("/anything")
    open_ = robots.decide("h", 404, b"User-agent: *\nDisallow: /\n", "t", TOKEN)
    assert open_.allowed("/anything")
    parsed = robots.decide("h", 200, b"User-agent: *\nDisallow: /x\n", "t", TOKEN)
    assert not parsed.allowed("/x") and parsed.allowed("/y")
    assert parsed.record() == {"host": "h", "status": 200, "policy": "parsed", "checked_at": "t"}
