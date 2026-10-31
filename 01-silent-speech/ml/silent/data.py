"""Load `ss-dataset` v1 files (PROTOCOL.md §3), check their basic shape, merge, dedupe by clip id."""

from __future__ import annotations

import json
import math
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


class DatasetError(ValueError):
    """A dataset file is not a valid `ss-dataset` v1."""


@dataclass(frozen=True)
class Clip:
    id: str
    label: str
    session: str  # clip.session, else the file's session
    samples: list[dict[str, Any]]


@dataclass
class Corpus:
    clips: list[Clip]
    files: list[str]
    class_order: list[str]  # class ids in file order (first file first), for stable label order
    duplicates: int = 0  # clips dropped because their id was already seen
    subjects: list[str] = field(default_factory=list)

    @property
    def labels(self) -> list[str]:
        present = {c.label for c in self.clips}
        ordered = [c for c in self.class_order if c in present]
        return ordered + sorted(present - set(ordered))

    @property
    def sessions(self) -> list[str]:
        return sorted({c.session for c in self.clips})


def _num(x: Any) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def _vec(x: Any, n: int) -> bool:
    return isinstance(x, list) and len(x) == n and all(_num(v) for v in x)


def validate_dataset(d: Any) -> list[str]:
    """Basic shape check (the parts the bench relies on). Empty list = valid."""
    if not isinstance(d, dict):
        return ["not an object"]
    errs: list[str] = []
    if d.get("format") != "ss-dataset":
        errs.append("format must be ss-dataset")
    if d.get("v") != 1:
        errs.append("v must be 1")
    if not isinstance(d.get("session"), str):
        errs.append("session must be a string")
    classes = d.get("classes")
    if not isinstance(classes, list) or not all(isinstance(c, dict) and isinstance(c.get("id"), str) for c in classes):
        errs.append("classes invalid")
        classes = []
    known = {c["id"] for c in classes}
    clips = d.get("clips")
    if not isinstance(clips, list):
        return errs + ["clips must be an array"]
    for i, c in enumerate(clips):
        if not isinstance(c, dict):
            errs.append(f"clips[{i}] not an object")
            continue
        if not isinstance(c.get("id"), str) or not isinstance(c.get("label"), str):
            errs.append(f"clips[{i}] id/label missing")
        elif c["label"] not in known:
            errs.append(f"clips[{i}] unknown label {c['label']}")
        if "session" in c and not isinstance(c["session"], str):
            errs.append(f"clips[{i}] session must be a string")
        s = c.get("samples")
        if not isinstance(s, list) or len(s) < 2:
            errs.append(f"clips[{i}] needs at least 2 samples")
        elif not all(isinstance(x, dict) and _num(x.get("t")) and _vec(x.get("rr"), 3) and _vec(x.get("ua"), 3) for x in s):
            errs.append(f"clips[{i}] samples invalid (need t, rr[3], ua[3])")
    return errs


def load_dataset(path: str | Path) -> dict[str, Any]:
    p = Path(path)
    try:
        d = json.loads(p.read_text())
    except (OSError, json.JSONDecodeError) as e:
        raise DatasetError(f"{p}: {e}") from e
    errs = validate_dataset(d)
    if errs:
        shown = "; ".join(errs[:5]) + (f" (+{len(errs) - 5} more)" if len(errs) > 5 else "")
        raise DatasetError(f"{p}: {shown}")
    return d


def merge(datasets: Iterable[dict[str, Any]], files: list[str] | None = None) -> Corpus:
    """Merge datasets in order. A clip id seen before is dropped (first one wins)."""
    clips: list[Clip] = []
    seen: set[str] = set()
    order: list[str] = []
    subjects: list[str] = []
    dup = 0
    for d in datasets:
        for c in d["classes"]:
            if c["id"] not in order:
                order.append(c["id"])
        if d.get("subject") and d["subject"] not in subjects:
            subjects.append(d["subject"])
        for c in d["clips"]:
            if c["id"] in seen:
                dup += 1
                continue
            seen.add(c["id"])
            clips.append(Clip(id=c["id"], label=c["label"], session=c.get("session") or d["session"], samples=c["samples"]))
    return Corpus(clips=clips, files=list(files or []), class_order=order, duplicates=dup, subjects=subjects)


def load_corpus(paths: Iterable[str | Path]) -> Corpus:
    paths = [Path(p) for p in paths]
    if not paths:
        raise DatasetError("no dataset files given")
    corpus = merge((load_dataset(p) for p in paths), files=[str(p) for p in paths])
    if not corpus.clips:
        raise DatasetError("no clips in the given files")
    return corpus
