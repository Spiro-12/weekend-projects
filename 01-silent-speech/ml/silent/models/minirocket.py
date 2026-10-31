"""MiniRocket (aeon, multivariate) features + RidgeClassifierCV, the standard recipe
(StandardScaler(with_mean=False), alphas = logspace(-3, 3, 10)), seeded.

Label = the class with the highest ridge decision value (what RidgeClassifierCV.predict says; ties go
to the earlier label). Ridge has no probabilities. confidence: each class's one vs rest decision value d
(trained toward +1 / -1) is mapped to (d + 1) / 2, clipped to [0, 1] and normalized to sum 1. A rough
linear probability, used only for `accepted` / noneFalseAcceptRate. (The label is not read from the
clipped scores: two classes above +1 would tie there.)
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

import numpy as np

from . import Model, Pred


def ridge_scores(decision: np.ndarray, n_classes: int) -> np.ndarray:
    d = np.asarray(decision, dtype=np.float64)
    if d.ndim == 1:  # binary: sklearn gives the positive class score only
        d = np.stack([-d, d], axis=1)
    if d.shape[1] != n_classes:
        raise ValueError("decision shape does not match classes")
    p = np.clip((d + 1.0) / 2.0, 0.0, 1.0)
    s = p.sum(axis=1, keepdims=True)
    return np.where(s > 0, p / np.where(s > 0, s, 1.0), 1.0 / n_classes)


def ridge_preds(labels: Sequence[str], decision: np.ndarray) -> list[Pred]:
    """Label = highest decision value (RidgeClassifierCV.predict), confidence / top from `ridge_scores`."""
    d = np.asarray(decision, dtype=np.float64)
    if d.ndim == 1:
        d = np.stack([-d, d], axis=1)
    P = ridge_scores(d, len(labels))
    out = []
    for di, p in zip(d, P):
        order = np.argsort(-di, kind="stable")  # the map is monotone, so scores stay non increasing
        top = [(labels[i], float(p[i])) for i in order[:3]]
        out.append(Pred(label=top[0][0], confidence=top[0][1], top=top))
    return out


def make_transform(n_kernels: int, seed: int) -> Any:
    """The MiniRocket transform. Its fit never sees labels (only the training series and the seed)."""
    from aeon.transformations.collection.convolution_based import MiniRocket

    return MiniRocket(n_kernels=n_kernels, random_state=seed, n_jobs=1)


def make_classifier() -> Any:
    from sklearn.linear_model import RidgeClassifierCV
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler

    return make_pipeline(StandardScaler(with_mean=False), RidgeClassifierCV(alphas=np.logspace(-3, 3, 10)))


def as_series(X: np.ndarray) -> np.ndarray:
    return np.ascontiguousarray(X, dtype=np.float64)


class MiniRocketRidge(Model):
    name = "minirocket"

    def __init__(self, n_kernels: int = 10_000, seed: int = 0):
        self.n_kernels = n_kernels
        self.seed = seed

    def fit(self, X: np.ndarray, y: Sequence[str]) -> MiniRocketRidge:
        self.transform = make_transform(self.n_kernels, self.seed)
        F = self.transform.fit_transform(as_series(X))
        self.labels = sorted(set(y))
        if len(self.labels) > 1:
            self.clf = make_classifier()
            self.clf.fit(F, np.asarray(y))
            self.labels = [str(c) for c in self.clf.classes_]
        return self

    def predict(self, X: np.ndarray) -> list[Pred]:
        F = self.transform.transform(as_series(X))
        if len(self.labels) == 1:
            return [Pred(self.labels[0], 1.0, [(self.labels[0], 1.0)]) for _ in range(len(F))]
        return ridge_preds(self.labels, self.clf.decision_function(F))

    def params(self) -> dict[str, Any]:
        return {
            "nKernels": self.n_kernels,
            "seed": self.seed,
            "classifier": "StandardScaler(with_mean=False) + RidgeClassifierCV(logspace(-3,3,10))",
            "confidence": "ridge decision (d+1)/2 clipped, normalized",
        }
