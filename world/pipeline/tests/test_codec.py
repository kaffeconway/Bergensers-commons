"""The CWH1 chunk codec."""

import gzip
import struct

import numpy as np
import pytest

from commons_world import codec
from commons_world.grid import LEVELS_BY_NAME

H1 = LEVELS_BY_NAME["h1"]
H20 = LEVELS_BY_NAME["h20"]
N = 242
RNG = np.random.default_rng(20260925)


def round_trip(heights, level=H1, i=5, j=-7, epsg=25832, classes=None):
    payload = codec.encode_payload(heights, level, i, j, epsg, classes=classes)
    decoded = codec.decode(codec.gzip_deterministic(payload))
    expected_dm = np.floor(np.asarray(heights, dtype=np.float64) * 10 + 0.5).astype(np.int64)
    assert np.array_equal(decoded["heights_dm"], expected_dm)
    assert np.max(np.abs(decoded["heights_dm"] / 10.0 - heights)) <= 0.05 + 1e-9
    assert decoded["heights_m"].dtype == np.float32
    assert np.allclose(decoded["heights_m"], expected_dm / 10.0, atol=1e-4)
    return payload, decoded


@pytest.mark.parametrize("name,heights", [
    ("random", RNG.uniform(0, 600, (N, N))),
    ("flat", np.full((N, N), 12.34)),
    ("zero", np.zeros((N, N))),
    ("steep", np.add.outer(np.arange(N) * -9.7, np.arange(N) * 13.1) + 3000.0),
    ("extreme range", np.where(RNG.random((N, N)) < 0.5, -100.0, 6453.4)),
    ("below zero", RNG.uniform(-50.0, 0.0, (N, N))),
    ("alpine", 4000.0 + RNG.normal(0, 300, (N, N))),
    ("half-way values", np.full((N, N), 0.25) + np.arange(N)[None, :] * 0.1),
])
def test_round_trip(name, heights):
    round_trip(heights)


def test_round_trip_with_class_band():
    heights = RNG.uniform(0, 100, (N, N))
    classes = RNG.integers(0, 14, (N, N)).astype(np.uint8)
    payload, decoded = round_trip(heights, classes=classes)
    assert np.array_equal(decoded["classes"], classes)
    assert decoded["flags"] & codec.FLAG_CLASSES
    assert len(payload) == 32 + 2 * N * N + N * N


def test_no_class_band():
    payload, decoded = round_trip(RNG.uniform(0, 10, (N, N)))
    assert decoded["classes"] is None
    assert len(payload) == 32 + 2 * N * N


def test_range_too_large_is_refused():
    heights = np.zeros((N, N))
    heights[0, 0] = 6553.6
    with pytest.raises(ValueError, match="6553.5"):
        codec.encode_payload(heights, H1, 0, 0, 25832)
    heights[0, 0] = 6553.5
    round_trip(heights)


@pytest.mark.parametrize("bad", [np.nan, np.inf])
def test_nodata_must_be_filled_first(bad):
    heights = np.zeros((N, N))
    heights[3, 3] = bad
    with pytest.raises(ValueError):
        codec.encode_payload(heights, H1, 0, 0, 25832)


def test_wrong_shape_is_refused():
    with pytest.raises(ValueError):
        codec.encode_payload(np.zeros((240, 240)), H1, 0, 0, 25832)


