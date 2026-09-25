"""Listing records: schema validation and the leak check."""

import copy
import json

import pytest

from commons_world import listing
from commons_world.listing import LeakError, ListingInvalid, check_listing, leak_check, load_listing
from commons_world.synthetic import synthetic_listing


def with_change(path, value):
    record = copy.deepcopy(synthetic_listing())
    target = record
    for key in path[:-1]:
        target = target[key]
    target[path[-1]] = value
    return record


def test_synthetic_listing_passes(tmp_path):
    path = tmp_path / "listing.json"
    path.write_text(json.dumps(synthetic_listing()), encoding="utf-8")
    assert load_listing(path) == synthetic_listing()


def test_no_schema_field_trips_the_key_check():
    """Every key the schema allows must get past the leak check."""
    schema = listing.load_schema()
    names = []

    def collect(node):
        for name, sub in (node.get("properties") or {}).items():
            names.append(name)
            collect(sub)
    collect(schema)
    assert len(names) > 50
    for name in names:
        assert not any(part in name.lower() for part in listing.PRIVATE_KEY_PARTS), name


@pytest.mark.parametrize("path,value", [
    (("estate_agent",), "Someone, Some Agency"),
    (("status",), "offer"),
    (("costs", "target_monthly_eur"), 275),
    (("costs", "per_person_eur"), 100),
    (("costs", "split_buyin_eur"), {"4": 1}),
    (("costs", "capital_band"), "x"),
    (("costs", "low_cost"), 2.3),
    (("facts", "score_land"), 3),
    (("facts", "notes"), "x"),
    (("people",), 4),
    (("deal_breakers",), "x"),
])
def test_private_keys_are_refused(path, value):
    with pytest.raises(LeakError, match=path[-1]):
        check_listing(with_change(path, value))


@pytest.mark.parametrize("path,value", [
    (("approved_text", "nickname"), "Added from issue #7 by @someone"),
    (("approved_text", "outbuildings"), "barn, see @someone-else"),
    (("approved_text", "use_class"), "helarsbolig (implied, CONFIRM, not stated in listing)"),
    (("approved_text", "municipality"), "Somewhere, REGION OUTLIER"),
    (("approved_text", "services"), "PROVISIONAL score 3"),
    (("approved_text", "parking"), "Ruled out: fails the gate"),
    (("approved_text", "zoning"), "fine unless deal-breaker"),
    (("approved_text", "heating"), "within the target"),
    (("costs", "warnings"), ["about 100 per person"]),
    (("approved_text", "outbuildings"), "ask the estate agent"),
    # per-person money, however it is written
    (("approved_text", "nickname"), "EUR 584/person/month at 4 sharers"),
    (("approved_text", "nickname"), "584/pers at four"),
    (("approved_text", "nickname"), "about 584 pp"),
    (("approved_text", "nickname"), "NOK 1 200 pr. hode"),
    (("approved_text", "nickname"), "EUR 107 each at 4"),
    (("approved_text", "nickname"), "107k EUR each"),
    (("approved_text", "nickname"), "\u20ac107 each"),
    (("approved_text", "nickname"), "each pays about half"),
    (("approved_text", "nickname"), "fine for six sharers"),
    (("facts", "plot_ownership"), "eiet; 584/pp at 4"),
    # hand scores, a viewing time, the group's own position
    (("approved_text", "nickname"), "Remoteness 1, Near a city 5"),
    (("approved_text", "services"), "Condition: 3"),
    (("approved_text", "nickname"), "watching; viewing Mon 14 Sept 17:00"),
    (("approved_text", "parking"), "visning 14.09 kl 17.00"),
    (("approved_text", "parking"), "visning man. 14. sept. kl. 17.00"),
    (("approved_text", "nickname"), "under our budget"),
    (("approved_text", "nickname"), "over our EUR 150 target"),
])
def test_private_text_is_refused(path, value):
    with pytest.raises(LeakError):
        check_listing(with_change(path, value))


@pytest.mark.parametrize("path,value", [
    (("approved_text", "outbuildings"), "Two bathrooms, one on each floor"),
    (("approved_text", "outbuildings"), "Garage, barn, summer house; 2 bathrooms"),
    (("approved_text", "services"), "Land area 3981 m2 stated; mains water"),
    (("approved_text", "nickname"), "The old farm, 2 km from the shop"),
    (("approved_text", "parking"), "Parking for 5 cars"),
    (("facts", "property_type"), "Maison + 2 appartements"),
    (("costs", "warnings"), ["The maintenance reserve is a rule of thumb at 1% of the price "
                             "a year, not a quote."]),
])
def test_ordinary_listing_text_passes(path, value):
    assert leak_check(with_change(path, value)) == []


def test_email_is_not_a_handle():
    record = with_change(("approved_text", "services"), "water; contact post@example.org")
    assert leak_check(record) == []


@pytest.mark.parametrize("path,value", [
    (("colour",), "red"),                                    # unknown key
    (("facts", "asking_price"), "cheap"),                    # wrong type
    (("facts", "bedrooms"), 2.5),
    (("country",), "SE"),
    (("link",), "http://example.org/listing"),               # must be https
    (("costs", "source"), "a spreadsheet"),                  # const
    (("costs", "basis"), "per person"),
    (("schema_version",), 2),
    (("approved_text", "address"), "x" * 201),               # maxLength
    (("id",), "Not An Id"),
])
def test_schema_violations_are_refused(path, value):
    with pytest.raises((ListingInvalid, LeakError)):
        check_listing(with_change(path, value))


def test_missing_required_field():
    record = synthetic_listing()
    del record["facts"]
    with pytest.raises(ListingInvalid, match="facts"):
        check_listing(record)


def test_not_an_object(tmp_path):
    path = tmp_path / "listing.json"
    path.write_text("[1, 2]", encoding="utf-8")
    with pytest.raises(ListingInvalid):
        load_listing(path)


def test_leak_check_runs_before_the_schema():
    """An agent key is reported as a leak, not just as an unknown key."""
    with pytest.raises(LeakError):
        check_listing(with_change(("agent_name",), "x"))
