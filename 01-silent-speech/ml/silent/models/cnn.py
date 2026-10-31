"""Tiny 1D CNN (torch, CPU): 3 conv blocks (conv, batch norm, ReLU), global average pooling,
dropout, linear. Trained with augmentation (time warp, shift, scaling, jitter), AdamW, label
smoothing, and early stopping on a stratified validation split of the training fold (best weights
restored). Seeded: same data + seed gives the same model.

Needs the optional extra: `uv sync --extra cnn`.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

import numpy as np
import torch
from torch import nn

from . import Model, Pred, pred_from_scores


class SmallCnn(nn.Module):
    def __init__(self, ch: int, n_classes: int, width: int = 16, dropout: float = 0.3):
        super().__init__()

        def block(i: int, o: int, k: int) -> nn.Sequential:
            return nn.Sequential(nn.Conv1d(i, o, k, padding=k // 2, bias=False), nn.BatchNorm1d(o), nn.ReLU())

        self.features = nn.Sequential(block(ch, width, 7), block(width, 2 * width, 5), block(2 * width, 2 * width, 3))
        self.head = nn.Sequential(nn.Dropout(dropout), nn.Linear(2 * width, n_classes))

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.head(self.features(x).mean(dim=-1))


def augment(
    x: torch.Tensor, g: torch.Generator, warp: float = 0.15, bend: float = 3.0, shift: int = 4, scale: float = 0.1, jitter: float = 0.03
) -> torch.Tensor:
    """x (B, ch, L), already normalized. Time warp (random stretch around the centre plus a smooth
    bend) and shift are one resampling with edge clamping; then per channel scaling and Gaussian jitter."""
    B, C, L = x.shape
    j = torch.arange(L, dtype=x.dtype)
    c = (L - 1) / 2
    stretch = 1 + (torch.rand(B, 1, generator=g) * 2 - 1) * warp
    bend_px = (torch.rand(B, 1, generator=g) * 2 - 1) * bend  # samples; small enough to stay monotone
    offs = torch.randint(-shift, shift + 1, (B, 1), generator=g).to(x.dtype)
    pos = (c + (j - c) * stretch + bend_px * torch.sin(torch.pi * j / (L - 1)) + offs).clamp(0, L - 1)
    i0 = pos.floor().long()
    i1 = (i0 + 1).clamp(max=L - 1)
    w = (pos - i0.to(x.dtype)).unsqueeze(1)
    x0 = torch.gather(x, 2, i0.unsqueeze(1).expand(B, C, L))
    x1 = torch.gather(x, 2, i1.unsqueeze(1).expand(B, C, L))
    out = x0 * (1 - w) + x1 * w
    out = out * (1 + scale * torch.randn(B, C, 1, generator=g))
    return out + jitter * torch.randn(B, C, L, generator=g)


def stratified_val(y: np.ndarray, frac: float, rng: np.random.Generator) -> np.ndarray:
    """Indices for validation: about `frac` of each class that has at least 3 clips (at least 1 each)."""
    val: list[int] = []
    for lab in np.unique(y):
        idx = np.flatnonzero(y == lab)
        if len(idx) >= 3:
            val.extend(rng.choice(idx, size=max(1, round(frac * len(idx))), replace=False).tolist())
    return np.array(sorted(val), dtype=np.int64)


class CnnModel(Model):
    name = "cnn"

    def __init__(
        self,
        seed: int = 0,
        width: int = 16,
        dropout: float = 0.3,
        lr: float = 3e-3,
        weight_decay: float = 1e-3,
        batch_size: int = 32,
        max_epochs: int = 300,
        patience: int = 40,
        val_frac: float = 0.15,
        augment: bool = True,
        threads: int = 1,
    ):
        self.seed = seed
        self.width = width
        self.dropout = dropout
        self.lr = lr
        self.weight_decay = weight_decay
        self.batch_size = batch_size
        self.max_epochs = max_epochs
        self.patience = patience
        self.val_frac = val_frac
        self.use_augment = augment
        self.threads = threads

    def fit(self, X: np.ndarray, y: Sequence[str]) -> CnnModel:
        torch.set_num_threads(self.threads)
        torch.manual_seed(self.seed)
        g = torch.Generator().manual_seed(self.seed)
        rng = np.random.default_rng(self.seed)
        self.labels = sorted(set(y))
        yi = np.array([self.labels.index(v) for v in y], dtype=np.int64)
        val = stratified_val(yi, self.val_frac, rng) if self.val_frac > 0 else np.array([], dtype=np.int64)
        tr = np.setdiff1d(np.arange(len(yi)), val)
        Xt = torch.tensor(np.asarray(X), dtype=torch.float32)
        Yt = torch.tensor(yi)
        self.net = SmallCnn(Xt.shape[1], len(self.labels), self.width, self.dropout)
        opt = torch.optim.AdamW(self.net.parameters(), lr=self.lr, weight_decay=self.weight_decay)
        loss_fn = nn.CrossEntropyLoss(label_smoothing=0.05)
        best, best_state, wait, self.epochs_run = float("inf"), None, 0, 0
        for epoch in range(self.max_epochs):
            self.net.train()
            perm = torch.from_numpy(tr)[torch.randperm(len(tr), generator=g)]
            for s in range(0, len(perm), self.batch_size):
                b = perm[s : s + self.batch_size]
                if len(b) < 2:  # batch norm needs 2+
                    continue
                xb = augment(Xt[b], g) if self.use_augment else Xt[b]
                opt.zero_grad()
                loss_fn(self.net(xb), Yt[b]).backward()
                opt.step()
            self.epochs_run = epoch + 1
            self.net.eval()
            with torch.no_grad():
                idx = torch.from_numpy(val if len(val) else tr)
                score = float(nn.functional.cross_entropy(self.net(Xt[idx]), Yt[idx]))
            if score < best - 1e-4:
                best, wait = score, 0
                best_state = {k: v.detach().clone() for k, v in self.net.state_dict().items()}
            else:
                wait += 1
                if wait >= self.patience:
                    break
        if best_state is not None:
            self.net.load_state_dict(best_state)
        self.net.eval()
        return self

    def predict(self, X: np.ndarray) -> list[Pred]:
        with torch.no_grad():
            P = torch.softmax(self.net(torch.tensor(np.asarray(X), dtype=torch.float32)), dim=1).numpy()
        return [pred_from_scores(self.labels, p) for p in P]

    def params(self) -> dict[str, Any]:
        return {
            "seed": self.seed,
            "arch": f"3x(conv k7/5/3, BN, ReLU) width {self.width}/{2 * self.width}/{2 * self.width}, GAP, dropout {self.dropout}, linear",
            "optimizer": f"AdamW lr {self.lr} wd {self.weight_decay}",
            "batchSize": self.batch_size,
            "maxEpochs": self.max_epochs,
            "patience": self.patience,
            "valFrac": self.val_frac,
            "augment": "time warp 15% + bend, shift 4, scale 10%, jitter 0.03" if self.use_augment else "off",
            "confidence": "softmax",
        }
