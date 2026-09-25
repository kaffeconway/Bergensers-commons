"""The CWH1 height chunk format of world/FORMAT.md section 3.

A payload is a 32-byte little-endian header, a band of u16 heights (planar
predictor applied) and, optionally, a band of u8 land-cover classes. On disk it
is gzipped deterministically and named by the first 8 hex digits of the sha256
of the uncompressed payload.
"""

import gzip
import hashlib
import struct
import zlib

import numpy as np

MAGIC = b"CWH1"
VERSION = 1
HEADER = struct.Struct("<4sBBHHHiiiII")
HEADER_SIZE = HEADER.size  # 32

FLAG_PLANAR = 1
FLAG_APRON = 2
FLAG_CLASSES = 4

_GZIP_MAGIC = b"\x1f\x8b"


def height_dm(heights_m):
    """Heights in metres to whole decimetres, floor(h * 10 + 0.5), as int64."""
    return np.floor(np.asarray(heights_m, dtype=np.float64) * 10.0 + 0.5).astype(np.int64)


def planar_residuals(v):
    """Planar predictor: s = v - (left + up - upleft), mod 65536, zero outside."""
    v = np.asarray(v, dtype=np.int64)
    padded = np.zeros((v.shape[0] + 1, v.shape[1] + 1), dtype=np.int64)
    padded[1:, 1:] = v
    pred = padded[1:, :-1] + padded[:-1, 1:] - padded[:-1, :-1]
    return ((v - pred) & 0xFFFF).astype(np.uint16)


def planar_restore(s):
    """Invert planar_residuals: a running sum down the rows and along them, mod 65536.

    The residual is the mixed second difference of v with zeros outside the
    array, so v is the two-dimensional prefix sum of the residuals.
    """
    s = np.asarray(s, dtype=np.int64)
    return (np.cumsum(np.cumsum(s, axis=0), axis=1) & 0xFFFF).astype(np.int64)


def encode_payload(heights_m, level, i, j, epsg, classes=None, planar=True):
    """Build the uncompressed CWH1 payload for chunk (i, j) of `level`.

    `heights_m` is a (242, 242) array in metres, rows north to south. NaN is
    refused: nodata must be filled (with 0 m) before encoding.
    """
    h = np.asarray(heights_m, dtype=np.float64)
    n = level.stored
    if h.shape != (n, n):
        raise ValueError("heights must be {0} x {0}, got {1}".format(n, h.shape))
    if not np.all(np.isfinite(h)):
        raise ValueError("heights contain NaN or infinity; fill nodata before encoding")
    dm = height_dm(h)
    base = int(dm.min())
    v = dm - base
    if int(v.max()) > 0xFFFF:
        raise ValueError("height range {:.1f} m exceeds the 6553.5 m a chunk can hold"
                         .format(int(v.max()) / 10.0))
    flags = FLAG_APRON if level.apron == 1 else 0
    band = planar_residuals(v) if planar else v.astype(np.uint16)
    if planar:
        flags |= FLAG_PLANAR
    class_bytes = b""
    if classes is not None:
        cls = np.asarray(classes)
        if cls.shape != (n, n):
            raise ValueError("classes must be {0} x {0}, got {1}".format(n, cls.shape))
        if cls.min() < 0 or cls.max() > 255:
            raise ValueError("class codes must fit in u8")
        class_bytes = cls.astype(np.uint8).tobytes()
        flags |= FLAG_CLASSES
    s, pad = level.side, level.apron * level.cell
    header = HEADER.pack(MAGIC, VERSION, flags, n, n, level.cell_cm,
                         int(round((i * s - pad) * 10)), int(round(((j + 1) * s + pad) * 10)),
                         base, int(epsg), 0)
    return header + band.astype("<u2").tobytes() + class_bytes


def gzip_deterministic(payload):
    """gzip at level 9 with mtime 0, no file name, XFL 2 and OS 255.

    The header is written by hand so the bytes do not depend on the platform
    Python runs on; only the deflate stream comes from zlib.
    """
    compressor = zlib.compressobj(9, zlib.DEFLATED, -15, 9, zlib.Z_DEFAULT_STRATEGY)
    body = compressor.compress(payload) + compressor.flush()
    header = b"\x1f\x8b\x08\x00" + b"\x00\x00\x00\x00" + b"\x02\xff"
    trailer = struct.pack("<II", zlib.crc32(payload) & 0xFFFFFFFF, len(payload) & 0xFFFFFFFF)
    return header + body + trailer


def hash8(payload):
    """First 8 hex digits of the sha256 of the uncompressed payload."""
    return hashlib.sha256(payload).hexdigest()[:8]


def chunk_path(level_name, i, j, payload):
    """The file name FORMAT.md gives a chunk: <level>/<i>_<j>.<hash8>.cwh.gz."""
    return "{}/{}_{}.{}.cwh.gz".format(level_name, i, j, hash8(payload))


def decode(data):
    """Decode a CWH1 payload, gzipped or not.

    Returns a dict of the header fields plus `heights_m` (float32, rows north to
    south), `heights_dm` (int64) and `classes` (uint8 array, or None).
    """
    data = bytes(data)
    if data[:2] == _GZIP_MAGIC:
        data = gzip.decompress(data)
    if len(data) < HEADER_SIZE:
        raise ValueError("too short for a CWH1 header")
    (magic, version, flags, width, height, cell_cm, e_dm, n_dm, base, epsg,
     reserved) = HEADER.unpack_from(data, 0)
    if magic != MAGIC:
        raise ValueError("not a CWH1 chunk (magic {!r})".format(magic))
    if version != VERSION:
        raise ValueError("CWH1 version {} is not supported".format(version))
    count = width * height
    has_classes = bool(flags & FLAG_CLASSES)
    expected = HEADER_SIZE + 2 * count + (count if has_classes else 0)
    if len(data) != expected:
        raise ValueError("CWH1 payload is {} bytes, expected {}".format(len(data), expected))
    band = np.frombuffer(data, dtype="<u2", count=count, offset=HEADER_SIZE)
    band = band.reshape(height, width).astype(np.int64)
    v = planar_restore(band) if flags & FLAG_PLANAR else band
    dm = base + v
    classes = None
    if has_classes:
        classes = np.frombuffer(data, dtype=np.uint8, count=count,
                                offset=HEADER_SIZE + 2 * count).reshape(height, width).copy()
    return {
        "magic": magic.decode("ascii"), "version": version, "flags": flags,
        "planar": bool(flags & FLAG_PLANAR), "apron": bool(flags & FLAG_APRON),
        "width": width, "height": height, "cell_cm": cell_cm, "cell": cell_cm / 100.0,
        "corner_e_dm": e_dm, "corner_n_dm": n_dm,
        "corner_e": e_dm / 10.0, "corner_n": n_dm / 10.0,
        "base_dm": base, "epsg": epsg, "reserved": reserved,
        "heights_dm": dm, "heights_m": (dm / 10.0).astype(np.float32), "classes": classes,
    }
