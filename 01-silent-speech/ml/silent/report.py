"""Build ml/RESULTS.md from every ml/results/*/*.json (Python models and the JS `dtw-knn`).

  uv run python -m silent.report
"""

from __future__ import annotations

import argparse
import json
import os
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from . import ML_DIR, PROJECT_DIR, RESULTS_DIR
from .metrics import validate_metrics

MODEL_ORDER = ["dtw-knn", "dtw-py", "minirocket", "cnn"]
PROTOCOL_ORDER = ["loo", "loso"]
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


def load_results(results_dir: Path) -> tuple[list[dict[str, Any]], list[str]]:
    """Returns (valid results sorted dataset x model x protocol, problems). Each result gets a `_path`."""
    found, problems = [], []
    for p in sorted(results_dir.glob("*/*.json")):
        try:
            m = json.loads(p.read_text())
        except (OSError, json.JSONDecodeError) as e:
            problems.append(f"`{p.relative_to(results_dir)}`: {e}")
            continue
        errs = validate_metrics(m)
        if errs:
            problems.append(f"`{p.relative_to(results_dir)}`: {'; '.join(errs[:3])}")
            continue
        m["_path"] = p
        found.append(m)

    def key(m: dict[str, Any]) -> tuple[list[str], int, str, int]:
        mo = MODEL_ORDER.index(m["model"]) if m["model"] in MODEL_ORDER else len(MODEL_ORDER)
        po = PROTOCOL_ORDER.index(m["protocol"]) if m["protocol"] in PROTOCOL_ORDER else 9
        return datasets(m), mo, m["model"], po

    return sorted(found, key=key), problems


def _pct(x: float) -> str:
    return f"{100 * x:.1f}%"


def _names(m: dict[str, Any]) -> str:
    d = datasets(m)
    return ", ".join(f"`{x}`" for x in d) if d else "?"


def _ms(m: dict[str, Any]) -> str:
    rough = str(m["params"].get("timing", "")).startswith("rough")
    return f"{'~' if rough else ''}{m['inferMsPerClip']:.1f}"


def _confusion_table(m: dict[str, Any]) -> list[str]:
    labs = m["labels"]
    out = ["| true \\ pred | " + " | ".join(labs) + " |", "|---" * (len(labs) + 1) + "|"]
    for lab, row in zip(labs, m["confusion"]):
        out.append(f"| **{lab}** | " + " | ".join(str(v) if v else "." for v in row) + " |")
    return out


def comparable(js: dict[str, Any], py: dict[str, Any]) -> list[str]:
    """Why two results can't be compared. Empty = same data and same DTW settings."""
    why = []
    if js["nClips"] != py["nClips"]:
        why.append(f"clips {js['nClips']} vs {py['nClips']}")
    if datasets(js) != datasets(py):
        why.append(f"data {datasets(js) or '?'} vs {datasets(py) or '?'}")
    for k in DTW_KEYS:
        a, b = js["params"].get(k), py["params"].get(k)
        if a != b:
            why.append(f"{k} {a} vs {b}")
    return why


def _highest(results: Sequence[dict[str, Any]]) -> list[str]:
    lines = []
    groups = list(dict.fromkeys(tuple(datasets(m)) for m in results))
    for g in groups:
        for proto in PROTOCOL_ORDER:
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


