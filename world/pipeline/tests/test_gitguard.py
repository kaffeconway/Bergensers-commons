"""Output never lands where `git add` would pick it up.

The fake checkout is made by writing the few files git needs to recognise a
repository, so no git command that changes anything is run. The checks against
this repo itself use read-only git only (rev-parse, check-ignore).
"""

import json
import shutil
from pathlib import Path

import pytest

from commons_world import gitguard
from commons_world.__main__ import main
from commons_world.build import DEFAULT_CACHE, DEFAULT_OUT_ROOT, build
from commons_world.gitguard import UnsafeDestination, check_destination
from commons_world.synthetic import build_synthetic, synthetic_listing

PIPELINE = Path(__file__).resolve().parents[1]
HAVE_GIT = shutil.which("git") is not None
IN_CHECKOUT = HAVE_GIT and gitguard.enclosing_checkout(PIPELINE) is not None


def fake_checkout(root):
    """A folder git recognises as a work tree, ignoring out/ and cache/, made without git."""
    git = root / ".git"
    for sub in ("objects", "refs/heads", "refs/tags"):
        (git / sub).mkdir(parents=True)
    (git / "HEAD").write_text("ref: refs/heads/main\n", encoding="ascii")
    (git / "config").write_text("[core]\n\trepositoryformatversion = 0\n\tbare = false\n",
                                encoding="ascii")
    (root / ".gitignore").write_text("out/\ncache/\n", encoding="ascii")
    return root


def test_outside_any_checkout_is_fine(tmp_path):
    check_destination(tmp_path / "anywhere" / "world")


@pytest.mark.skipif(not HAVE_GIT, reason="git is not installed")
def test_a_fake_checkout_ignored_and_not(tmp_path):
    repo = fake_checkout(tmp_path / "repo")
    check_destination(repo / "out" / "no-9999-1-1")
    check_destination(repo / "cache")
    for bad in (repo / "world", repo / "docs" / "listing.json", repo, repo / ".git" / "x"):
        with pytest.raises(UnsafeDestination):
            check_destination(bad)


@pytest.mark.skipif(not HAVE_GIT, reason="git is not installed")
def test_build_refuses_a_tracked_out_folder_before_writing(tmp_path):
    repo = fake_checkout(tmp_path / "repo")
    listing = tmp_path / "listing.json"
    listing.write_text(json.dumps(synthetic_listing()), encoding="utf-8")
    with pytest.raises(UnsafeDestination):
        build(listing, repo / "world" / "w", cache_dir=tmp_path / "cache", offline=True)
    with pytest.raises(UnsafeDestination):
        build(listing, tmp_path / "w", cache_dir=repo / "tracked-cache", offline=True)
    with pytest.raises(UnsafeDestination):
        build_synthetic(repo / "synthetic")
    assert sorted(p.name for p in repo.iterdir()) == [".git", ".gitignore"]
    assert not (tmp_path / "w").exists()


@pytest.mark.skipif(not HAVE_GIT, reason="git is not installed")
def test_cli_reports_an_unsafe_destination(tmp_path, capsys):
    repo = fake_checkout(tmp_path / "repo")
    assert main(["synthetic", "--out", str(repo / "world")]) == 2
    assert "git does not ignore it" in capsys.readouterr().err
    assert not (repo / "world").exists()


@pytest.mark.skipif(not IN_CHECKOUT, reason="the pipeline is not inside a git checkout")
def test_this_repo_default_folders_are_ignored_and_the_rest_is_not():
    check_destination(DEFAULT_OUT_ROOT / "no-9999-1-1")
    check_destination(DEFAULT_OUT_ROOT / "synthetic")
    check_destination(DEFAULT_CACHE)
    for bad in (PIPELINE / "out", PIPELINE / "commons_world" / "w", PIPELINE.parent / "data"):
        with pytest.raises(UnsafeDestination):
            check_destination(bad)
