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

from . import ML_DIR, RESULTS_DIR
from .metrics import validate_metrics

MODEL_ORDER = ["dtw-knn", "dtw-py", "minirocket", "cnn"]
PROTOCOL_ORDER = ["loo", "loso"]
AGREE_POINTS = 5.0  # JS and Python DTW must agree within this many accuracy points


def load_results(results_dir: Path) -> tuple[list[dict[str, Any]], list[str]]:
    """Returns (valid results sorted model x protocol, problems). Each result gets a `_path`."""
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

    def key(m: dict[str, Any]) -> tuple[int, str, int]:
        mo = MODEL_ORDER.index(m["model"]) if m["model"] in MODEL_ORDER else len(MODEL_ORDER)
        po = PROTOCOL_ORDER.index(m["protocol"]) if m["protocol"] in PROTOCOL_ORDER else 9
        return mo, m["model"], po

    return sorted(found, key=key), problems


def _pct(x: float) -> str:
    return f"{100 * x:.1f}%"


def _data(m: dict[str, Any]) -> str:
    d = m["params"].get("data")
    if isinstance(d, list) and d:
        return ", ".join(f"`{x}`" for x in d)
    return "?"


def _confusion_table(m: dict[str, Any]) -> list[str]:
    labs = m["labels"]
    out = ["| true \\ pred | " + " | ".join(labs) + " |", "|---" * (len(labs) + 1) + "|"]
    for lab, row in zip(labs, m["confusion"]):
        out.append(f"| **{lab}** | " + " | ".join(str(v) if v else "." for v in row) + " |")
    return out


def render(results: Sequence[dict[str, Any]], out_path: Path, problems: Sequence[str] = ()) -> str:
    lines = [
        "# Silent Speech: model benchmark",
        "",
        "Made by `uv run python -m silent.report` from `ml/results/*/*.json`. Don't edit by hand.",
        "",
        "- **LOO** = leave one clip out. **LOSO** = leave one session out (train on the other sessions, test on a",
        "  new one: closest to real use, so the number that matters).",
        "- **None false accept** = share of true `none` clips the model accepted as an action",
        "  (label is not `none` and confidence >= threshold).",
        "- **Infer ms** = per clip, preprocessing + predict, one clip at a time. JS (`dtw-knn`) is timed by its own runner.",
        "",
    ]
    if not results:
        lines += ["No results yet. Run `uv run python -m silent.bench --model all --protocol all`.", ""]
    else:
        lines += [
            "| Model | Protocol | Clips | Accuracy | Macro F1 | None false accept | Infer ms/clip | Data |",
            "|---|---|---:|---:|---:|---:|---:|---|",
        ]
        for m in results:
            lines.append(
                f"| {m['model']} | {m['protocol'].upper()} | {m['nClips']} | {_pct(m['accuracy'])} | {m['macroF1']:.3f} | "
                f"{_pct(m['noneFalseAcceptRate'])} | {m['inferMsPerClip']:.1f} | {_data(m)} |"
            )
        lines.append("")
        for proto in PROTOCOL_ORDER:
            rows = [m for m in results if m["protocol"] == proto]
            if rows:
                best = max(rows, key=lambda m: (m["accuracy"], m["macroF1"]))
                lines.append(f"Best {proto.upper()}: **{best['model']}** ({_pct(best['accuracy'])}).  ")
        lines.append("")

        by = {(m["model"], m["protocol"]): m for m in results}
        pairs = [(p, by.get(("dtw-knn", p)), by.get(("dtw-py", p))) for p in PROTOCOL_ORDER]
        lines += ["## JS vs Python DTW cross check", ""]
        if any(js and py for _, js, py in pairs):
            lines += ["| Protocol | dtw-knn (JS) | dtw-py (Python) | Gap (points) | Within 5? |", "|---|---:|---:|---:|---|"]
            for proto, js, py in pairs:
                if js and py:
                    gap = 100 * abs(js["accuracy"] - py["accuracy"])
                    ok = "yes" if gap <= AGREE_POINTS else "**NO**"
                    lines.append(f"| {proto.upper()} | {_pct(js['accuracy'])} | {_pct(py['accuracy'])} | {gap:.1f} | {ok} |")
        else:
            lines.append("Needs both `results/dtw-knn/` (JS, `scripts/eval-dtw.ts`) and `results/dtw-py/` for the same protocol.")
        lines.append("")

        lines += ["## Confusion matrices", "", "Rows = true label, columns = predicted.", ""]
        models = list(dict.fromkeys(m["model"] for m in results))
        for model in models:
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
