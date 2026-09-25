"""Commons World pipeline: builds an explorable world folder around one listing.

See world/FORMAT.md for the files it writes and world/pipeline/SOURCES.md for
where it may fetch from.

PROJ can download transformation grids from its CDN on demand. The pipeline
never lets it: every request goes through commons_world.http.Client, and the
transforms it uses need no grid. PROJ's network access is off by default; it is
switched off here as well, explicitly, so a changed environment variable or
proj.ini cannot turn it on.
"""

__version__ = "0.1.0"


def _proj_network_off():
    try:
        import pyproj.network
    except ImportError:  # pragma: no cover - pyproj is a pinned requirement
        return
    pyproj.network.set_network_enabled(False)


_proj_network_off()
