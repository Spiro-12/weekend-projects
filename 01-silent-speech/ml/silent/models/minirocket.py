"""MiniRocket (aeon, multivariate) features + RidgeClassifierCV, the standard recipe
(StandardScaler(with_mean=False), alphas = logspace(-3, 3, 10)), seeded.

Ridge has no probabilities. confidence: each class's one vs rest decision value d (trained toward
+1 / -1) is mapped to (d + 1) / 2, clipped to [0, 1] and normalized to sum 1. A rough linear
probability, used only for `accepted` / noneFalseAcceptRate.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

import numpy as np

from . import Model, Pred, pred_from_scores


def ridge_scores(decision: np.ndarray, n_classes: int) -> np.ndarray:
    d = np.asarray(decision, dtype=np.float64)
    if d.ndim == 1:  # binary: sklearn gives the positive class score only
        d = np.stack([-d, d], axis=1)
    if d.shape[1] != n_classes:
        raise ValueError("decision shape does not match classes")
    p = np.clip((d + 1.0) / 2.0, 0.0, 1.0)
    s = p.sum(axis=1, keepdims=True)
    return np.where(s > 0, p / np.where(s > 0, s, 1.0), 1.0 / n_classes)


class MiniRocketRidge(Model):
    name = "minirocket"

    def __init__(self, n_kernels: int = 10_000, seed: int = 0):
        self.n_kernels = n_kernels
        self.seed = seed

    def fit(self, X: np.ndarray, y: Sequence[str]) -> MiniRocketRidge:
        from aeon.transformations.collection.convolution_based import MiniRocket
        from sklearn.linear_model import RidgeClassifierCV
        from sklearn.pipeline import make_pipeline
        from sklearn.preprocessing import StandardScaler

        self.transform = MiniRocket(n_kernels=self.n_kernels, random_state=self.seed, n_jobs=1)
        F = self.transform.fit_transform(np.ascontiguousarray(X, dtype=np.float64))
        self.labels = sorted(set(y))
        if len(self.labels) > 1:
            self.clf = make_pipeline(StandardScaler(with_mean=False), RidgeClassifierCV(alphas=np.logspace(-3, 3, 10)))
            self.clf.fit(F, np.asarray(y))
            self.labels = [str(c) for c in self.clf.classes_]
        return self

    def predict(self, X: np.ndarray) -> list[Pred]:
        F = self.transform.transform(np.ascontiguousarray(X, dtype=np.float64))
        if len(self.labels) == 1:
            return [Pred(self.labels[0], 1.0, [(self.labels[0], 1.0)]) for _ in range(len(F))]
        P = ridge_scores(self.clf.decision_function(F), len(self.labels))
        return [pred_from_scores(self.labels, p) for p in P]

    def params(self) -> dict[str, Any]:
        return {
            "nKernels": self.n_kernels,
            "seed": self.seed,
            "classifier": "StandardScaler(with_mean=False) + RidgeClassifierCV(logspace(-3,3,10))",
            "confidence": "ridge decision (d+1)/2 clipped, normalized",
        }
