"""Build ml/RESULTS.md from ml/results/*/*.json (real data: Python models and the JS `dtw-knn`) and
ml/results/synthetic/*/*.json (synthetic fixture). Real AirPods data first, synthetic after, never mixed.

  uv run python -m silent.report [--exclude ../data/raw/exclude.json]

--exclude (default data/raw/exclude.json): real data results that did not skip exactly these clip ids are
flagged, so a published number can't quietly include the bad takes.
"""

from __future__ import annotations

import argparse
import json
import os
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from . import EXCLUDE_FILE, ML_DIR, NONE, PROJECT_DIR, RESULTS_DIR
from .data import DatasetError, load_exclude
from .metrics import validate_metrics

MODEL_ORDER = ["dtw-knn", "dtw-py", "minirocket", "cnn"]
PROTOCOL_ORDER = ["loso", "loo", "xbud"]
AGREE_POINTS = 5.0  # JS and Python DTW must agree within this many accuracy points
FIXTURES_DIR = PROJECT_DIR / "shared" / "fixtures"
# Settings that must match before the JS and Python DTW numbers can be compared.
DTW_KEYS = ("L", "band", "k", "norm", "channels", "hpHz", "threshold")
SYNTHETIC_BANNER = "> **Synthetic fixture, not real AirPods data.**"


def datasets(m: dict[str, Any]) -> list[str]:
    """Dataset file names of a result. Python writes `data` (paths) + `datasets`, the JS writes `datasets` (names)."""
    p = m["params"]
    d = p.get("datasets") or p.get("data") or []
    return sorted(Path(str(x)).name for x in d) if isinstance(d, list) else []


def is_synthetic(m: dict[str, Any]) -> bool:
    p = m["params"]
    if "fake" in (p.get("sources") or []) or "synthetic" in (p.get("subjects") or []):
        return True
    fixtures = {f.name for f in FIXTURES_DIR.glob("*.json")}
    return any(n in fixtures or "synthetic" in n for n in datasets(m))


def correct(m: dict[str, Any]) -> int:
    return sum(row[i] for i, row in enumerate(m["confusion"]))


def none_counts(m: dict[str, Any]) -> tuple[int, int]:
    """(accepted none clips, none clips): the counts behind noneFalseAcceptRate."""
    if NONE not in m["labels"]:
        return 0, 0
    n = sum(m["confusion"][m["labels"].index(NONE)])
    return round(m["noneFalseAcceptRate"] * n), n


def excluded_ids(m: dict[str, Any]) -> list[str] | None:
    """The exclusion list a result was made with: Python `excludeIds`; a JS result may keep the ids in `exclude`."""
    p = m["params"]
    for k in ("excludeIds", "exclude"):
        v = p.get(k)
        if isinstance(v, list) and all(isinstance(x, str) for x in v):
            return v
    return None


def exclusion_problem(m: dict[str, Any], ids: Sequence[str] | None) -> str | None:
    """Why a real data result does not match the exclusion list (None = it does, or there is no list)."""
    if ids is None:
        return None
    got = excluded_ids(m)
    if got is None:
        return "made without the exclusion list" if m["params"].get("excluded") in (0, None) else "exclusion list not recorded"
    if set(got) != set(ids):
        return "made with a different exclusion list"
    return None


def _result_files(results_dir: Path) -> list[Path]:
    return sorted(results_dir.glob("*/*.json")) + sorted(results_dir.glob("synthetic/*/*.json"))


