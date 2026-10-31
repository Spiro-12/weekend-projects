"""Model interface shared by the bench. Inputs are preprocessed and normalized (n, ch, L) arrays."""

from __future__ import annotations

import importlib.util
from abc import ABC, abstractmethod
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any

import numpy as np


@dataclass(frozen=True)
class Pred:
    label: str
    confidence: float  # 0..1
    top: list[tuple[str, float]]  # up to 3, score desc


class Model(ABC):
    name: str

    @abstractmethod
    def fit(self, X: np.ndarray, y: Sequence[str]) -> Model: ...

    @abstractmethod
    def predict(self, X: np.ndarray) -> list[Pred]: ...

    @abstractmethod
    def params(self) -> dict[str, Any]: ...


def pred_from_scores(labels: Sequence[str], scores: np.ndarray) -> Pred:
    """scores: non negative, one per label, summing to 1. Ties go to the earlier label."""
    order = np.argsort(-np.asarray(scores, dtype=np.float64), kind="stable")
    top = [(labels[i], float(scores[i])) for i in order[:3]]
    return Pred(label=top[0][0], confidence=top[0][1], top=top)


def torch_available() -> bool:
    return importlib.util.find_spec("torch") is not None


def make_model(name: str, **kw: Any) -> Model:
    if name == "dtw-py":
        from .dtw import DtwKnn

        return DtwKnn(**kw)
    if name == "minirocket":
        from .minirocket import MiniRocketRidge

        return MiniRocketRidge(**kw)
    if name == "cnn":
        if not torch_available():
            raise RuntimeError("cnn needs torch: run `uv sync --extra cnn` in ml/")
        from .cnn import CnnModel

        return CnnModel(**kw)
    raise ValueError(f"unknown model {name!r}")


MODEL_NAMES = ("dtw-py", "minirocket", "cnn")
ModelFactory = Callable[[], Model]
