"""The command line, and rules about the pipeline's own source files."""

import json
import re
from pathlib import Path

from commons_world.__main__ import main
from commons_world.synthetic import synthetic_listing

PIPELINE = Path(__file__).resolve().parents[1]
PACKAGE = PIPELINE / "commons_world"
SKIP_DIRS = {".cache", "__pycache__", ".pytest_cache"}


def own_files():
    """Files this pipeline owns: the package, the tests and their fixtures, pytest.ini."""
    yield PIPELINE / "pytest.ini"
    for root in (PACKAGE, PIPELINE / "tests"):
        for path in sorted(root.rglob("*")):
            if path.is_file() and not SKIP_DIRS & set(path.relative_to(PIPELINE).parts):
                yield path


def test_own_files_are_pure_ascii():
    offenders = []
    for path in own_files():
        try:
            path.read_bytes().decode("ascii")
        except UnicodeDecodeError as exc:
            offenders.append("{}: byte {}".format(path.relative_to(PIPELINE), exc.start))
    assert offenders == []


NETWORK_MODULES = ("requests", "urllib.request", "urllib3", "http.client", "http.server",
                   "socket", "ssl", "httpx", "aiohttp", "ftplib", "smtplib", "xmlrpc",
                   "webbrowser", "pycurl")


def network_imports(source):
    """Every network module `source` imports, however it is written.

    Parses the module, so `import os, requests`, `import requests as r`,
    `from urllib import request`, `from http import client`, imports inside
    functions, `importlib.import_module("requests")` and `__import__("socket")`
    are all seen.
    """
    import ast

    def is_network(name):
        return any(name == m or name.startswith(m + ".") for m in NETWORK_MODULES)

    found = []
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Import):
            found += [a.name for a in node.names if is_network(a.name)]
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            if is_network(node.module):
                found.append(node.module)
            found += ["{}.{}".format(node.module, a.name) for a in node.names
                      if is_network("{}.{}".format(node.module, a.name))]
        elif isinstance(node, ast.Call):
            func = node.func
            name = (func.attr if isinstance(func, ast.Attribute)
                    else func.id if isinstance(func, ast.Name) else "")
            if name in ("import_module", "__import__") and node.args \
                    and isinstance(node.args[0], ast.Constant) \
                    and isinstance(node.args[0].value, str) and is_network(node.args[0].value):
                found.append(node.args[0].value)
    return found


def test_the_import_scan_sees_every_spelling():
    for source in ("import os, requests", "import requests as r", "from urllib import request",
                   "from http import client", "def f():\n    import socket",
                   "import importlib\nimportlib.import_module('requests')",
                   "__import__('urllib3.util')", "from urllib3.util import parse_url"):
        assert network_imports(source), source
    for source in ("import os", "from . import http", "from .http import Client",
                   "from urllib.parse import urlsplit", "import email.utils"):
        assert network_imports(source) == [], source


def test_only_http_py_reaches_the_network():
    offenders = []
    for path in sorted(PACKAGE.rglob("*.py")):
        if SKIP_DIRS & set(path.relative_to(PIPELINE).parts):
            continue
        if path.relative_to(PACKAGE).as_posix() == "http.py":
            continue
        found = network_imports(path.read_text(encoding="ascii"))
        if found:
            offenders.append("{}: {}".format(path.relative_to(PACKAGE).as_posix(), found))
    assert offenders == []


def test_proj_network_access_is_off():
    import pyproj.network

    import commons_world  # noqa: F401  (switches it off on import)
    assert pyproj.network.is_network_enabled() is False


def test_build_command_reports_a_refused_listing(tmp_path, capsys):
    record = synthetic_listing()
    record["costs"]["target_monthly_eur"] = 1
    path = tmp_path / "listing.json"
    path.write_text(json.dumps(record), encoding="utf-8")
    code = main(["build", "--listing", str(path), "--out", str(tmp_path / "w"),
                 "--cache", str(tmp_path / "cache"), "--no-plugins"])
    assert code == 2
    assert "target" in capsys.readouterr().err
    assert not (tmp_path / "w").exists()


def test_check_command_on_a_missing_folder(tmp_path, capsys):
    assert main(["check", str(tmp_path / "nothing")]) == 1
    assert "manifest.json unreadable" in capsys.readouterr().out
