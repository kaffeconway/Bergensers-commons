"""Load a listing record and refuse anything that should not cross into a world.

The record must validate against world/schema/listing.schema.json, which
names every field that may cross from the private tracker. On top of that, a
defence-in-depth check refuses keys and text that look like group data: scores,
notes, status, targets, per-person money, estate agents, GitHub handles. It
runs first, so its message says what was caught rather than just "unknown key".
"""

import json
import re
from pathlib import Path

from jsonschema import Draft202012Validator

SCHEMA_PATH = Path(__file__).resolve().parents[2] / "schema" / "listing.schema.json"

# A key containing any of these is refused wherever it appears.
PRIVATE_KEY_PARTS = ("people", "target", "per_person", "split", "band", "low_cost",
                     "score", "status", "notes", "agent", "deal")

# Money: a number with a currency beside it, either way round.
_MONEY = (r"(?:(?:\b(?:eur|nok|kr)\b\.?|\u20ac)\s*\d[\d.,]*(?:\s?[km]\b)?"
          r"|\b\d[\d.,]*(?:\s?[km])?\s*(?:\b(?:eur|euros?|nok|kr|kroner)\b|\u20ac))")
# The ten hand-scored axes of the tracker, and Low cost.
_AXES = (r"land\s+area|buildings|remoteness|near\s+a\s+city|easy\s+for\s+everyone"
         r"|somewhere\s+we\s+know|sun\s+(?:&|and)\s+growing\s+climate|condition"
         r"|access\s+(?:&|and)\s+commute|legal\s+(?:&|and)\s+planning|low\s+cost")

# Text that reads as group commentary rather than a listing fact. The private
# tracker's exporter (tools/export_world.py) runs every one of these patterns
# too, and its tests check that it does, so what it passes this check passes.
_PRIVATE_TEXT = (
    (re.compile(r"(?<![\w.@/])@[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?![\w-])"), "a GitHub-style handle"),
    (re.compile(r"\bissue\s*#\d+", re.IGNORECASE), "an issue reference"),
    (re.compile(r"\bPROVISIONAL\b", re.IGNORECASE), "a provisional-score label"),
    (re.compile(r"\bOUTLIER\b", re.IGNORECASE), "an outlier label"),
    (re.compile(r"\bCONFIRM\b"), "an analyst's CONFIRM note"),
    (re.compile(r"\bruled\s+out\b", re.IGNORECASE), "a ruled-out verdict"),
    (re.compile(r"\bdeal[\s-]?breakers?\b", re.IGNORECASE), "a deal-breaker note"),
    (re.compile(r"\bper[\s-]person\b", re.IGNORECASE), "a per-person figure"),
    (re.compile(r"\bpe?r\.?[\s-]*(?:pers|head|hode|capita|sharer)", re.IGNORECASE),
     "a per-person figure"),
    (re.compile(r"/\s*(?:person|pers|pp|head|hode|capita|sharer)", re.IGNORECASE),
     "a per-person figure"),
    (re.compile(r"\d\s*pp\b", re.IGNORECASE), "a per-person figure"),
    (re.compile(r"\bsharers?\b", re.IGNORECASE), "a number of sharers"),
    (re.compile(_MONEY + r"[^.;\n]{0,20}?\beach\b", re.IGNORECASE), "a per-person figure"),
    (re.compile(r"\beach\s+(?:pays?|puts?|contributes?|owes?)\b", re.IGNORECASE),
     "a per-person figure"),
    (re.compile(r"\b(?:" + _AXES + r")\s*[:=]?\s*[0-5](?:[.,]\d+)?(?![\d.,]*\s*(?:m\b|m2|km|%))(?!\d)",
                re.IGNORECASE), "a hand score"),
    (re.compile(r"\b(?:viewing|visning)\b[^;\n]{0,40}?\b\d{1,2}[:.]\d{2}\b", re.IGNORECASE),
     "a viewing time"),
    (re.compile(r"\bour\s+(?:offer|bid|budget)\b", re.IGNORECASE), "the group's own position"),
    (re.compile(r"\btarget\b", re.IGNORECASE), "a group target"),
    (re.compile(r"\bscored?\b", re.IGNORECASE), "a score"),
    (re.compile(r"\b(?:estate\s+)?agent\b|\beiendomsmegler\b", re.IGNORECASE), "an estate agent"),
)


class LeakError(ValueError):
    """The record carries something that looks like private group data."""


class ListingInvalid(ValueError):
    """The record does not validate against the listing schema."""


def load_schema(path=SCHEMA_PATH):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def _walk(value, path=""):
    """Yield (path, key, value) for every dict entry and (path, None, item) for every list item."""
    if isinstance(value, dict):
        for key, item in value.items():
            here = "{}.{}".format(path, key) if path else str(key)
            yield here, key, item
            yield from _walk(item, here)
    elif isinstance(value, list):
        for index, item in enumerate(value):
            here = "{}[{}]".format(path, index)
            yield here, None, item
            yield from _walk(item, here)


def leak_check(record):
    """Every problem found, as human-readable strings (empty when clean)."""
    problems = []
    for path, key, value in _walk(record):
        lowered = str(key).lower() if key is not None else ""
        for part in PRIVATE_KEY_PARTS:
            if part in lowered:
                problems.append("{}: key contains '{}', which is never exported".format(path, part))
                break
        if isinstance(value, str):
            for pattern, what in _PRIVATE_TEXT:
                found = pattern.search(value)
                if found:
                    problems.append("{}: text looks like {} ({!r})".format(path, what, found.group(0)))
    return problems


def validate(record, schema=None):
    """Schema errors as human-readable strings (empty when valid)."""
    validator = Draft202012Validator(schema or load_schema())
    errors = sorted(validator.iter_errors(record), key=lambda e: list(e.absolute_path))
    return ["{}: {}".format(".".join(str(p) for p in e.absolute_path) or "(record)", e.message)
            for e in errors]


def check_listing(record, schema=None):
    """Raise LeakError or ListingInvalid; return the record when it passes both."""
    leaks = leak_check(record)
    if leaks:
        raise LeakError("listing refused, it looks like it carries private data:\n  "
                        + "\n  ".join(leaks))
    errors = validate(record, schema)
    if errors:
        raise ListingInvalid("listing does not match listing.schema.json:\n  "
                             + "\n  ".join(errors))
    return record


def load_listing(path, schema=None):
    """Read, leak-check and validate a listing JSON file; return it as a dict."""
    with open(path, encoding="utf-8") as fh:
        record = json.load(fh)
    if not isinstance(record, dict):
        raise ListingInvalid("a listing must be a JSON object")
    return check_listing(record, schema)