def load_results(results_dir: Path) -> tuple[list[dict[str, Any]], list[str]]:
    """Returns (valid results sorted dataset x model x protocol, problems). Each result gets a `_path`.
    The same result found twice (a copy, same generatedAt) is kept once."""
    found, problems, seen = [], [], set()
    for p in _result_files(results_dir):
        try:
            m = json.loads(p.read_text())
        except (OSError, json.JSONDecodeError) as e:
            problems.append(f"`{p.relative_to(results_dir)}`: {e}")
            continue
        errs = validate_metrics(m)
        if errs:
            problems.append(f"`{p.relative_to(results_dir)}`: {'; '.join(errs[:3])}")
            continue
        key = (m["model"], m["protocol"], m["generatedAt"], m["nClips"], tuple(datasets(m)))
        if key in seen:
            continue
        seen.add(key)
        m["_path"] = p
        found.append(m)

    def order(m: dict[str, Any]) -> tuple[list[str], int, str, int]:
        mo = MODEL_ORDER.index(m["model"]) if m["model"] in MODEL_ORDER else len(MODEL_ORDER)
        po = PROTOCOL_ORDER.index(m["protocol"]) if m["protocol"] in PROTOCOL_ORDER else 9
        return datasets(m), mo, m["model"], po

    return sorted(found, key=order), problems


def _pct(x: float) -> str:
    return f"{100 * x:.1f}%"


def _frac(c: int, n: int) -> str:
    return f"{_pct(c / n) if n else '?'} ({c}/{n})"


def _names(m: dict[str, Any]) -> str:
    d = datasets(m)
    return ", ".join(f"`{x}`" for x in d) if d else "?"


def _ms(m: dict[str, Any]) -> str:
    rough = str(m["params"].get("timing", "")).startswith("rough")
    return f"{'~' if rough else ''}{m['inferMsPerClip']:.1f}"


def _model(m: dict[str, Any]) -> str:
    return "dtw-knn (JS)" if m["model"] == "dtw-knn" else m["model"]


def _nfa(m: dict[str, Any]) -> str:
    a, n = none_counts(m)
    return f"{_pct(m['noneFalseAcceptRate'])} ({a}/{n})" if n else "n/a"


def _confusion_table(m: dict[str, Any]) -> list[str]:
    labs = m["labels"]
    out = ["| true \\ pred | " + " | ".join(labs) + " |", "|---" * (len(labs) + 1) + "|"]
    for lab, row in zip(labs, m["confusion"]):
        out.append(f"| **{lab}** | " + " | ".join(str(v) if v else "." for v in row) + " |")
    return out


def _has_right_bud(m: dict[str, Any]) -> bool:
    return "right" in (m["params"].get("buds") or {}).values()


def comparable(js: dict[str, Any], py: dict[str, Any]) -> list[str]:
    """Why two results can't be compared. Empty = same data and same DTW settings."""
    why = []
    if js["nClips"] != py["nClips"]:
        why.append(f"clips {js['nClips']} vs {py['nClips']}")
    if datasets(js) != datasets(py):
        why.append(f"data {datasets(js) or '?'} vs {datasets(py) or '?'}")
    keys = DTW_KEYS + (("budNorm",) if _has_right_bud(py) or _has_right_bud(js) else ())  # budNorm only matters with right bud clips
    for k in keys:
        a, b = js["params"].get(k), py["params"].get(k)
        if a != b:
            why.append(f"{k} {a} vs {b}")
    a, b = excluded_ids(js), excluded_ids(py)
    if a is not None and b is not None and set(a) != set(b):
        why.append("different exclusion lists")
    return why


def _groups(results: Sequence[dict[str, Any]]) -> list[tuple[str, ...]]:
    return list(dict.fromkeys(tuple(datasets(m)) for m in results))


def _highest(results: Sequence[dict[str, Any]], protocols: Sequence[str] = ("loso", "loo")) -> list[str]:
    lines = []
    for g in _groups(results):
        for proto in protocols:
            rows = [m for m in results if tuple(datasets(m)) == g and m["protocol"] == proto]
            if not rows:
                continue
            top = max(correct(m) for m in rows)
            winners = [m for m in rows if correct(m) == top]
            w = winners[0]
            names = " and ".join(f"**{m['model']}**" for m in winners) + (" (tie)" if len(winners) > 1 else "")
            data = ", ".join(f"`{x}`" for x in g) or "?"
            lines.append(f"- Highest {proto.upper()} on {data}: {names}, {top}/{w['nClips']} correct ({_pct(w['accuracy'])}).")
    return lines


