"""`dtw-py`: numpy DTW + kNN, a port of the JS `dtw-knn` (PROTOCOL.md §6, web/src/ml/knn.ts) so the two
can be cross checked. Labels, confidence and `top` follow knn.ts line for line.

DTW: dependent multivariate (one warp path for all channels), local cost = squared Euclidean summed
over channels, Sakoe-Chiba band |i - j| <= r with r = max(1, floor(band * L + 0.5)), steps
(i-1, j), (i, j-1), (i-1, j-1). Returns the total accumulated cost D[n-1][m-1] (no normalization).

Prediction (same as knn.ts):
1. DTW the clip against every template. Clips and templates are rounded to float32 like the JS
   (Float32Array), so both sides see the same numbers.
2. Label = distance weighted vote of the k nearest templates (default k = 1), weight 1 / (d + 1e-9).
   Order: vote weight desc, then the class's nearest distance, then label (labels sorted).
3. dRef = median over templates of the DTW distance to the nearest other template of the same class.
   None when no class has 2 templates.
4. confidence = vote share x separation. Separation = softmax with T = 0.1 x dRef over every class's
   nearest distance plus two virtual templates: "unknown" at 1.7 x dRef and "stillness" at
   1.25 x sum(q^2) (DTW to the all zeros clip). Stillness backs a `none` answer. Models with fewer than
   2 classes or no dRef: T = 0.1 x best distance + 1e-12, no virtual templates, confidence capped at
   threshold / 2 (never accepted at a positive threshold).
5. top = [label, confidence] + the next 2 classes by nearest distance, each scored min(own separation,
   confidence).
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from typing import Any

import numpy as np

from .. import NONE
from . import Model, Pred

SEPARATION_TAU = 0.1  # knn.ts SEPARATION_TAU
UNKNOWN_AT = 1.7  # knn.ts UNKNOWN_AT
SILENCE_AT = 1.25  # knn.ts SILENCE_AT
VOTE_EPS = 1e-9


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


def _dp(cost: np.ndarray, radius: int) -> np.ndarray:
    """Banded DTW recursion over a (P, L, L) local cost tensor, two rolling rows. Returns (P,) totals."""
    P, L, _ = cost.shape
    inf = np.full(P, np.inf)
    prev = np.full((P, L), np.inf)
    for i in range(L):
        cur = np.full((P, L), np.inf)
        for j in range(max(0, i - radius), min(L - 1, i + radius) + 1):
            if i == 0 and j == 0:
                cur[:, 0] = cost[:, 0, 0]
                continue
            up = prev[:, j] if i > 0 else inf
            left = cur[:, j - 1] if j > 0 else inf
            diag = prev[:, j - 1] if (i > 0 and j > 0) else inf
            cur[:, j] = cost[:, i, j] + np.minimum(np.minimum(up, left), diag)
        prev = cur
    return prev[:, L - 1]


def dtw_pairs(A: np.ndarray, B: np.ndarray, radius: int, chunk: int = 512) -> np.ndarray:
    """DTW of A[p] vs B[p] for every p, A and B (P, ch, L). Same recursion as `dtw`, vectorized over pairs."""
    if A.shape != B.shape:
        raise ValueError("pairs must have the same shape")
    P, C, L = A.shape
    out = np.empty(P)
    for s in range(0, P, chunk):
        a, b = A[s : s + chunk], B[s : s + chunk]
        cost = np.zeros((len(a), L, L))  # cost[p, i, j] = sum_c (a[p, c, i] - b[p, c, j])^2
        for c in range(C):
            cost += (a[:, c, :, None] - b[:, c, None, :]) ** 2
        out[s : s + chunk] = _dp(cost, radius)
    return out


def dtw_many(a: np.ndarray, B: np.ndarray, radius: int) -> np.ndarray:
    """DTW from one query a (ch, L) to every template in B (M, ch, L). Returns (M,)."""
    if a.shape != B.shape[1:]:
        raise ValueError("query and templates must have the same shape")
    return dtw_pairs(np.broadcast_to(a, B.shape), B, radius)


def same_class_nn(X: np.ndarray, y_idx: np.ndarray, radius: int) -> np.ndarray:
    """Per template: DTW to the nearest OTHER template of the same class (inf if it is alone)."""
    ii, jj = [], []
    for c in np.unique(y_idx):
        members = np.flatnonzero(y_idx == c)
        for p in range(len(members)):
            for q in range(p + 1, len(members)):
                ii.append(members[p])
                jj.append(members[q])
    nn = np.full(len(X), np.inf)
    if ii:
        d = dtw_pairs(X[ii], X[jj], radius)  # DTW is symmetric: each pair once
        np.minimum.at(nn, ii, d)
        np.minimum.at(nn, jj, d)
    return nn


def reference_distance(nn_same: np.ndarray) -> float | None:
    """dRef = median of the finite same class nearest distances; None if there are none."""
    finite = nn_same[np.isfinite(nn_same)]
    return float(np.median(finite)) if len(finite) else None


def classify(
    d: np.ndarray, y_idx: np.ndarray, labels: Sequence[str], k: int = 1, ref: float | None = None, energy: float = 0.0, threshold: float = 0.5
) -> Pred:
    """knn.ts `classify` from the template distances d (M,), template label indexes y_idx (M,), sorted labels,
    dRef and the clip energy sum(q^2)."""
    nL = len(labels)
    k = min(k, len(d))
    nearest = np.full(nL, np.inf)
    np.minimum.at(nearest, y_idx, d)
    w = np.zeros(nL)
    for s in np.argsort(d, kind="stable")[:k]:  # stable = the earlier template wins a distance tie, like the JS
        w[y_idx[s]] += 1.0 / (float(d[s]) + VOTE_EPS)
    w_sum = float(w.sum())
    voted = sorted((i for i in range(nL) if w[i] > 0), key=lambda i: (-w[i], nearest[i], i))
    best = voted[0]
    d_best = float(nearest.min())
    safe = nL >= 2 and ref is not None and ref > 0 and math.isfinite(ref)
    T = SEPARATION_TAU * ref if safe else SEPARATION_TAU * d_best + 1e-12
    d_unknown = UNKNOWN_AT * ref if safe else math.inf
    d_still = SILENCE_AT * energy if safe else math.inf
    m = -min(d_best, d_unknown, d_still) / T  # largest logit

    def share(x: float) -> float:
        return math.exp(-x / T - m)

    z = share(d_unknown) + share(d_still) + sum(share(float(x)) for x in nearest)

    def sep(i: int) -> float:
        return share(float(nearest[i])) / z

    label = labels[best]
    confidence = (w[best] / w_sum) * (sep(best) + (share(d_still) / z if label == NONE else 0.0))
    if not safe:
        confidence = min(confidence, max(0.0, threshold / 2))
    rest = sorted((i for i in range(nL) if i != best), key=lambda i: (nearest[i], i))[:2]
    top = [(label, float(confidence))] + [(labels[i], float(min(sep(i), confidence))) for i in rest]
    return Pred(label=label, confidence=float(confidence), top=top)


def as_f32(x: np.ndarray) -> np.ndarray:
    """Round to float32 (what the JS stores), compute in float64."""
    return np.asarray(x, dtype=np.float32).astype(np.float64)


# web/src/ml/preprocess.ts DEFAULT_OPTS since Phase 2 (Track F's LOSO sweep of 768 configs on Spiro's 3 real sessions).
# dtw-py runs with the same options by default so the two stay comparable. Phase 1 defaults: L 64, band 0.1, k 1,
# norm global, threshold 0.5 (`PHASE1_DEFAULTS`, kept for the "settings fixed before the data" comparison).
JS_DEFAULTS: dict[str, Any] = {"L": 96, "band": 0.05, "k": 3, "norm": "clip", "threshold": 0.85}
PHASE1_DEFAULTS: dict[str, Any] = {"L": 64, "band": 0.1, "k": 1, "norm": "global", "threshold": 0.5}


class DtwKnn(Model):
    name = "dtw-py"

    def __init__(self, band: float = JS_DEFAULTS["band"], k: int = JS_DEFAULTS["k"], threshold: float = JS_DEFAULTS["threshold"]):
        self.band = band
        self.k = k
        self.threshold = threshold

    def fit(self, X: np.ndarray, y: Sequence[str]) -> DtwKnn:
        self.templates = as_f32(X)
        self.labels = sorted(set(y))
        self.y_idx = np.array([self.labels.index(v) for v in y], dtype=np.int64)
        self.radius = band_radius(self.band, self.templates.shape[2])
        self.ref = reference_distance(same_class_nn(self.templates, self.y_idx, self.radius))
        return self

    def distances(self, x: np.ndarray) -> np.ndarray:
        return dtw_many(as_f32(x), self.templates, self.radius)

    def predict(self, X: np.ndarray) -> list[Pred]:
        out = []
        for x in X:
            q = as_f32(x)
            d = dtw_many(q, self.templates, self.radius)
            out.append(classify(d, self.y_idx, self.labels, self.k, self.ref, float(np.sum(q * q)), self.threshold))
        return out

    def params(self) -> dict[str, Any]:
        return {
            "band": self.band,
            "k": self.k,
            "radius": self.radius,
            "weights": "1/(d+1e-9)",
            "confidence": "vote x separation (knn.ts): softmax T=0.1 dRef, unknown at 1.7 dRef, stillness at 1.25 sum(q^2)",
        }
