"""`dtw-py`: numpy DTW + kNN, written to the same spec as the JS `dtw-knn` (PROTOCOL.md §6) so the
two can be cross checked.

DTW: dependent multivariate (one warp path for all channels), local cost = squared Euclidean summed
over channels, Sakoe-Chiba band |i - j| <= r with r = max(1, floor(band * L + 0.5)), steps
(i-1, j), (i, j-1), (i-1, j-1). Returns the total accumulated cost D[n-1][m-1] (no normalization).

kNN: k nearest templates vote with weight 1 / (d + 1e-9). Label = highest summed weight (tie: the label
of the nearer neighbour). confidence = that label's share of the k votes' total weight, so 1.0 when all
k neighbours agree. `top` = labels by vote share.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from typing import Any

import numpy as np

from . import Model, Pred


def band_radius(band: float, L: int) -> int:
    return max(1, math.floor(band * L + 0.5))


def dtw(a: np.ndarray, b: np.ndarray, radius: int) -> float:
    """Reference DTW for two (ch, n) / (ch, m) series. Plain loops, mirrors the spec line by line."""
    n, m = a.shape[1], b.shape[1]
    D = np.full((n, m), np.inf)
    for i in range(n):
        for j in range(max(0, i - radius), min(m, i + radius + 1)):
            cost = float(np.sum((a[:, i] - b[:, j]) ** 2))
            if i == 0 and j == 0:
                D[i, j] = cost
                continue
            best = math.inf
            if i > 0:
                best = min(best, D[i - 1, j])
            if j > 0:
                best = min(best, D[i, j - 1])
            if i > 0 and j > 0:
                best = min(best, D[i - 1, j - 1])
            D[i, j] = cost + best
    return float(D[n - 1, m - 1])


def dtw_many(a: np.ndarray, B: np.ndarray, radius: int) -> np.ndarray:
    """DTW from one query a (ch, L) to every template in B (M, ch, L). Same recursion as `dtw`,
    vectorized over templates with two rolling rows. Returns (M,) total costs."""
    M, _, L = B.shape
    if a.shape[1] != L:
        raise ValueError("query and templates must have the same length")
    # cost[m, i, j] = sum_c (a[c, i] - B[m, c, j])^2
    cost = np.zeros((M, L, L))
    for c in range(a.shape[0]):
        cost += (a[c][None, :, None] - B[:, c][:, None, :]) ** 2
    inf = np.full(M, np.inf)
    prev = np.full((M, L), np.inf)
    for i in range(L):
        cur = np.full((M, L), np.inf)
        lo, hi = max(0, i - radius), min(L - 1, i + radius)
        for j in range(lo, hi + 1):
            if i == 0 and j == 0:
                cur[:, 0] = cost[:, 0, 0]
                continue
            up = prev[:, j] if i > 0 else inf
            left = cur[:, j - 1] if j > 0 else inf
            diag = prev[:, j - 1] if (i > 0 and j > 0) else inf
            cur[:, j] = cost[:, i, j] + np.minimum(np.minimum(up, left), diag)
        prev = cur
    return prev[:, L - 1]


def knn_vote(d: np.ndarray, y: Sequence[str], k: int = 3) -> Pred:
    nearest = np.argsort(d, kind="stable")[: min(k, len(d))]
    votes: dict[str, float] = {}
    for i in nearest:  # dict keeps first seen order = nearer neighbour first, used for ties
        votes[y[i]] = votes.get(y[i], 0.0) + 1.0 / (float(d[i]) + 1e-9)
    total = sum(votes.values())
    ranked = sorted(votes.items(), key=lambda kv: -kv[1])  # stable
    top = [(lab, w / total) for lab, w in ranked[:3]]
    return Pred(label=top[0][0], confidence=top[0][1], top=top)


class DtwKnn(Model):
    name = "dtw-py"

    def __init__(self, band: float = 0.1, k: int = 3):
        self.band = band
        self.k = k

    def fit(self, X: np.ndarray, y: Sequence[str]) -> DtwKnn:
        self.templates = np.asarray(X, dtype=np.float64)
        self.y = list(y)
        self.radius = band_radius(self.band, self.templates.shape[2])
        return self

    def distances(self, x: np.ndarray) -> np.ndarray:
        return dtw_many(np.asarray(x, dtype=np.float64), self.templates, self.radius)

    def predict(self, X: np.ndarray) -> list[Pred]:
        return [knn_vote(self.distances(x), self.y, self.k) for x in X]

    def params(self) -> dict[str, Any]:
        return {"band": self.band, "k": self.k, "weights": "1/(d+1e-9)", "confidence": "vote share of the k nearest"}