def render(results: Sequence[dict[str, Any]], out_path: Path, problems: Sequence[str] = ()) -> str:
    lines = ["# Silent Speech: model benchmark", ""]
    if any(is_synthetic(m) for m in results):
        lines += [
            SYNTHETIC_BANNER + " Rows marked *synthetic* use generated fake motion from `shared/fixtures/`.",
            "> They show the code works end to end. They say nothing yet about real mouthed sentences.",
            "",
        ]
    lines += [
        "Made by `uv run python -m silent.report` from `ml/results/*/*.json`. Don't edit by hand.",
        "",
        "- **LOO** = leave one clip out. **LOSO** = leave one session out (train on the other sessions, test on a",
        "  new one: closest to real use, so the number that matters).",
        "- **None false accept** = share of true `none` clips the model accepted as an action (label is not `none` and",
        "  confidence >= the 0.5 threshold). Each model family has its own confidence scale (DTW: vote x separation,",
        "  MiniRocket: mapped ridge scores, CNN: softmax), so at a fixed 0.5 this column is **not comparable across",
        "  model families**. Phase 2 tunes a threshold per model.",
        "- **Infer ms** = per clip, preprocessing + predict, one clip at a time. `~` = rough (folds ran in parallel",
        "  processes). JS (`dtw-knn`) is timed by its own runner.",
        "",
    ]
    if not results:
        lines += ["No results yet. Run `uv run python -m silent.bench --model all --protocol all`.", ""]
    else:
        lines += [
            "| Model | Protocol | Accuracy | Macro F1 | None false accept | Infer ms/clip | Data |",
            "|---|---|---:|---:|---:|---:|---|",
        ]
        for m in results:
            tag = " (*synthetic*)" if is_synthetic(m) else ""
            lines.append(
                f"| {m['model']} | {m['protocol'].upper()} | {_pct(m['accuracy'])} ({correct(m)}/{m['nClips']}) | {m['macroF1']:.3f} | "
                f"{_pct(m['noneFalseAcceptRate'])} | {_ms(m)} | {_names(m)}{tag} |"
            )
        lines += ["", *_highest(results), ""]

        lines += ["## JS vs Python DTW cross check", ""]
        rows = []
        for proto in PROTOCOL_ORDER:
            for js in [m for m in results if m["model"] == "dtw-knn" and m["protocol"] == proto]:
                for py in [m for m in results if m["model"] == "dtw-py" and m["protocol"] == proto]:
                    why = comparable(js, py)
                    head = f"| {proto.upper()} | {_names(py)} | {_pct(js['accuracy'])} | {_pct(py['accuracy'])} |"
                    nfa = f" {_pct(js['noneFalseAcceptRate'])} | {_pct(py['noneFalseAcceptRate'])} |"
                    if why:
                        rows.append(f"{head} |{nfa} not comparable: {'; '.join(why)} |")
                        continue
                    gap = 100 * abs(js["accuracy"] - py["accuracy"])
                    same = js["labels"] == py["labels"] and js["confusion"] == py["confusion"]
                    ok = "yes" if gap <= AGREE_POINTS else "**NO**"
                    rows.append(f"{head} {gap:.1f} |{nfa} {ok}{', same confusion matrix' if same else ''} |")
        if rows:
            lines += [
                "Same data and the same settings (L, band, k, norm, channels, hpHz, threshold) are checked first.",
                "",
                "| Protocol | Data | Accuracy JS | Accuracy Python | Gap (points) | None FA JS | None FA Python | Within 5? |",
                "|---|---|---:|---:|---:|---:|---:|---|",
                *rows,
            ]
        else:
            lines.append("Needs both `results/dtw-knn/` (JS, `scripts/eval-dtw.ts`) and `results/dtw-py/` for the same protocol.")
        lines.append("")

        lines += ["## Confusion matrices", "", "Rows = true label, columns = predicted.", ""]
        for model in dict.fromkeys(m["model"] for m in results):
            lines += [f"### {model}", ""]
            for m in [r for r in results if r["model"] == model]:
                img = m["_path"].parent / f"confusion_{m['protocol']}.png"
                if img.exists():
                    rel = os.path.relpath(img, out_path.parent).replace(os.sep, "/")
                    lines += [f"![{model} {m['protocol']}]({rel})", ""]
                else:
                    lines += [f"**{m['protocol'].upper()}**", "", *_confusion_table(m), ""]
    if problems:
        lines += ["## Skipped files", "", *[f"- {p}" for p in problems], ""]
    return "\n".join(lines)


def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m silent.report", description=__doc__)
    ap.add_argument("--results", default=str(RESULTS_DIR))
    ap.add_argument("--out", default=str(ML_DIR / "RESULTS.md"))
    a = ap.parse_args(argv)
    out = Path(a.out)
    results, problems = load_results(Path(a.results))
    out.write_text(render(results, out, problems))
    print(f"wrote {out} ({len(results)} results{', ' + str(len(problems)) + ' skipped' if problems else ''})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
