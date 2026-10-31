"""`Metrics` JSON (PROTOCOL.md §6, contracts.ts `Metrics`), shared with the JS `evaluate`."""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Any

import numpy as np

from . import NONE
from .models import Pred

METRICS_KEYS = (
    "model", "protocol", "nClips", "labels", "accuracy", "macroF1", "confusion",
    "noneFalseAcceptRate", "params", "inferMsPerClip", "generatedAt",
)


def now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def accepted(p: Pred, threshold: float) -> bool:
    return p.label != NONE and p.confidence >= threshold


def confusion(labels: Sequence[str], y_true: Sequence[str], y_pred: Sequence[str]) -> np.ndarray:
    """rows = true, cols = predicted, both in `labels` order."""
    pos = {lab: i for i, lab in enumerate(labels)}
    cm = np.zeros((len(labels), len(labels)), dtype=np.int64)
    for t, p in zip(y_true, y_pred):
        cm[pos[t], pos[p]] += 1
    return cm


def macro_f1(cm: np.ndarray) -> float:
    """Mean over labels of F1 = 2tp / (2tp + fp + fn) (sklearn macro). Labels = true or predicted, so denom > 0;
    the guard only matters for a hand made matrix."""
    tp = np.diag(cm).astype(np.float64)
    fp = cm.sum(axis=0) - tp
    fn = cm.sum(axis=1) - tp
    denom = 2 * tp + fp + fn
    used = denom > 0
    return float(np.mean(2 * tp[used] / denom[used])) if used.any() else 0.0


def compute_metrics(
    model: str,
    protocol: str,
    y_true: Sequence[str],
    preds: Sequence[Pred],
    threshold: float,
    params: dict[str, Any],
    infer_ms_per_clip: float,
) -> dict[str, Any]:
    y_pred = [p.label for p in preds]
    labels = sorted(set(y_true) | set(y_pred))  # same as the JS metricsFrom
    cm = confusion(labels, y_true, y_pred)
    n = len(y_true)
    none_idx = [i for i, t in enumerate(y_true) if t == NONE]
    nfa = sum(accepted(preds[i], threshold) for i in none_idx) / len(none_idx) if none_idx else 0.0
    return {
        "model": model,
        "protocol": protocol,
        "nClips": n,
        "labels": labels,
        "accuracy": float(np.trace(cm) / n) if n else 0.0,
        "macroF1": macro_f1(cm),
        "confusion": cm.tolist(),
        "noneFalseAcceptRate": float(nfa),
        "params": params,
        "inferMsPerClip": float(infer_ms_per_clip),
        "generatedAt": now_iso(),
    }


def validate_metrics(m: Any) -> list[str]:
    """Shape check for a Metrics JSON (ours or the JS one). Empty list = valid."""
    if not isinstance(m, dict):
        return ["not an object"]
    errs = [f"missing {k}" for k in METRICS_KEYS if k not in m]
    if errs:
        return errs
    num = lambda x: isinstance(x, (int, float)) and not isinstance(x, bool)
    if m["protocol"] not in ("loo", "loso"):
        errs.append("protocol must be loo or loso")
    for k in ("nClips", "accuracy", "macroF1", "noneFalseAcceptRate", "inferMsPerClip"):
        if not num(m[k]):
            errs.append(f"{k} must be a number")
    labs, cm = m["labels"], m["confusion"]
    if not isinstance(labs, list) or not all(isinstance(x, str) for x in labs):
        errs.append("labels must be strings")
    elif not (isinstance(cm, list) and len(cm) == len(labs) and all(isinstance(r, list) and len(r) == len(labs) for r in cm)):
        errs.append("confusion must be labels x labels")
    elif num(m["nClips"]) and sum(sum(r) for r in cm) != m["nClips"]:
        errs.append("confusion must sum to nClips")
    if not isinstance(m["params"], dict):
        errs.append("params must be an object")
    if not isinstance(m["model"], str) or not isinstance(m["generatedAt"], str):
        errs.append("model / generatedAt must be strings")
    return errs
