"""Benchmark one or more models with LOO / LOSO and write ml/results/<model>/<protocol>.json
(PROTOCOL.md §6 Metrics) plus confusion_<protocol>.png.

  uv run python -m silent.bench --model dtw-py --protocol loso
  uv run python -m silent.bench --model all --protocol all --data ../data/raw/*.json

Honest by construction: steps 1 to 4 of preprocessing are per clip; norm stats (step 5) and the model
are fit on the training fold only, then each test clip is predicted on its own (as live). inferMsPerClip
= that clip's preprocessing (steps 1 to 5) + predict time, averaged over clips.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any

import numpy as np

from . import DEFAULT_DATA, PROJECT_DIR, RESULTS_DIR
from .cv import Protocol, splits
from .data import Corpus, load_corpus
from .metrics import compute_metrics
from .models import MODEL_NAMES, Pred, make_model, torch_available
from .preprocess import DEFAULT_CHANNELS, DEFAULT_OPTS, PreOpts, apply_norm, fit_norm, preprocess_clip

PROTOCOLS: tuple[Protocol, ...] = ("loo", "loso")


def _rel(p: str) -> str:
    try:
        return str(Path(p).resolve().relative_to(PROJECT_DIR))
    except ValueError:
        return Path(p).name


def run_fold(
    model: str, model_kw: dict[str, Any], norm: str, X: np.ndarray, y: np.ndarray, tr: np.ndarray, te: np.ndarray
) -> tuple[list[Pred], list[float], dict[str, Any]]:
    """Fit norm stats + model on train only, then predict each test clip on its own.
    Returns (preds, predict ms per test clip, model params). Top level so worker processes can run it."""
    stats = fit_norm(X[tr], norm)  # type: ignore[arg-type]
    m = make_model(model, **model_kw).fit(apply_norm(X[tr], stats), y[tr].tolist())
    preds, ms = [], []
    for i in te:
        t = time.perf_counter()
        preds.append(m.predict(apply_norm(X[i : i + 1], stats))[0])
        ms.append((time.perf_counter() - t) * 1000)
    return preds, ms, m.params()


def evaluate(
    corpus: Corpus,
    model: str,
    protocol: Protocol,
    opts: PreOpts = DEFAULT_OPTS,
    threshold: float = 0.5,
    model_kw: dict[str, Any] | None = None,
    log: Callable[[str], None] | None = None,
    jobs: int = 1,
) -> dict[str, Any]:
    model_kw = dict(model_kw or {})
    if model == "dtw-py":  # its confidence cap for unsafe models uses the threshold
        model_kw.setdefault("threshold", threshold)
    clips = corpus.clips
    y = np.array([c.label for c in clips], dtype=object)
    sessions = [c.session for c in clips]

    raw, pre_ms = [], []
    for c in clips:
        t = time.perf_counter()
        raw.append(preprocess_clip(c.samples, opts))
        pre_ms.append((time.perf_counter() - t) * 1000)
    X = np.stack(raw)

    preds: list[Pred | None] = [None] * len(clips)
    infer_ms = np.zeros(len(clips))
    folds = list(splits(protocol, sessions))
    t_all = time.perf_counter()
    model_params: dict[str, Any] = {}

    def collect(te: np.ndarray, out: tuple[list[Pred], list[float], dict[str, Any]], done: int) -> None:
        nonlocal model_params
        fold_preds, ms, model_params = out
        for i, p, t in zip(te, fold_preds, ms):
            preds[i] = p
            infer_ms[i] = pre_ms[i] + t
        if log and (len(folds) <= 10 or done % max(1, len(folds) // 10) == 0):
            log(f"  {model} {protocol}: {done}/{len(folds)} folds")

    if jobs > 1 and len(folds) > 1:
        import multiprocessing as mp
        from concurrent.futures import ProcessPoolExecutor, as_completed

        with ProcessPoolExecutor(max_workers=jobs, mp_context=mp.get_context("spawn")) as ex:
            futs = {ex.submit(run_fold, model, model_kw, opts.norm, X, y, tr, te): te for tr, te in folds}
            for done, fut in enumerate(as_completed(futs), 1):
                collect(futs[fut], fut.result(), done)
    else:
        for done, (tr, te) in enumerate(folds, 1):
            collect(te, run_fold(model, model_kw, opts.norm, X, y, tr, te), done)
    assert all(p is not None for p in preds)

    params: dict[str, Any] = {
        **opts.as_params(),
        "threshold": threshold,
        **model_params,
        "data": [_rel(p) for p in corpus.files],
        "datasets": [Path(p).name for p in corpus.files],  # same key as the JS eval-dtw
        "sources": corpus.sources,
        "subjects": corpus.subjects,
        "sessions": corpus.sessions,
        "folds": len(folds),
        "jobs": jobs,
        "timing": "single process" if jobs <= 1 else f"rough: {jobs} processes in parallel",
        "duplicatesDropped": corpus.duplicates,
        "evalSec": round(time.perf_counter() - t_all, 2),
    }
    return compute_metrics(model, protocol, y.tolist(), preds, threshold, params, float(infer_ms.mean()))  # type: ignore[arg-type]


def plot_confusion(metrics: dict[str, Any], path: Path) -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    cm = np.array(metrics["confusion"])
    labels = metrics["labels"]
    rows = cm.sum(axis=1, keepdims=True)
    frac = np.divide(cm, rows, out=np.zeros_like(cm, dtype=float), where=rows > 0)
    size = 1.6 + 0.55 * len(labels)
    fig, ax = plt.subplots(figsize=(size, size), dpi=110)
    ax.imshow(frac, cmap="Blues", vmin=0, vmax=1)
    for i in range(len(labels)):
        for j in range(len(labels)):
            if cm[i, j]:
                ax.text(j, i, str(cm[i, j]), ha="center", va="center", fontsize=9, color="white" if frac[i, j] > 0.6 else "#1f2937")
    ax.set_xticks(range(len(labels)), labels, rotation=45, ha="right", fontsize=8)
    ax.set_yticks(range(len(labels)), labels, fontsize=8)
    ax.set_xlabel("predicted")
    ax.set_ylabel("true")
    synthetic = "fake" in (metrics["params"].get("sources") or [])
    ax.set_title(
        f"{metrics['model']} {metrics['protocol'].upper()}  {int(np.trace(cm))}/{metrics['nClips']} correct"
        + ("\nSYNTHETIC data, not real AirPods" if synthetic else ""),
        fontsize=9,
    )
    fig.tight_layout()
    path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(path, bbox_inches="tight")
    plt.close(fig)


def write_result(metrics: dict[str, Any], out_dir: Path) -> Path:
    d = out_dir / metrics["model"]
    d.mkdir(parents=True, exist_ok=True)
    p = d / f"{metrics['protocol']}.json"
    p.write_text(json.dumps(metrics, indent=2) + "\n")
    plot_confusion(metrics, d / f"confusion_{metrics['protocol']}.png")
    return p


def _expand(values: Sequence[str], allowed: Sequence[str]) -> list[str]:
    out: list[str] = []
    for v in values:
        for x in allowed if v == "all" else [v]:
            if x not in out:
                out.append(x)
    return out


def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m silent.bench", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model", nargs="+", default=["dtw-py"], choices=[*MODEL_NAMES, "all"])
    ap.add_argument("--protocol", nargs="+", default=["loso"], choices=[*PROTOCOLS, "all"])
    ap.add_argument("--data", nargs="+", default=[str(DEFAULT_DATA)], help="ss-dataset files (merged, deduped by clip id)")
    ap.add_argument("--out", default=str(RESULTS_DIR), help="results folder (default ml/results)")
    ap.add_argument("--channels", default=",".join(DEFAULT_CHANNELS))
    ap.add_argument("--L", type=int, default=64)
    ap.add_argument("--hp-hz", type=float, default=1.0)
    ap.add_argument("--norm", choices=["global", "clip"], default="global")
    ap.add_argument("--threshold", type=float, default=0.5)
    ap.add_argument("--band", type=float, default=0.1, help="dtw-py Sakoe-Chiba band (fraction of L)")
    ap.add_argument("--k", type=int, default=1, help="dtw-py neighbours (PROTOCOL §6 default 1)")
    ap.add_argument("--kernels", type=int, default=10_000, help="minirocket kernels")
    ap.add_argument("--epochs", type=int, default=300, help="cnn max epochs")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--jobs", type=int, default=1, help="run folds in this many processes: same predictions, faster, but rough timings")
    a = ap.parse_args(argv)

    models = _expand(a.model, MODEL_NAMES)
    if "cnn" in models and not torch_available():
        if "all" in a.model:
            print("cnn skipped: torch not installed (uv sync --extra cnn)", file=sys.stderr)
            models.remove("cnn")
        else:
            print("cnn needs torch: run `uv sync --extra cnn` in ml/", file=sys.stderr)
            return 2
    opts = PreOpts(channels=tuple(c.strip() for c in a.channels.split(",") if c.strip()), L=a.L, hp_hz=a.hp_hz, norm=a.norm)
    corpus = load_corpus(a.data)
    print(f"{len(corpus.clips)} clips, {len(corpus.labels)} labels, sessions {corpus.sessions}, {corpus.duplicates} duplicate ids dropped")
    kw = {
        "dtw-py": {"band": a.band, "k": a.k},
        "minirocket": {"n_kernels": a.kernels, "seed": a.seed},
        "cnn": {"seed": a.seed, "max_epochs": a.epochs},
    }
    protocols = _expand(a.protocol, PROTOCOLS)
    if "loso" in protocols and len(corpus.sessions) < 2:
        print(f"LOSO skipped: needs at least 2 sessions, got {corpus.sessions}", file=sys.stderr)
        protocols.remove("loso")
    for model in models:
        for protocol in protocols:
            t = time.perf_counter()
            m = evaluate(corpus, model, protocol, opts, a.threshold, kw[model], log=lambda s: print(s, flush=True), jobs=a.jobs)
            p = write_result(m, Path(a.out))
            print(
                f"{model:>10} {protocol:<4}  acc {m['accuracy']:.3f}  macroF1 {m['macroF1']:.3f}  "
                f"noneFA {m['noneFalseAcceptRate']:.3f}  infer {m['inferMsPerClip']:.2f} ms  "
                f"({time.perf_counter() - t:.1f} s) -> {p}",
                flush=True,
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