def _cross_check(results: Sequence[dict[str, Any]]) -> list[str]:
    rows = []
    for proto in ("loso", "loo"):
        for js in [m for m in results if m["model"] == "dtw-knn" and m["protocol"] == proto]:
            for py in [m for m in results if m["model"] == "dtw-py" and m["protocol"] == proto]:
                why = comparable(js, py)
                head = f"| {proto.upper()} | {_names(py)} | {_frac(correct(js), js['nClips'])} | {_frac(correct(py), py['nClips'])} |"
                nfa = f" {_pct(js['noneFalseAcceptRate'])} | {_pct(py['noneFalseAcceptRate'])} |"
                if why:
                    rows.append(f"{head} |{nfa} not comparable: {'; '.join(why)} |")
                    continue
                gap = 100 * abs(js["accuracy"] - py["accuracy"])
                same = js["labels"] == py["labels"] and js["confusion"] == py["confusion"]
                ok = "yes" if gap <= AGREE_POINTS else "**NO**"
                rows.append(f"{head} {gap:.1f} |{nfa} {ok}{', same confusion matrix' if same else ''} |")
    if not rows:
        return ["Needs both `dtw-knn` (JS, `scripts/eval-dtw.ts`) and `dtw-py` results on the same data and protocol.", ""]
    return [
        "Same data and the same settings (L, band, k, norm, channels, hpHz, threshold, and budNorm when there are right bud",
        "clips) are checked first.",
        "",
        "| Protocol | Data | Accuracy JS | Accuracy Python | Gap (points) | None FA JS | None FA Python | Within 5? |",
        "|---|---|---:|---:|---:|---:|---:|---|",
        *rows,
        "",
    ]


def _confusions(results: Sequence[dict[str, Any]], out_path: Path, level: int = 4) -> list[str]:
    lines = ["Rows = true label, columns = predicted.", ""]
    for model in dict.fromkeys(m["model"] for m in results):
        lines += [f"{'#' * level} {model}", ""]
        for m in [r for r in results if r["model"] == model]:
            img = m["_path"].parent / f"confusion_{m['protocol']}.png"
            if img.exists():
                rel = os.path.relpath(img, out_path.parent).replace(os.sep, "/")
                lines += [f"![{model} {m['protocol']}]({rel})", ""]
            else:
                lines += [f"**{m['protocol'].upper()}**", "", *_confusion_table(m), ""]
    return lines


def _sessions_table(group: Sequence[dict[str, Any]]) -> list[str]:
    """Sessions, bud and clip counts, from the first Python LOSO result of the group."""
    src = next((m for m in group if m["protocol"] == "loso" and m["params"].get("perSession")), None)
    if src is None:
        return []
    p = src["params"]
    buds, per, ex = p.get("buds") or {}, p["perSession"], p.get("excludedBySession") or {}
    lines = ["| Session | Sensor bud | Clips used | Skipped (exclusion list) |", "|---|---|---:|---:|"]
    for s in sorted(per):
        b = buds.get(s, "?")
        lines.append(f"| {s} | {'**' + b + '**' if b == 'right' else b} | {per[s]['n']} | {ex.get(s, 0)} |")
    lines += [f"| **all** | | **{src['nClips']}** | {p.get('excluded', 0)} |", ""]
    labels = src["labels"]
    lines += [f"{len(labels)} classes ({', '.join(f'`{x}`' for x in labels)}), so chance is about {_pct(1 / len(labels))}.", ""]
    return lines


def _session_cols(group: Sequence[dict[str, Any]]) -> list[tuple[str, str]]:
    sessions: dict[str, str] = {}
    for m in group:
        for s in m["params"].get("perSession") or {}:
            sessions.setdefault(s, (m["params"].get("buds") or {}).get(s, "?"))
    return sorted(sessions.items())


