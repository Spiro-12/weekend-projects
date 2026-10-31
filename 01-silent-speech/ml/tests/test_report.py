import json

from silent import report
from silent.bench import write_result
from silent.metrics import compute_metrics
from silent.models import Pred

DTW = {"channels": ["rr.x", "rr.y", "rr.z", "ua.x", "ua.y", "ua.z"], "L": 64, "hpHz": 1.0, "band": 0.1, "k": 1, "norm": "global", "threshold": 0.5}
PY_SYNTH = {**DTW, "data": ["shared/fixtures/dataset.synthetic.json"], "datasets": ["dataset.synthetic.json"], "sources": ["fake"]}
JS_SYNTH = {**DTW, "hpHz": 1, "datasets": ["dataset.synthetic.json"], "radius": 6}  # what scripts/eval-dtw.ts writes
REAL = {**DTW, "data": ["data/raw/s1.json"], "datasets": ["s1.json"], "sources": ["airpods"], "subjects": ["spiro"]}


def fake(model, protocol, hits, params, n=10, none_fa=0):
    """n clips, half `a` and half `none`; the first `hits` are right. `none_fa` wrong none clips are confident."""
    y = ["a"] * (n // 2) + ["none"] * (n - n // 2)
    preds = []
    for i, t in enumerate(y):
        if i < hits:
            preds.append(Pred(t, 0.9, []))
        else:
            wrong = "none" if t == "a" else "a"
            conf = 0.9 if (t == "none" and none_fa > 0) else 0.1
            none_fa -= t == "none"
            preds.append(Pred(wrong, conf, []))
    return compute_metrics(model, protocol, y, preds, 0.5, dict(params), 2.0)


def js(res, m):
    (res / "dtw-knn").mkdir(parents=True, exist_ok=True)
    (res / "dtw-knn" / f"{m['protocol']}.json").write_text(json.dumps(m))  # JS: json only, no png


def build(tmp_path, results):
    res = tmp_path / "results"
    for m in results:
        js(res, m) if m["model"] == "dtw-knn" else write_result(m, res)
    out = tmp_path / "RESULTS.md"
    assert report.main(["--results", str(res), "--out", str(out)]) == 0
    return out.read_text()


def test_synthetic_banner_counts_and_comparable_cross_check(tmp_path):
    md = build(tmp_path, [
        fake("dtw-py", "loso", 9, PY_SYNTH),
        fake("dtw-knn", "loso", 9, JS_SYNTH),
        fake("cnn", "loo", 10, {**PY_SYNTH, "timing": "rough: 4 processes in parallel"}),
        fake("minirocket", "loso", 9, PY_SYNTH, none_fa=1),
    ])
    assert md.splitlines()[2].startswith("> **Synthetic fixture, not real AirPods data.**")
    assert "not comparable across\n  model families" in md
    rows = [ln for ln in md.splitlines() if ln.startswith(("| dtw", "| cnn", "| minirocket"))]
    assert [r.split("|")[1].strip() for r in rows] == ["dtw-knn", "dtw-py", "minirocket", "cnn"]  # JS first, then ours
    assert "| dtw-py | LOSO | 90.0% (9/10) | " in md
    assert "| dtw-knn | LOSO | 90.0% (9/10) | 0.899 | 0.0% | 2.0 | `dataset.synthetic.json` (*synthetic*) |" in md  # reads JS `datasets`
    assert "| ~2.0 |" in md  # rough timing marked
    assert "Best" not in md
    assert "- Highest LOO on `dataset.synthetic.json`: **cnn**, 10/10 correct (100.0%)." in md
    assert "- Highest LOSO on `dataset.synthetic.json`: **dtw-knn** and **dtw-py** and **minirocket** (tie), 9/10 correct (90.0%)." in md
    assert "| LOSO | `dataset.synthetic.json` | 90.0% | 90.0% | 0.0 | 0.0% | 0.0% | yes, same confusion matrix |" in md
    assert "| minirocket | LOSO | 90.0% (9/10) | 0.899 | 20.0% |" in md  # 1 of 5 none clips accepted
    assert "![dtw-py loso](results/dtw-py/confusion_loso.png)" in md
    assert "| true \\ pred | a | none |" in md  # dtw-knn has no png -> text table


def test_cross_check_flags_gap_and_refuses_different_settings_or_data(tmp_path):
    md = build(tmp_path, [
        fake("dtw-py", "loso", 9, PY_SYNTH),
        fake("dtw-knn", "loso", 8, JS_SYNTH),
        fake("dtw-py", "loo", 9, PY_SYNTH),
        fake("dtw-knn", "loo", 9, {**JS_SYNTH, "k": 3}),
    ])
    assert "| LOSO | `dataset.synthetic.json` | 80.0% | 90.0% | 10.0 | 0.0% | 0.0% | **NO** |" in md
    assert "| LOO | `dataset.synthetic.json` | 90.0% | 90.0% | | 0.0% | 0.0% | not comparable: k 3 vs 1 |" in md

    md = build(tmp_path / "b", [fake("dtw-py", "loso", 9, PY_SYNTH), fake("dtw-knn", "loso", 9, {**JS_SYNTH, "datasets": ["s1.json"]}, n=12)])
    assert "not comparable: clips 12 vs 10; data ['s1.json'] vs ['dataset.synthetic.json']" in md


def test_highest_is_per_dataset_and_real_data_has_no_banner(tmp_path):
    md = build(tmp_path, [fake("dtw-py", "loso", 10, PY_SYNTH), fake("cnn", "loso", 7, REAL)])
    assert "- Highest LOSO on `dataset.synthetic.json`: **dtw-py**, 10/10 correct (100.0%)." in md
    assert "- Highest LOSO on `s1.json`: **cnn**, 7/10 correct (70.0%)." in md
    assert "| cnn | LOSO | 70.0% (7/10) | " in md and "`s1.json` |" in md  # real row: no synthetic tag

    md = build(tmp_path / "real", [fake("cnn", "loso", 7, REAL)])
    assert "Synthetic fixture" not in md and "synthetic*" not in md


def test_js_result_without_sources_is_still_recognised_as_synthetic():
    m = fake("dtw-knn", "loo", 9, JS_SYNTH)
    assert report.is_synthetic(m)
    assert report.is_synthetic(fake("dtw-knn", "loo", 9, {**JS_SYNTH, "datasets": ["dataset.tiny.json"]}))
    assert not report.is_synthetic(fake("dtw-knn", "loo", 9, {**JS_SYNTH, "datasets": ["s1.json"]}))


def test_broken_files_are_listed_not_fatal(tmp_path):
    (tmp_path / "results" / "broken").mkdir(parents=True)
    (tmp_path / "results" / "broken" / "loo.json").write_text('{"model": "x"}')
    md = build(tmp_path, [fake("dtw-py", "loo", 9, PY_SYNTH)])
    assert "`broken/loo.json`" in md


def test_report_with_no_results(tmp_path):
    out = tmp_path / "RESULTS.md"
    report.main(["--results", str(tmp_path / "nothing"), "--out", str(out)])
    assert "No results yet" in out.read_text()