def test_header_is_byte_exact():
    heights = np.full((N, N), 20.0)
    heights[10, 10] = 17.3   # the minimum sets the base
    i, j = 1198, 27948
    payload = codec.encode_payload(heights, H20, i, j, 25832,
                                   classes=np.zeros((N, N), dtype=np.uint8))
    assert payload[0:4] == b"CWH1"
    assert payload[4] == 1
    assert payload[5] == 0b111  # planar, apron, class band
    assert struct.unpack_from("<H", payload, 6)[0] == 242
    assert struct.unpack_from("<H", payload, 8)[0] == 242
    assert struct.unpack_from("<H", payload, 10)[0] == 2000
    assert struct.unpack_from("<i", payload, 12)[0] == (i * 4800 - 20) * 10
    assert struct.unpack_from("<i", payload, 16)[0] == ((j + 1) * 4800 + 20) * 10
    assert struct.unpack_from("<i", payload, 20)[0] == 173
    assert struct.unpack_from("<I", payload, 24)[0] == 25832
    assert struct.unpack_from("<I", payload, 28)[0] == 0
    assert codec.HEADER_SIZE == 32
    decoded = codec.decode(payload)
    assert decoded["corner_e"] == i * 4800 - 20 and decoded["corner_n"] == (j + 1) * 4800 + 20
    assert decoded["base_dm"] == 173 and decoded["cell"] == 20.0 and decoded["epsg"] == 25832


def test_planar_predictor_matches_format_md_definition():
    """Check residuals against the formula written out cell by cell."""
    v = RNG.integers(0, 65536, (7, 9)).astype(np.int64)
    s = codec.planar_residuals(v)
    for r in range(7):
        for q in range(9):
            left = v[r, q - 1] if q else 0
            up = v[r - 1, q] if r else 0
            upleft = v[r - 1, q - 1] if r and q else 0
            assert s[r, q] == (v[r, q] - (left + up - upleft)) % 65536
    assert np.array_equal(codec.planar_restore(s), v)


def test_heights_band_is_little_endian_u16():
    heights = np.zeros((N, N))
    heights[0, 0] = 0.1
    heights[0, 1] = 0.3
    payload = codec.encode_payload(heights, H1, 0, 0, 25832)
    # base 0: v(0,0) = 1, v(0,1) = 3, predicted from its left neighbour: s = 2.
    assert payload[32:36] == b"\x01\x00\x02\x00"


def test_gzip_is_deterministic_and_standard():
    payload = codec.encode_payload(RNG.uniform(0, 50, (N, N)), H1, 0, 0, 25832)
    a = codec.gzip_deterministic(payload)
    b = codec.gzip_deterministic(bytes(payload))
    assert a == b
    assert a[:10] == b"\x1f\x8b\x08\x00\x00\x00\x00\x00\x02\xff"  # no name, mtime 0
    assert gzip.decompress(a) == payload


def test_same_input_same_bytes():
    heights = RNG.uniform(0, 300, (N, N))
    first = codec.encode_payload(heights, H1, 3, 4, 25832)
    second = codec.encode_payload(heights.copy(), H1, 3, 4, 25832)
    assert first == second
    assert codec.hash8(first) == codec.hash8(second)
    assert len(codec.hash8(first)) == 8
    assert codec.chunk_path("h1", 3, 4, first) == "h1/3_4.{}.cwh.gz".format(codec.hash8(first))


def test_decode_accepts_raw_and_gzip_and_rejects_junk():
    payload = codec.encode_payload(np.ones((N, N)), H1, 0, 0, 25832)
    assert np.array_equal(codec.decode(payload)["heights_dm"],
                          codec.decode(codec.gzip_deterministic(payload))["heights_dm"])
    with pytest.raises(ValueError):
        codec.decode(b"XXXX" + payload[4:])
    with pytest.raises(ValueError):
        codec.decode(payload[:-2])
    bad_version = bytearray(payload)
    bad_version[4] = 2
    with pytest.raises(ValueError, match="version"):
        codec.decode(bytes(bad_version))


def test_half_way_rounding_is_upward_also_below_zero():
    """floor(h * 10 + 0.5): halves go up, so -0.25 m is -2 dm and -0.05 m is 0 dm (sea)."""
    from commons_world.classes import sea_mask

    heights = np.array([-0.25, -0.05, 0.05, -0.35, -0.26, 0.04, 1.25])
    assert codec.height_dm(heights).tolist() == [-2, 0, 1, -3, -3, 0, 13]
    assert sea_mask(heights).tolist() == [True, True, False, True, True, True, False]
