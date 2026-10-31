"""Cross validation splitters. Each fold = (train indices, test indices), both sorted int arrays."""

from __future__ import annotations

from collections.abc import Iterator, Sequence
from typing import Literal

import numpy as np

Protocol = Literal["loo", "loso"]
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


def splits(protocol: Protocol, sessions: Sequence[str]) -> Iterator[Fold]:
    if protocol == "loo":
        return loo(len(sessions))
    if protocol == "loso":
        return loso(sessions)
    raise ValueError(f"unknown protocol {protocol!r}")