def _seeds(m: dict[str, Any]) -> str:
    sp = m["params"].get("seedSpread")
    if not sp:
        return "no randomness" if m["model"] in ("dtw-py", "dtw-knn") else "?"
    return f"{_pct(sp['mean'])} ({_pct(sp['min'])} to {_pct(sp['max'])})"


def _loso_table(rows: Sequence[dict[str, Any]], cols: Sequence[tuple[str, str]]) -> list[str]:
    seeds = next((m["params"]["seedSpread"]["seeds"] for m in rows if m["params"].get("seedSpread")), None)
    seed_col = [f"Seeds {seeds[0]} to {seeds[-1]}: mean (range)"] if seeds else []
    head = (
        "| Model | Accuracy | Macro F1 | " + " | ".join(f"test {s} ({b} bud)" for s, b in cols) + " | "
        + "".join(f"{c} | " for c in seed_col) + "None false accept | Infer ms/clip |"
    )
    lines = [head, "|---|---:|---:|" + "---:|" * (len(cols) + len(seed_col)) + "---:|---:|"]
    for m in rows:
        per = m["params"].get("perSession") or {}
        cells = [_frac(per[s]["correct"], per[s]["n"]) if s in per else "?" for s, _ in cols] + ([_seeds(m)] if seeds else [])
        lines.append(
            f"| {_model(m)} | {_frac(correct(m), m['nClips'])} | {m['macroF1']:.3f} | " + " | ".join(cells) + f" | {_nfa(m)} | {_ms(m)} |"
        )
    if seeds:
        lines += [
            "",
            f"Accuracy is the first seed ({seeds[0]}), fixed before the run. MiniRocket and the CNN are random (kernels, weights), so the",
            "seed column shows the same LOSO with other seeds: differences of a few points between models are within that spread.",
        ]
    return lines + [""]


def _loo_table(rows: Sequence[dict[str, Any]]) -> list[str]:
    lines = ["| Model | Accuracy | Macro F1 | None false accept | Infer ms/clip |", "|---|---:|---:|---:|---:|"]
    for m in rows:
        lines.append(f"| {_model(m)} | {_frac(correct(m), m['nClips'])} | {m['macroF1']:.3f} | {_nfa(m)} | {_ms(m)} |")
    return lines + [""]


def _xbud_table(rows: Sequence[dict[str, Any]]) -> list[str]:
    x = rows[0]["params"].get("xbud") or {}
    train = " + ".join(x.get("trainSessions", [])) or "?"
    test = " + ".join(x.get("testSessions", [])) or "?"
    lines = [
        f"Train on every {x.get('trainBud', 'left')} bud clip ({train}), test on every {x.get('testBud', 'right')} bud clip ({test}).",
        "**Raw** = the right bud clips as recorded. **Mirrored** = bud normalization on (PROTOCOL §5 step 0: right bud",
        "motion mirrored into the left bud frame; the default everywhere, so this is also the LOSO fold that tests that session).",
        "",
        "| Model | Raw | Mirrored | Gain (points) |",
        "|---|---:|---:|---:|",
    ]
    for m in rows:
        v = m["params"].get("variants") or {}
        raw, mir = v.get("none"), v.get("mirror")
        if not raw or not mir:
            continue
        gain = 100 * (mir["accuracy"] - raw["accuracy"])
        lines.append(f"| {_model(m)} | {_frac(raw['correct'], raw['nClips'])} | {_frac(mir['correct'], mir['nClips'])} | {gain:+.1f} |")
    return lines + [""]


