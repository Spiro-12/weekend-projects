import os
from pathlib import Path

import pytest

from silent import DEFAULT_DATA, PROJECT_DIR
from silent.data import load_corpus

TINY = PROJECT_DIR / "shared" / "fixtures" / "dataset.tiny.json"


@pytest.fixture(scope="session")
def synthetic():
    return load_corpus([DEFAULT_DATA])


@pytest.fixture(scope="session")
def tiny():
    return load_corpus([TINY])


# GitHub Actions: turn failures into annotations (raw CI logs aren't reachable from Claude's sandbox,
# annotations are, through the check-runs API).
_ANNOTATIONS: list[str] = []


def _annotate(report) -> None:
    if not os.environ.get("GITHUB_ACTIONS") or not report.failed:
        return
    path, line = report.fspath, 1
    if getattr(report, "location", None):
        path, line = report.location[0], (report.location[1] or 0) + 1
    try:
        path = str((Path.cwd() / path).resolve().relative_to(PROJECT_DIR.parent))
    except ValueError:
        pass
    msg = str(report.longreprtext)[-1500:].replace("%", "%25").replace("\r", "").replace("\n", "%0A")
    title = report.nodeid.replace(",", ";").replace("::", " ")
    _ANNOTATIONS.append(f"::error file={path},line={line},title={title}::{msg}")


def pytest_runtest_logreport(report):
    _annotate(report)


def pytest_collectreport(report):
    _annotate(report)


def pytest_terminal_summary(terminalreporter):
    for a in _ANNOTATIONS:
        terminalreporter.write_line(a)
