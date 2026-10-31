"""Luck test (idea from github.com/joeblau/subvox): could the LOSO accuracy be luck?

Run LOSO again n times (default 500) with the labels of the training clips shuffled inside each fold
(the test clips keep their true labels). A model that learned nothing real scores about chance there.
p value = (1 + number of shuffles that scored at least the real accuracy) / (n + 1), so the smallest
possible value with 500 shuffles is 1/501 = 0.002.

Exact and cheap, because nothing that does not depend on labels is recomputed:
- dtw-py: per fold, the norm stats and the test x train DTW distance matrix are computed once. A shuffle only
  changes which label each template carries; the label is the same k nearest vote as the model (dtw.classify).
- minirocket: per fold, the MiniRocket features (its fit never sees labels) and the StandardScaler are fit
  once. Each shuffle refits RidgeClassifierCV, the only part that sees labels.
The unshuffled run through this same path must give the bench's LOSO confusion matrix (checked, else it raises).
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from typing import Any

import numpy as np

from .cv import splits
from .data import Corpus
from .models.dtw import JS_DEFAULTS, as_f32, band_radius, classify, dtw_many
from .preprocess import DEFAULT_OPTS, PreOpts, apply_norm, fit_norm

LUCK_MODELS = ("dtw-py", "minirocket")
SCHEME = "LOSO; in every fold the training labels are shuffled (test labels stay true); same folds, norm and model settings"


def _norm_fold(X: np.ndarray, tr: np.ndarray, te: np.ndarray, norm: str) -> tuple[np.ndarray, list[np.ndarray]]:
    """Training clips normalized together, each test clip on its own (like bench.run_fold)."""
    stats = fit_norm(X[tr], norm)  # type: ignore[arg-type]
    return apply_norm(X[tr], stats), [apply_norm(X[i : i + 1], stats) for i in te]


class DtwFold:
    def __init__(self, X: np.ndarray, tr: np.ndarray, te: np.ndarray, norm: str, band: float = JS_DEFAULTS["band"], k: int = JS_DEFAULTS["k"], **_: Any):
        Xtr, Xte = _norm_fold(X, tr, te, norm)
        T = as_f32(Xtr)
        r = band_radius(band, T.shape[2])
        self.k = k
        self.D = np.stack([dtw_many(as_f32(x[0]), T, r) for x in Xte])  # (n_test, n_train)

    def predict(self, y_train: np.ndarray) -> list[str]:
        labels = sorted(set(y_train.tolist()))
        y_idx = np.array([labels.index(v) for v in y_train], dtype=np.int64)
        if self.k == 1:  # nearest template's label (first one on a tie), what classify gives for k = 1
            return [labels[j] for j in y_idx[np.argmin(self.D, axis=1)]]
        return [classify(d, y_idx, labels, self.k).label for d in self.D]


class RocketFold:
    def __init__(self, X: np.ndarray, tr: np.ndarray, te: np.ndarray, norm: str, n_kernels: int = 10_000, seed: int = 0, **_: Any):
        from .models.minirocket import as_series, make_classifier, make_transform

        Xtr, Xte = _norm_fold(X, tr, te, norm)
        tf = make_transform(n_kernels, seed)
        Ftr = tf.fit_transform(as_series(Xtr))
        pipe = make_classifier()
        self.scaler, self.ridge = pipe[0], pipe[-1]
        self.Str = self.scaler.fit_transform(Ftr)
        self.Ste = [self.scaler.transform(tf.transform(as_series(x))) for x in Xte]  # one clip at a time, like the bench

    def predict(self, y_train: np.ndarray) -> list[str]:
        from sklearn.base import clone

        from .models.minirocket import ridge_preds

        if len(set(y_train.tolist())) == 1:
            return [str(y_train[0])] * len(self.Ste)
        clf = clone(self.ridge).fit(self.Str, y_train)
        labels = [str(c) for c in clf.classes_]
        return [ridge_preds(labels, clf.decision_function(s))[0].label for s in self.Ste]


def fold_permutations(folds: Sequence[tuple[np.ndarray, np.ndarray]], n: int, seed: int) -> list[list[np.ndarray]]:
    """n shuffles, each one permutation of the training clips per fold. Same seed + folds = same shuffles."""
    rng = np.random.default_rng(seed)
    return [[rng.permutation(len(tr)) for tr, _ in folds] for _ in range(n)]


def luck_test(
    corpus: Corpus,
    model: str,
    X: np.ndarray,
    n: int = 500,
    seed: int = 0,
    opts: PreOpts = DEFAULT_OPTS,  # the opts X was made with (only .norm is used here)
    model_kw: dict[str, Any] | None = None,
    real: dict[str, Any] | None = None,
    log: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    """X = steps 0 to 4 of every clip of `corpus` (bench.preprocess_corpus with the same opts).
    real = the bench's LOSO Metrics for the same settings, to check the unshuffled path against it."""
    if model not in LUCK_MODELS:
        raise ValueError(f"luck test supports {LUCK_MODELS}, not {model!r}")
    y = np.array([c.label for c in corpus.clips], dtype=object)
    folds = list(splits("loso", [c.session for c in corpus.clips]))
    kw = dict(model_kw or {})
    make = DtwFold if model == "dtw-py" else RocketFold
    scorers = [make(X, tr, te, opts.norm, **kw) for tr, te in folds]

    def run(perm: list[np.ndarray] | None) -> tuple[int, list[str], list[str]]:
        y_true, y_pred = [], []
        for f, ((tr, te), sc) in enumerate(zip(folds, scorers)):
            y_tr = y[tr] if perm is None else y[tr][perm[f]]
            y_pred += sc.predict(y_tr)
            y_true += y[te].tolist()
        return sum(a == b for a, b in zip(y_true, y_pred)), y_true, y_pred

    real_correct, y_true, y_pred = run(None)
    n_clips = len(y_true)
    if real is not None:
        from .metrics import confusion

        cm = confusion(real["labels"], y_true, y_pred).tolist() if set(y_pred) <= set(real["labels"]) else None
        if real["nClips"] != n_clips or cm != real["confusion"]:
            raise RuntimeError(f"luck test: unshuffled {model} does not reproduce the bench LOSO result")
    shuffled = []
    for i, perm in enumerate(fold_permutations(folds, n, seed), 1):
        shuffled.append(run(perm)[0])
        if log and i % max(1, n // 10) == 0:
            log(f"  {model} luck test: {i}/{n} shuffles")
    s = np.array(shuffled, dtype=np.float64)
    at_least = int(np.sum(s >= real_correct))
    hist = {str(c): int(v) for c, v in zip(*np.unique(s.astype(int), return_counts=True))}
    return {
        "n": n,
        "seed": seed,
        "scheme": SCHEME,
        "nClips": n_clips,
        "realCorrect": int(real_correct),
        "realAccuracy": real_correct / n_clips,
        "shuffledMean": float(s.mean() / n_clips),
        "shuffledStd": float(s.std(ddof=0) / n_clips),
        "shuffledMin": float(s.min() / n_clips),
        "shuffledMax": float(s.max() / n_clips),
        "atLeastReal": at_least,
        "pValue": (1 + at_least) / (n + 1),
        "shuffledCorrectHistogram": hist,
    }