def _luck_table(rows: Sequence[dict[str, Any]], out_path: Path) -> list[str]:
    n = rows[0]["params"]["permutation"]["n"]
    lines = [
        f"Could the LOSO accuracy be luck? Each model is run through the same LOSO folds {n} more times with the",
        "training labels shuffled inside every fold (the test labels stay true). Shuffled models score about chance.",
        "p value = (1 + shuffles that reached the real accuracy) / (shuffles + 1). Idea from github.com/joeblau/subvox.",
        "",
        "| Model | Real LOSO | Shuffled labels: mean (sd) | Best shuffle | Shuffles at or above real | p value |",
        "|---|---:|---:|---:|---:|---:|",
    ]
    imgs = []
    for m in rows:
        pm = m["params"]["permutation"]
        lines.append(
            f"| {_model(m)} | {_frac(pm['realCorrect'], pm['nClips'])} | {_pct(pm['shuffledMean'])} ({100 * pm['shuffledStd']:.1f}) | "
            f"{_pct(pm['shuffledMax'])} | {pm['atLeastReal']} of {pm['n']} | {pm['pValue']:.3f} |"
        )
        img = m["_path"].parent / "luck_loso.png"
        if img.exists():
            imgs += [f"![{m['model']} luck test]({os.path.relpath(img, out_path.parent).replace(os.sep, '/')})", ""]
    return lines + [""] + imgs


def _settings(m: dict[str, Any]) -> str:
    p = m["params"]
    pre = f"L {p.get('L')}, {len(p.get('channels') or [])} channels, high pass {p.get('hpHz')} Hz, {p.get('norm')} norm, budNorm {p.get('budNorm')}"
    extra = {
        "dtw-knn": f"band {p.get('band')}, k {p.get('k')}",
        "dtw-py": f"band {p.get('band')}, k {p.get('k')}",
        "minirocket": f"{p.get('nKernels')} kernels, seed {p.get('seed')}",
        "cnn": f"max {p.get('maxEpochs')} epochs, seed {p.get('seed')}",
    }.get(m["model"], "")
    return f"{pre}; {extra}" if extra else pre


def _settings_lines(group: Sequence[dict[str, Any]]) -> list[str]:
    seen: dict[str, str] = {}
    for m in group:
        if m["protocol"] == "loso":
            seen.setdefault(m["model"], _settings(m))
    return ["Settings (LOSO runs): " + "; ".join(f"**{k}**: {v}" for k, v in seen.items()) + ".", ""] if seen else []


def _real_section(group: Sequence[dict[str, Any]], out_path: Path, ids: Sequence[str] | None) -> list[str]:
    lines = [f"### Data: {_names(group[0])}", "", *_sessions_table(group), *_settings_lines(group)]
    for m in group:
        why = exclusion_problem(m, ids)
        if why:
            lines += [f"**Warning:** `{m['_path'].parent.name}/{m['_path'].name}` was {why}.", ""]
    by = {p: [m for m in group if m["protocol"] == p] for p in PROTOCOL_ORDER}
    if by["loso"]:
        lines += [
            "#### Leave one session out (the headline)",
            "",
            "Train on the other sessions, test on a whole new one: the closest thing to real use. Each test column is one fold.",
            "",
            *_loso_table(by["loso"], _session_cols(by["loso"])),
            *_highest(by["loso"], ("loso",)),
            "",
        ]
    if by["xbud"]:
        lines += ["#### Cross bud", "", *_xbud_table(by["xbud"])]
    lucky = [m for m in by["loso"] if "permutation" in m["params"]]
    if lucky:
        lines += ["#### Luck test", "", *_luck_table(lucky, out_path)]
    if by["loo"]:
        lines += [
            "#### Leave one clip out",
            "",
            "Train on every other clip, including takes from the same sitting, so it is optimistic. Shown for completeness.",
            "",
            *_loo_table(by["loo"]),
        ]
    lines += ["#### JS vs Python DTW cross check", "", *_cross_check(group)]
    lines += ["#### Confusion matrices", "", *_confusions(group, out_path, 5)]
    return lines


