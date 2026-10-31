"""Benchmark one or more models with LOO / LOSO / cross bud and write ml/results/<model>/<protocol>.json
(PROTOCOL.md §6 Metrics) plus confusion_<protocol>.png. Synthetic data goes to ml/results/synthetic/.

  uv run python -m silent.bench --real --model all --protocol all          # Spiro's AirPods data + exclude list
  uv run python -m silent.bench --real --model dtw-py minirocket --protocol loso --permutations 500
  uv run python -m silent.bench --model dtw-py --protocol loso             # synthetic fixture (default data)

Protocols: loo (leave one clip out), loso (leave one session out, the headline), xbud (cross bud: train on
every left bud clip, test on every right bud clip; run with bud normalization on and off, both kept).
--permutations N (loso, dtw-py and minirocket): the luck test, see silent/luck.py.

Honest by construction: steps 0 to 4 of preprocessing are per clip; norm stats (step 5) and the model
are fit on the training fold only, then each test clip is predicted on its own (as live). inferMsPerClip
= that clip's preprocessing (steps 0 to 5) + predict time, averaged over the tested clips.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from collections.abc import Callable, Sequence
from dataclasses import replace
from pathlib import Path
from typing import Any

import numpy as np

from . import DEFAULT_DATA, EXCLUDE_FILE, PROJECT_DIR, RAW_DIR, RESULTS_DIR, SYNTHETIC_RESULTS_DIR
from .cv import Protocol, splits
from .data import Corpus, load_corpus
from .luck import LUCK_MODELS, luck_test
from .metrics import compute_metrics
from .models import MODEL_NAMES, Pred, make_model, torch_available
from .preprocess import DEFAULT_CHANNELS, DEFAULT_OPTS, PreOpts, apply_norm, fit_norm, preprocess_clip

PROTOCOLS: tuple[Protocol, ...] = ("loo", "loso", "xbud")
BUD_NORMS = ("mirror", "none")


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


def corpus_params(corpus: Corpus) -> dict[str, Any]:
    """What data a result was made from: files, sources, sessions, bud per session, the exclusion list."""
    return {
        "data": [_rel(p) for p in corpus.files],
        "datasets": [Path(p).name for p in corpus.files],  # same key as the JS eval-dtw
        "sources": corpus.sources,
        "subjects": corpus.subjects,
        "sessions": corpus.sessions,
        "buds": corpus.buds,
        "exclude": _rel(corpus.exclude_file) if corpus.exclude_file else None,
        "excludeIds": corpus.exclude_ids,
        "excluded": len(corpus.excluded),
        "excludedBySession": corpus.excluded_by_session,
        "duplicatesDropped": corpus.duplicates,
    }


def preprocess_corpus(corpus: Corpus, opts: PreOpts) -> tuple[np.ndarray, np.ndarray]:
    """Steps 0 to 4 for every clip (each with its own bud). Returns (X (n, ch, L), ms per clip)."""
    raw, ms = [], []
    for c in corpus.clips:
        t = time.perf_counter()
        raw.append(preprocess_clip(c.samples, opts, c.loc))
        ms.append((time.perf_counter() - t) * 1000)
    return np.stack(raw), np.array(ms)


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
    X, pre_ms = preprocess_corpus(corpus, opts)

    preds: list[Pred | None] = [None] * len(clips)
    infer_ms = np.zeros(len(clips))
    folds = list(splits(protocol, sessions, [c.loc for c in clips]))
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
    tested = np.unique(np.concatenate([te for _, te in folds]))
    assert all(preds[i] is not None for i in tested)
    if protocol != "xbud":
        assert len(tested) == len(clips)  # loo / loso test every clip exactly once

    per_session: dict[str, dict[str, int]] = {}
    for i in tested:
        r = per_session.setdefault(sessions[i], {"correct": 0, "n": 0})
        r["n"] += 1
        r["correct"] += int(preds[i].label == y[i])  # type: ignore[union-attr]
    params: dict[str, Any] = {
        **opts.as_params(),
        "threshold": threshold,
        **model_params,
        **corpus_params(corpus),
        "folds": len(folds),
        "perSession": dict(sorted(per_session.items())),
        "jobs": jobs,
        "timing": "single process" if jobs <= 1 else f"rough: {jobs} processes in parallel",
        "evalSec": round(time.perf_counter() - t_all, 2),
    }
    if protocol == "xbud":
        tr, te = folds[0]
        params["xbud"] = {
            "trainBud": "left", "testBud": "right",
            "trainSessions": sorted({sessions[i] for i in tr}), "testSessions": sorted({sessions[i] for i in te}),
            "nTrain": len(tr), "nTest": len(te),
        }
    y_t = [y[i] for i in tested]
    p_t = [preds[i] for i in tested]
    return compute_metrics(model, protocol, y_t, p_t, threshold, params, float(infer_ms[tested].mean()))  # type: ignore[arg-type]


def summary(m: dict[str, Any]) -> dict[str, Any]:
    """The numbers of a result without its params (kept inside another result, e.g. xbud variants)."""
    keep = ("nClips", "labels", "accuracy", "macroF1", "confusion", "noneFalseAcceptRate", "inferMsPerClip")
    return {**{k: m[k] for k in keep}, "correct": int(np.trace(np.array(m["confusion"]))), "perSession": m["params"].get("perSession")}


def cross_bud(
    corpus: Corpus, model: str, opts: PreOpts = DEFAULT_OPTS, threshold: float = 0.5, model_kw: dict[str, Any] | None = None,
    log: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    """xbud with bud normalization on (mirror) and off (raw). Returns the result for opts.bud_norm with
    `params.variants` = {"mirror": ..., "none": ...} holding the numbers of both."""
    runs = {bn: evaluate(corpus, model, "xbud", replace(opts, bud_norm=bn), threshold, model_kw, log) for bn in BUD_NORMS}
    m = runs[opts.bud_norm]
    m["params"]["variants"] = {bn: summary(r) for bn, r in runs.items()}
    return m


SEEDED_MODELS = ("minirocket", "cnn")  # dtw-py has no randomness


def seed_spread(
    corpus: Corpus, model: str, opts: PreOpts, threshold: float, model_kw: dict[str, Any], first: dict[str, Any], n: int,
    log: Callable[[str], None] | None = None, jobs: int = 1,
) -> dict[str, Any]:
    """The same evaluation with n seeds (the given one first, then the next ones): how much of a score is the seed.
    The headline stays the first seed, fixed before looking (no picking the best one)."""
    seed0 = model_kw.get("seed", 0)
    correct = [int(np.trace(np.array(first["confusion"])))]
    for s in range(seed0 + 1, seed0 + n):
        r = evaluate(corpus, model, first["protocol"], opts, threshold, {**model_kw, "seed": s}, jobs=jobs)
        correct.append(int(np.trace(np.array(r["confusion"]))))
        if log:
            log(f"  {model} {first['protocol']} seed {s}: {correct[-1]}/{r['nClips']}")
    acc = np.array(correct) / first["nClips"]
    return {
        "seeds": list(range(seed0, seed0 + n)), "correct": correct, "nClips": first["nClips"],
        "mean": float(acc.mean()), "min": float(acc.min()), "max": float(acc.max()),
    }


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
    what = {"xbud": "cross bud"}.get(metrics["protocol"], metrics["protocol"].upper())
    bud = f", budNorm {metrics['params'].get('budNorm')}" if metrics["protocol"] == "xbud" else ""
    ax.set_title(
        f"{metrics['model']} {what}{bud}  {int(np.trace(cm))}/{metrics['nClips']} correct"
        + ("\nSYNTHETIC data, not real AirPods" if synthetic else ""),
        fontsize=9,
    )
    fig.tight_layout()
    path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(path, bbox_inches="tight")
    plt.close(fig)


INK, INK_2, SERIES_1, SURFACE = "#0b0b0b", "#52514e", "#2a78d6", "#fcfcfb"


def plot_luck(metrics: dict[str, Any], path: Path) -> None:
    """Histogram of the shuffled label LOSO accuracies, with the real accuracy marked."""
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    perm = metrics["params"]["permutation"]
    n = perm["nClips"]
    hist = {int(k): v for k, v in perm["shuffledCorrectHistogram"].items()}
    pct = np.repeat(100 * np.array(list(hist)) / n, list(hist.values()))
    counts, edges = np.histogram(pct, bins=np.arange(0, 101, 1.0))  # 1 point wide bins
    fig, ax = plt.subplots(figsize=(6.4, 2.8), dpi=110, facecolor=SURFACE)
    ax.set_facecolor(SURFACE)
    ax.bar(edges[:-1] + 0.5, counts, width=0.8, color=SERIES_1, linewidth=0)
    real = 100 * perm["realAccuracy"]
    ax.axvline(real, color=INK, linewidth=2)
    ax.text(real, ax.get_ylim()[1] * 0.92, f" real {real:.1f}%\n ({perm['realCorrect']}/{n})", color=INK, fontsize=8, va="top",
            ha="right" if real > 85 else "left")
    mean = 100 * perm["shuffledMean"]
    ax.text(100 * perm["shuffledMax"] + 2, ax.get_ylim()[1] * 0.6, f"shuffled labels\nmean {mean:.1f}%", color=INK_2, fontsize=8, va="top")
    ax.set_xlim(0, 100)
    ax.set_xlabel("LOSO accuracy (%)", fontsize=8, color=INK_2)
    ax.set_ylabel("shuffles", fontsize=8, color=INK_2)
    ax.tick_params(labelsize=8, colors=INK_2)
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    p_txt = f"p = {perm['pValue']:.3f}" + (" (no shuffle reached it)" if perm["atLeastReal"] == 0 else "")
    ax.set_title(f"{metrics['model']} luck test: {perm['n']} label shuffles, {p_txt}", fontsize=9, color=INK)
    fig.tight_layout()
    path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(path, bbox_inches="tight", facecolor=SURFACE)
    plt.close(fig)


def write_result(metrics: dict[str, Any], out_dir: Path) -> Path:
    d = out_dir / metrics["model"]
    d.mkdir(parents=True, exist_ok=True)
    p = d / f"{metrics['protocol']}.json"
    p.write_text(json.dumps(metrics, indent=2) + "\n")
    plot_confusion(metrics, d / f"confusion_{metrics['protocol']}.png")
    if "permutation" in metrics["params"]:
        plot_luck(metrics, d / f"luck_{metrics['protocol']}.png")
    return p


def default_out(corpus: Corpus) -> Path:
    """Synthetic numbers never land next to the real ones."""
    return SYNTHETIC_RESULTS_DIR if corpus.synthetic else RESULTS_DIR


def unexcluded_raw(files: Sequence[str]) -> list[str]:
    """Data files that sit next to an exclude.json (data/raw/): running them without --exclude is a mistake."""
    return [f for f in files if (Path(f).resolve().parent / "exclude.json").exists()]


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
    ap.add_argument("--data", nargs="+", default=None, help="ss-dataset files (merged, deduped by clip id). Default: the synthetic fixture")
    ap.add_argument("--real", action="store_true", help="shortcut: --data data/raw/ss-dataset-*.json --exclude data/raw/exclude.json")
    ap.add_argument("--exclude", default=None, help="ss-exclude file: skip these clip ids (PROTOCOL §3)")
    ap.add_argument("--no-exclude", action="store_true", help="allow data/raw files without their exclude.json (not for published numbers)")
    ap.add_argument("--out", default=None, help="results folder (default ml/results, or ml/results/synthetic for synthetic data)")
    ap.add_argument("--channels", default=",".join(DEFAULT_CHANNELS))
    ap.add_argument("--L", type=int, default=64)
    ap.add_argument("--hp-hz", type=float, default=1.0)
    ap.add_argument("--norm", choices=["global", "clip"], default="global")
    ap.add_argument("--bud-norm", choices=list(BUD_NORMS), default="mirror", help="step 0: mirror right bud clips (default) or not")
    ap.add_argument("--threshold", type=float, default=0.5)
    ap.add_argument("--band", type=float, default=0.1, help="dtw-py Sakoe-Chiba band (fraction of L)")
    ap.add_argument("--k", type=int, default=1, help="dtw-py neighbours (PROTOCOL §6 default 1)")
    ap.add_argument("--kernels", type=int, default=10_000, help="minirocket kernels")
    ap.add_argument("--epochs", type=int, default=300, help="cnn max epochs")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--permutations", type=int, default=0, help="luck test with this many label shuffles (loso, dtw-py / minirocket)")
    ap.add_argument("--perm-seed", type=int, default=0)
    ap.add_argument("--seeds", type=int, default=1,
                    help="loso, minirocket / cnn: also run seeds seed+1 .. seed+N-1 and keep their accuracies (params.seedSpread)")
    ap.add_argument("--jobs", type=int, default=1, help="run folds in this many processes: same predictions, faster, but rough timings")
    a = ap.parse_args(argv)

    if a.real:
        if a.data:
            ap.error("--real and --data together")
        a.data = [str(p) for p in sorted(RAW_DIR.glob("ss-dataset-*.json"))]
        a.exclude = a.exclude or str(EXCLUDE_FILE)
    data = a.data or [str(DEFAULT_DATA)]
    if a.exclude is None and not a.no_exclude and unexcluded_raw(data):
        print("these files have an exclude.json next to them: pass --exclude <file> (or --no-exclude): " + ", ".join(unexcluded_raw(data)),
              file=sys.stderr)
        return 2
    models = _expand(a.model, MODEL_NAMES)
    if "cnn" in models and not torch_available():
        if "all" in a.model:
            print("cnn skipped: torch not installed (uv sync --extra cnn)", file=sys.stderr)
            models.remove("cnn")
        else:
            print("cnn needs torch: run `uv sync --extra cnn` in ml/", file=sys.stderr)
            return 2
    opts = PreOpts(
        channels=tuple(c.strip() for c in a.channels.split(",") if c.strip()), L=a.L, hp_hz=a.hp_hz, norm=a.norm, bud_norm=a.bud_norm,
    )
    corpus = load_corpus(data, exclude=a.exclude)
    out = Path(a.out) if a.out else default_out(corpus)
    print(
        f"{len(corpus.clips)} clips, {len(corpus.labels)} labels, sessions {corpus.sessions}, buds {corpus.buds}, "
        f"{corpus.duplicates} duplicate ids dropped, {len(corpus.excluded)} excluded"
    )
    kw = {
        "dtw-py": {"band": a.band, "k": a.k},
        "minirocket": {"n_kernels": a.kernels, "seed": a.seed},
        "cnn": {"seed": a.seed, "max_epochs": a.epochs},
    }
    protocols = _expand(a.protocol, PROTOCOLS)
    if "loso" in protocols and len(corpus.sessions) < 2:
        print(f"LOSO skipped: needs at least 2 sessions, got {corpus.sessions}", file=sys.stderr)
        protocols.remove("loso")
    if "xbud" in protocols and not {"left", "right"} <= {c.loc for c in corpus.clips}:
        print(f"cross bud skipped: needs left and right bud clips, got {corpus.buds}", file=sys.stderr)
        protocols.remove("xbud")
    log = lambda s: print(s, flush=True)
    for model in models:
        for protocol in protocols:
            t = time.perf_counter()
            if protocol == "xbud":
                m = cross_bud(corpus, model, opts, a.threshold, kw[model], log=log)
            else:
                m = evaluate(corpus, model, protocol, opts, a.threshold, kw[model], log=log, jobs=a.jobs)
            if protocol == "loso" and a.seeds > 1 and model in SEEDED_MODELS:
                m["params"]["seedSpread"] = seed_spread(corpus, model, opts, a.threshold, kw[model], m, a.seeds, log=log, jobs=a.jobs)
            if protocol == "loso" and a.permutations > 0:
                if model in LUCK_MODELS:
                    X, _ = preprocess_corpus(corpus, opts)
                    m["params"]["permutation"] = luck_test(
                        corpus, model, X, a.permutations, a.perm_seed, opts, kw[model], real=m, log=log
                    )
                else:
                    print(f"luck test skipped for {model} (only {', '.join(LUCK_MODELS)})", file=sys.stderr)
            p = write_result(m, out)
            extra = ""
            if "variants" in m["params"]:
                v = m["params"]["variants"]
                extra = f"  (raw {v['none']['accuracy']:.3f} vs mirrored {v['mirror']['accuracy']:.3f})"
            if "permutation" in m["params"]:
                pm = m["params"]["permutation"]
                extra = f"  luck: shuffled mean {pm['shuffledMean']:.3f}, max {pm['shuffledMax']:.3f}, p {pm['pValue']:.4f}"
            print(
                f"{model:>10} {protocol:<4}  acc {m['accuracy']:.3f} ({int(np.trace(np.array(m['confusion'])))}/{m['nClips']})  "
                f"macroF1 {m['macroF1']:.3f}  noneFA {m['noneFalseAcceptRate']:.3f}  infer {m['inferMsPerClip']:.2f} ms  "
                f"({time.perf_counter() - t:.1f} s){extra} -> {p}",
                flush=True,
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
