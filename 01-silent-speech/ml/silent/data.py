"""Load `ss-dataset` v1 files (PROTOCOL.md §3), check their basic shape, merge, dedupe by clip id,
skip the clip ids of an `ss-exclude` list. Each clip keeps its bud (`clip.loc`, else the file's `device.loc`)."""

from __future__ import annotations

import json
import math
from collections.abc import Iterable
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any


BUD_LOCS = ("left", "right", "default", "unknown")  # contracts.ts BudLocation


class DatasetError(ValueError):
    """A dataset file is not a valid `ss-dataset` v1 (or an exclusion list is not a valid `ss-exclude` v1)."""


@dataclass(frozen=True)
class Clip:
    id: str
    label: str
    session: str  # clip.session, else the file's session
    samples: list[dict[str, Any]]
    loc: str = "unknown"  # bud that had the sensor: clip.loc, else the file's device.loc (PROTOCOL §3)


@dataclass
class Corpus:
    clips: list[Clip]
    files: list[str]
    duplicates: int = 0  # clips dropped because their id was already seen
    sources: list[str] = field(default_factory=list)  # dataset `source` values: "airpods" / "fake"
    subjects: list[str] = field(default_factory=list)
    exclude_file: str | None = None  # the `ss-exclude` list that was applied, if any
    exclude_ids: list[str] = field(default_factory=list)  # every id in that list
    excluded: list[str] = field(default_factory=list)  # ids actually dropped from these files (merge order)
    excluded_by_session: dict[str, int] = field(default_factory=dict)

    @property
    def labels(self) -> list[str]:
        """Sorted, like the JS (`sortLabels`)."""
        return sorted({c.label for c in self.clips})

    @property
    def sessions(self) -> list[str]:
        return sorted({c.session for c in self.clips})

    @property
    def buds(self) -> dict[str, str]:
        """Bud per session ("left", "right", ... or "mixed")."""
        out: dict[str, set[str]] = {}
        for c in self.clips:
            out.setdefault(c.session, set()).add(c.loc)
        return {s: (next(iter(v)) if len(v) == 1 else "mixed") for s, v in sorted(out.items())}

    @property
    def synthetic(self) -> bool:
        return "fake" in self.sources or "synthetic" in self.subjects

    def select(self, sessions: Iterable[str] | None = None, labels: Iterable[str] | None = None) -> Corpus:
        """A copy with only these sessions / labels (for small tests and sub analyses)."""
        ss = set(sessions) if sessions is not None else None
        ls = set(labels) if labels is not None else None
        clips = [c for c in self.clips if (ss is None or c.session in ss) and (ls is None or c.label in ls)]
        return replace(self, clips=clips)


def _num(x: Any) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def _vec(x: Any, n: int) -> bool:
    return isinstance(x, list) and len(x) == n and all(_num(v) for v in x)


def validate_dataset(d: Any) -> list[str]:
    """Basic shape check (the parts the bench relies on). Empty list = valid."""
    if not isinstance(d, dict):
        return ["not an object"]
    errs: list[str] = []
    dev = d.get("device")
    if dev is not None and (not isinstance(dev, dict) or dev.get("loc") not in (None, *BUD_LOCS)):
        errs.append("device.loc must be one of " + "/".join(BUD_LOCS))
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
        if c.get("session") is not None and not isinstance(c["session"], str):
            errs.append(f"clips[{i}] session must be a string")
        if c.get("loc") is not None and c["loc"] not in BUD_LOCS:
            errs.append(f"clips[{i}] loc invalid")
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


def file_loc(d: dict[str, Any]) -> str:
    dev = d.get("device")
    loc = dev.get("loc") if isinstance(dev, dict) else None
    return loc if loc is not None else "unknown"


def merge(datasets: Iterable[dict[str, Any]], files: list[str] | None = None) -> Corpus:
    """Merge datasets in order. A clip id seen before is dropped (first one wins).
    session = clip.session ?? file session (like the JS: an empty string is kept, only a missing / null one falls back).
    loc = clip.loc ?? file device.loc (?? "unknown")."""
    clips: list[Clip] = []
    seen: set[str] = set()
    sources: list[str] = []
    subjects: list[str] = []
    dup = 0
    for d in datasets:
        for key, acc in (("source", sources), ("subject", subjects)):
            v = d.get(key)
            if isinstance(v, str) and v not in acc:
                acc.append(v)
        for c in d["clips"]:
            if c["id"] in seen:
                dup += 1
                continue
            seen.add(c["id"])
            session = c["session"] if c.get("session") is not None else d["session"]
            loc = c["loc"] if c.get("loc") is not None else file_loc(d)
            clips.append(Clip(id=c["id"], label=c["label"], session=session, samples=c["samples"], loc=loc))
    return Corpus(clips=clips, files=list(files or []), duplicates=dup, sources=sources, subjects=subjects)


def load_exclude(path: str | Path) -> list[str]:
    """Clip ids from an `ss-exclude` v1 file: `{ "format": "ss-exclude", "v": 1, "reason": "...", "ids": [...] }`."""
    p = Path(path)
    try:
        d = json.loads(p.read_text())
    except (OSError, json.JSONDecodeError) as e:
        raise DatasetError(f"{p}: {e}") from e
    if not isinstance(d, dict) or d.get("format") != "ss-exclude" or d.get("v") != 1:
        raise DatasetError(f"{p}: not an ss-exclude v1 file")
    ids = d.get("ids")
    if not isinstance(ids, list) or not all(isinstance(x, str) for x in ids):
        raise DatasetError(f"{p}: ids must be a list of strings")
    return list(dict.fromkeys(ids))


def apply_exclude(corpus: Corpus, ids: Iterable[str], file: str | None = None) -> Corpus:
    """Drop every clip whose id is in `ids` (after merge + dedupe). The raw files are never edited."""
    ids = list(dict.fromkeys(ids))
    drop = set(ids)
    keep = [c for c in corpus.clips if c.id not in drop]
    gone = [c for c in corpus.clips if c.id in drop]
    by_session = dict(corpus.excluded_by_session)
    for c in gone:
        by_session[c.session] = by_session.get(c.session, 0) + 1
    return replace(
        corpus, clips=keep, exclude_file=file, exclude_ids=ids, excluded=corpus.excluded + [c.id for c in gone],
        excluded_by_session=dict(sorted(by_session.items())),
    )


def load_corpus(paths: Iterable[str | Path], exclude: str | Path | None = None) -> Corpus:
    """Load, merge and dedupe dataset files, then skip the ids of the `exclude` list (if given)."""
    paths = [Path(p) for p in paths]
    if not paths:
        raise DatasetError("no dataset files given")
    corpus = merge((load_dataset(p) for p in paths), files=[str(p) for p in paths])
    if exclude is not None:
        corpus = apply_exclude(corpus, load_exclude(exclude), str(exclude))
    if not corpus.clips:
        raise DatasetError("no clips in the given files")
    return corpus