def render(results: Sequence[dict[str, Any]], out_path: Path, problems: Sequence[str] = (), exclude_ids: Sequence[str] | None = None) -> str:
    real = [m for m in results if not is_synthetic(m)]
    synth = [m for m in results if is_synthetic(m)]
    lines = [
        "# Silent Speech: model benchmark",
        "",
        "Made by `uv run python -m silent.report` from `ml/results/` (real data) and `ml/results/synthetic/` (synthetic",
        "fixture). Don't edit by hand. Rerun: `uv run python -m silent.bench --real --model all --protocol all`, then",
        "`uv run python -m silent.bench --real --model dtw-py minirocket --protocol loso --permutations 500` (luck test).",
        "",
        "- **LOSO** = leave one session out (train on the other sessions, test on a new one: closest to real use, so the",
        "  number that matters). **LOO** = leave one clip out. **Cross bud** = train on one AirPod, test on the other.",
        "- **None false accept** = share of true `none` clips the model accepted as an action (label is not `none` and",
        "  confidence >= the 0.5 threshold). Each model family has its own confidence scale (DTW: vote x separation,",
        "  MiniRocket: mapped ridge scores, CNN: softmax), so at a fixed 0.5 this column is **not comparable across",
        "  model families**.",
        "- **Infer ms** = per clip, preprocessing + predict, one clip at a time. `~` = rough (folds ran in parallel",
        "  processes). JS (`dtw-knn`) is timed by its own runner. The machine was shared with other jobs: rough either way.",
        "- Norm stats and models are always fit on the training fold only; every test clip is predicted on its own.",
        "",
        "## Real AirPods data",
        "",
    ]
    if real:
        lines += [
            "Spiro's own recordings (`data/raw/`, see its README): one person, AirPods Pro 3 on a Mac, silent mouthing,",
            "head resting against a chair. The clips in `data/raw/exclude.json` are skipped everywhere (`none` takes where",
            'he mouthed "stay still"); the raw files are never edited.',
            "",
        ]
        for g in _groups(real):
            lines += _real_section([m for m in real if tuple(datasets(m)) == g], out_path, exclude_ids)
    else:
        lines += ["No real data results yet. Run `uv run python -m silent.bench --real --model all --protocol all`.", ""]

    lines += ["## Synthetic fixture (not real AirPods data)", ""]
    if synth:
        lines += [
            SYNTHETIC_BANNER + " Generated fake motion from `shared/fixtures/`.",
            "> It shows the code works end to end. It says nothing about real mouthed sentences.",
            "",
            "| Model | Protocol | Accuracy | Macro F1 | None false accept | Infer ms/clip | Data |",
            "|---|---|---:|---:|---:|---:|---|",
        ]
        for m in synth:
            lines.append(
                f"| {m['model']} | {m['protocol'].upper()} | {_pct(m['accuracy'])} ({correct(m)}/{m['nClips']}) | {m['macroF1']:.3f} | "
                f"{_pct(m['noneFalseAcceptRate'])} | {_ms(m)} | {_names(m)} (*synthetic*) |"
            )
        lines += ["", *_highest(synth), ""]
        lines += ["### JS vs Python DTW cross check (synthetic)", "", *_cross_check(synth)]
        lines += ["### Confusion matrices (synthetic)", "", *_confusions(synth, out_path)]
    else:
        lines += ["No synthetic results. Run `uv run python -m silent.bench --model all --protocol loo loso`.", ""]
    if problems:
        lines += ["## Skipped files", "", *[f"- {p}" for p in problems], ""]
    return "\n".join(lines)


def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m silent.report", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--results", default=str(RESULTS_DIR))
    ap.add_argument("--out", default=str(ML_DIR / "RESULTS.md"))
    ap.add_argument(
        "--exclude", default=str(EXCLUDE_FILE) if EXCLUDE_FILE.exists() else None,
        help="ss-exclude file real results must have used (default data/raw/exclude.json)",
    )
    ap.add_argument("--no-exclude", action="store_true", help="don't check the exclusion list")
    a = ap.parse_args(argv)
    ids = None
    if a.exclude and not a.no_exclude:
        try:
            ids = load_exclude(a.exclude)
        except DatasetError as e:
            ap.error(str(e))
    out = Path(a.out)
    results, problems = load_results(Path(a.results))
    out.write_text(render(results, out, problems, ids))
    print(f"wrote {out} ({len(results)} results{', ' + str(len(problems)) + ' skipped' if problems else ''})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
