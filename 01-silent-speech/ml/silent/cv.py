"""Cross validation splitters. Each fold = (train indices, test indices), both sorted int arrays."""

from __future__ import annotations

from collections.abc import Iterator, Sequence
from typing import Literal

import numpy as np

Protocol = Literal["loo", "loso", "xbud"]
Fold = tuple[np.ndarray, np.ndarray]


def loo(n: int) -> Iterator[Fold]:
    """Leave one clip out: n folds, test = one clip, train = all the others."""
    idx = np.arange(n)
    for i in range(n):
        yield np.delete(idx, i), np.array([i])


def loso(sessions: Sequence[str]) -> Iterator[Fold]:
    """Leave one session out: one fold per session (sorted). No clip of the test session is ever in train."""
    s = np.asarray(sessions, dtype=object)
    uniq = sorted(set(s.tolist()))
    if len(uniq) < 2:
        raise ValueError(f"LOSO needs at least 2 sessions, got {uniq}")
    for name in uniq:
        test = np.flatnonzero(s == name)
        train = np.flatnonzero(s != name)
        yield train, test


def xbud(sessions: Sequence[str], buds: Sequence[str], train: str = "left", test: str = "right") -> Iterator[Fold]:
    """Cross bud: one fold, train = every `train` bud clip, test = every `test` bud clip (other buds sit out).
    A session with clips on both sides would leak, so that is an error."""
    if len(buds) != len(sessions):
        raise ValueError("one bud per clip")
    b = np.asarray(buds, dtype=object)
    s = np.asarray(sessions, dtype=object)
    tr, te = np.flatnonzero(b == train), np.flatnonzero(b == test)
    if not len(tr) or not len(te):
        raise ValueError(f"xbud needs {train} and {test} bud clips, got {sorted(set(b.tolist()))}")
    both = set(s[tr].tolist()) & set(s[te].tolist())
    if both:
        raise ValueError(f"xbud: sessions {sorted(both)} have clips on both buds (would leak)")
    yield tr, te


def splits(protocol: Protocol, sessions: Sequence[str], buds: Sequence[str] | None = None) -> Iterator[Fold]:
    if protocol == "loo":
        return loo(len(sessions))
    if protocol == "loso":
        return loso(sessions)
    if protocol == "xbud":
        if buds is None:
            raise ValueError("xbud needs the bud of every clip")
        return xbud(sessions, buds)
    raise ValueError(f"unknown protocol {protocol!r}")
