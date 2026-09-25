"""Refuse to write real data where git would pick it up.

A built world, a listing record and the response cache all hold a precise
location. Their homes are world/out/ and world/pipeline/.cache/, which
.gitignore keeps out of git. A mistyped --out or --cache followed by
`git add world/` would put them into a public repo, so before anything is
written the destination is checked:

- outside every git checkout: fine;
- inside one, and ignored by it (`git check-ignore`): fine;
- inside one and not ignored, or git cannot say: refused.

Only read-only git commands are run, with GIT_OPTIONAL_LOCKS=0 so that not
even the index is refreshed.
"""

import os
import subprocess
from pathlib import Path


class UnsafeDestination(RuntimeError):
    """The destination is inside a git checkout and git does not ignore it."""


def _git(args, cwd):
    env = dict(os.environ, GIT_OPTIONAL_LOCKS="0")
    return subprocess.run(["git", *args], cwd=str(cwd), capture_output=True, text=True,
                          timeout=30, env=env)


def _nearest_existing(path):
    path = Path(path)
    while not path.exists() and path != path.parent:
        path = path.parent
    return path if path.is_dir() else path.parent


def enclosing_checkout(path):
    """The top folder of the git work tree that `path` would be written into, or None."""
    start = _nearest_existing(path)
    if not any((folder / ".git").exists() for folder in (start, *start.parents)):
        return None
    try:
        result = _git(["rev-parse", "--show-toplevel"], start)
    except (OSError, subprocess.SubprocessError) as exc:
        raise UnsafeDestination("{} is inside a git checkout, and git could not be run to "
                                "check whether it is ignored ({})".format(path, exc)) from exc
    if result.returncode != 0 or not result.stdout.strip():
        raise UnsafeDestination("{} is inside a git checkout, and git could not name its work "
                                "tree: {}".format(path, result.stderr.strip()))
    return Path(result.stdout.strip()).resolve()


def check_destination(path, what="output", directory=True):
    """Raise UnsafeDestination unless `path` is outside git, or ignored by its checkout.

    `directory` says the destination is a folder (everything the pipeline writes
    is), which matters to a pattern such as `.cache/` that only matches folders:
    git can only apply it to a path that does not exist yet if told it is one.
    """
    path = Path(path).resolve()
    top = enclosing_checkout(path)
    if top is None:
        return
    rel = os.path.relpath(path, top)
    if rel == "." or rel.split(os.sep)[0] == ".git":
        raise UnsafeDestination("refusing to write {} to {}: that is a git work tree or its "
                                ".git folder".format(what, path))
    try:
        result = _git(["check-ignore", "-q", "--", rel + ("/" if directory else "")], top)
    except (OSError, subprocess.SubprocessError) as exc:
        raise UnsafeDestination("could not ask git whether {} is ignored ({})".format(path, exc)
                                ) from exc
    if result.returncode == 0:
        return
    if result.returncode == 1:
        raise UnsafeDestination(
            "refusing to write {} to {}: it is inside the git checkout {} and git does not "
            "ignore it, so `git add` would pick it up. Use world/out/ (or a folder outside "
            "any checkout).".format(what, path, top))
    raise UnsafeDestination("git check-ignore failed for {}: {}".format(
        path, result.stderr.strip()))
