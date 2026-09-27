"""Observations supplied with one build: a private, per-world input.

    python -m commons_world build --listing PATH --observed OBSERVED.json

Some things about a place are known only from a source the pipeline may not
fetch, such as an aerial photo print the owner supplied. They are given to one
build as a small JSON file, kept beside the listing in world/out/_inputs/
(gitignored), never in the repository:

    {"version": 1,
     "house_roof_colour": "#rrggbb",
     "source": "how the colour was read (free text)",
     "credit": "the credit line, shown on screen with the others"}

Every key is required and no other key is allowed. The colour is written into
the listing house's entry in buildings.json (`roof_colour`, with the source
text as `roof_colour_source`), and the credit line into the manifest's credits
and NOTICE.txt, only when the file is given and the house was identified.
Without the file nothing changes. Nothing is looked up or fetched.
"""

import json
import re
from pathlib import Path

VERSION = 1
KEYS = ("version", "house_roof_colour", "source", "credit")
MAX_BYTES = 16384
MAX_SOURCE = 1000
MAX_CREDIT = 300
COLOUR = re.compile(r"#[0-9a-fA-F]{6}")


class ObservedInvalid(ValueError):
    """The observed-input file is not what this module reads."""


def _no_duplicates(pairs):
    keys = [k for k, _ in pairs]
    dupes = sorted({k for k in keys if keys.count(k) > 1})
    if dupes:
        raise ObservedInvalid("the observed input repeats the key(s) {}".format(", ".join(dupes)))
    return dict(pairs)


def _text(obj, key, limit):
    value = obj[key]
    if not isinstance(value, str) or not value.strip():
        raise ObservedInvalid("observed input: {} must be non-empty text".format(key))
    if len(value) > limit:
        raise ObservedInvalid("observed input: {} is longer than {} characters".format(key, limit))
    if not value.isprintable():
        raise ObservedInvalid("observed input: {} holds a control character (a line break, "
                              "tab or similar)".format(key))
    if value != value.strip():
        raise ObservedInvalid("observed input: {} starts or ends with a space".format(key))
    return value


def validate(obj):
    """The observed input as the build uses it (the colour in lower case), or ObservedInvalid."""
    if not isinstance(obj, dict):
        raise ObservedInvalid("the observed input must be a JSON object")
    missing = [k for k in KEYS if k not in obj]
    unknown = sorted(k for k in obj if k not in KEYS)
    if missing:
        raise ObservedInvalid("observed input: missing {}".format(", ".join(missing)))
    if unknown:
        raise ObservedInvalid("observed input: unknown key(s) {}".format(", ".join(unknown)))
    version = obj["version"]
    if type(version) is not int or version != VERSION:
        raise ObservedInvalid("observed input: version {!r} is not supported (only {})".format(
            version, VERSION))
    colour = obj["house_roof_colour"]
    if not isinstance(colour, str) or not COLOUR.fullmatch(colour):
        raise ObservedInvalid("observed input: house_roof_colour {!r} is not a colour written "
                              "#rrggbb".format(colour))
    return {"version": VERSION, "house_roof_colour": colour.lower(),
            "source": _text(obj, "source", MAX_SOURCE), "credit": _text(obj, "credit", MAX_CREDIT)}


def load_observed(path):
    """Read and validate an observed-input file; raise ObservedInvalid if it will not do."""
    path = Path(path)
    try:
        data = path.read_bytes()
    except OSError as exc:
        raise ObservedInvalid("cannot read the observed input {}: {}".format(path, exc)) from exc
    if len(data) > MAX_BYTES:
        raise ObservedInvalid("the observed input {} is larger than {} bytes".format(
            path, MAX_BYTES))
    try:
        obj = json.loads(data.decode("utf-8"), object_pairs_hook=_no_duplicates)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ObservedInvalid("the observed input {} is not UTF-8 JSON: {}".format(path, exc)
                              ) from exc
    return validate(obj)


def apply(ctx, record, stats):
    """Put ctx.observed (if any) into the buildings.json `record` and the credits.

    The listing house gets `roof_colour` and `roof_colour_source`, and the credit line
    is added. With no house, nothing is written, and the build says so in its warnings.
    `stats` (manifest stats.map.buildings) records whether the colour was used."""
    observed = getattr(ctx, "observed", None)
    if observed is None:
        return
    house = next((f for f in record["features"] if f.get("house")), None)
    stats["observed_roof_colour"] = house is not None
    if house is None:
        ctx.warnings.append("The observed house roof colour was not used: no listing house "
                            "was identified.")
        return
    house["roof_colour"] = observed["house_roof_colour"]
    house["roof_colour_source"] = observed["source"]
    ctx.add_credit(observed["credit"])


def check_feature(feature):
    """Problems with a buildings.json feature's observed keys (for manifest.check_world)."""
    keys = [k for k in ("roof_colour", "roof_colour_source") if k in feature]
    if not keys:
        return []
    problems = []
    if len(keys) != 2:
        problems.append("roof_colour and roof_colour_source must be given together")
    if feature.get("house") is not True:
        problems.append("only the listing house may carry an observed roof colour")
    colour = feature.get("roof_colour")
    if "roof_colour" in feature and not (isinstance(colour, str) and COLOUR.fullmatch(colour)
                                         and colour == colour.lower()):
        problems.append("roof_colour {!r} is not a colour written #rrggbb in lower case".format(
            colour))
    source = feature.get("roof_colour_source")
    if "roof_colour_source" in feature and not (isinstance(source, str) and source.strip()):
        problems.append("roof_colour_source must be non-empty text")
    return problems
