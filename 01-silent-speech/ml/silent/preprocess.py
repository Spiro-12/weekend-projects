"""Preprocessing spec v1, PROTOCOL.md §5. Must match the JS version (web/src/ml) exactly.

Steps 1 to 4 only look at one clip, so `preprocess_clips` runs them once per clip. Step 5
(normalize) needs stats from the *training* fold: `fit_norm` on train, `apply_norm` on train and test.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Literal

import numpy as np
from scipy.signal import butter, filtfilt

GRID_HZ = 50  # contracts.ts GRID_HZ
DEFAULT_CHANNELS: tuple[str, ...] = ("rr.x", "rr.y", "rr.z", "ua.x", "ua.y", "ua.z")
STD_FLOOR = 1e-8
Norm = Literal["global", "clip"]
_AXES = {"x": 0, "y": 1, "z": 2}


@dataclass(frozen=True)
class PreOpts:
    channels: tuple[str, ...] = DEFAULT_CHANNELS
    L: int = 64
    hp_hz: float = 1.0  # high pass cutoff; 0 turns the filter off
    norm: Norm = "global"

    def as_params(self) -> dict[str, Any]:
        return {"channels": list(self.channels), "L": self.L, "hpHz": self.hp_hz, "norm": self.norm, "gridHz": GRID_HZ}


DEFAULT_OPTS = PreOpts()


@dataclass(frozen=True)
class NormStats:
    """global: per channel mean / std. clip: mean unused (zeros), std = per channel std floor."""

    mode: Norm
    mean: np.ndarray  # (ch,)
    std: np.ndarray  # (ch,)

    def to_json(self) -> dict[str, Any]:
        return {"mode": self.mode, "mean": self.mean.tolist(), "std": self.std.tolist()}


def _channel_getter(ch: str) -> tuple[str, int]:
    key, _, axis = ch.partition(".")
    if key not in ("rr", "ua", "g") or axis not in _AXES:
        raise ValueError(f"unknown channel {ch!r}")
    return key, _AXES[axis]


def to_grid(samples: Sequence[dict[str, Any]], channels: Sequence[str] = DEFAULT_CHANNELS) -> np.ndarray:
    """Step 1 + 2: sort by t, drop duplicate t (first kept), linear interpolation onto
    t_k = t_0 + k/50, k = 0 .. floor((t_last - t_0) * 50 + 1e-9). Returns (ch, n)."""
    getters = [_channel_getter(c) for c in channels]
    t = np.array([s["t"] for s in samples], dtype=np.float64)
    x = np.array([[s[k][i] for (k, i) in getters] for s in samples], dtype=np.float64).T.reshape(len(getters), len(t))
    order = np.argsort(t, kind="stable")
    t, x = t[order], x[:, order]
    keep = np.concatenate([[True], np.diff(t) > 0])
    t, x = t[keep], x[:, keep]
    if len(t) < 2:
        raise ValueError("clip needs at least 2 distinct timestamps")
    k_last = math.floor((t[-1] - t[0]) * GRID_HZ + 1e-9)
    grid = t[0] + np.arange(k_last + 1) / GRID_HZ
    return np.stack([np.interp(grid, t, row) for row in x])


def butter_highpass(hp_hz: float = 1.0) -> tuple[np.ndarray, np.ndarray]:
    """Step 3 coefficients: scipy.signal.butter(2, hp_hz, 'highpass', fs=50)."""
    b, a = butter(2, hp_hz, "highpass", fs=GRID_HZ)
    return np.asarray(b, dtype=np.float64), np.asarray(a, dtype=np.float64)


def highpass(x: np.ndarray, hp_hz: float = 1.0) -> np.ndarray:
    """Step 3: zero phase high pass per channel (last axis = time),
    filtfilt(b, a, x, padtype='odd', padlen=min(9, n-1)) with scipy's lfilter_zi initial conditions."""
    if hp_hz <= 0:
        return np.array(x, dtype=np.float64, copy=True)
    b, a = butter_highpass(hp_hz)
    n = x.shape[-1]
    return filtfilt(b, a, x, axis=-1, padtype="odd", padlen=min(9, n - 1))


def resample(x: np.ndarray, L: int = 64) -> np.ndarray:
    """Step 4: value at position j*(n-1)/(L-1), j = 0..L-1, linear interpolation. (ch, n) -> (ch, L)."""
    if L < 2:
        raise ValueError("L must be >= 2")
    n = x.shape[-1]
    pos = np.arange(L) * (n - 1) / (L - 1)
    idx = np.arange(n, dtype=np.float64)
    return np.stack([np.interp(pos, idx, row) for row in x])


def preprocess_clip(samples: Sequence[dict[str, Any]], opts: PreOpts = DEFAULT_OPTS) -> np.ndarray:
    """Steps 1 to 4 for one clip. Returns (ch, L), not normalized yet."""
    return resample(highpass(to_grid(samples, opts.channels), opts.hp_hz), opts.L)


def preprocess_clips(clips: Sequence[Any], opts: PreOpts = DEFAULT_OPTS) -> np.ndarray:
    """Steps 1 to 4 for many clips (objects with .samples, or raw sample lists). Returns (n, ch, L)."""
    out = [preprocess_clip(c.samples if hasattr(c, "samples") else c, opts) for c in clips]
    return np.stack(out) if out else np.zeros((0, len(opts.channels), opts.L))


def fit_norm(X: np.ndarray, mode: Norm = "global") -> NormStats:
    """Step 5 stats from training clips X (n, ch, L).
    global: per channel mean and population std (ddof 0) over every value of every clip, std floor 1e-8.
    clip: per channel std floor = 0.5 * median over clips of that clip's own std of the channel."""
    if X.ndim != 3 or X.shape[0] == 0:
        raise ValueError("fit_norm needs a non empty (n, ch, L) array")
    if mode == "global":
        mean = X.mean(axis=(0, 2))
        std = np.maximum(X.std(axis=(0, 2), ddof=0), STD_FLOOR)
        return NormStats("global", mean, std)
    if mode == "clip":
        floor = 0.5 * np.median(X.std(axis=2, ddof=0), axis=0)
        return NormStats("clip", np.zeros(X.shape[1]), floor)
    raise ValueError(f"unknown norm {mode!r}")


def apply_norm(X: np.ndarray, stats: NormStats) -> np.ndarray:
    """Step 5 applied to (n, ch, L) or (ch, L)."""
    if stats.mode == "global":
        return (X - stats.mean[:, None]) / stats.std[:, None]
    mean = X.mean(axis=-1, keepdims=True)
    # Own std, floored per channel. The extra 1e-8 only matters if a whole channel is flat (avoids 0/0).
    std = np.maximum(np.maximum(X.std(axis=-1, ddof=0, keepdims=True), stats.std[:, None]), STD_FLOOR)
    return (X - mean) / std
