import json

from silent import report
from silent.bench import write_result
from silent.metrics import compute_metrics
from silent.models import Pred


def fake(model, protocol, acc_hits, n=10, data=("shared/fixtures/dataset.synthetic.json",)):
    y = ["a"] * (n // 2) + ["none"] * (n - n // 2)
    preds = [Pred(t if i < acc_hits else ("none" if t == "a" else "a"), 0.9, []) for i, t in enumerate(y)]
    return compute_metrics(model, protocol, ["a", "none"], y, preds, 0.5, {"data": list(data)}, 2.0)


def test_report_table_cross_check_and_confusions(tmp_path):
    res = tmp_path / "results"
    write_result(fake("dtw-py", "loso", 9), res)  # with png
    write_result(fake("cnn", "loo", 10), res)
    (res / "dtw-knn").mkdir()
    (res / "dtw-knn" / "loso.json").write_text(json.dumps(fake("dtw-knn", "loso", 8)))  # JS: json only
    (res / "broken").mkdir()
    (res / "broken" / "loo.json").write_text('{"model": "x"}')
    out = tmp_path / "RESULTS.md"
    assert report.main(["--results", str(res), "--out", str(out)]) == 0
    md = out.read_text()

    rows = [ln for ln in md.splitlines() if ln.startswith(("| dtw", "| cnn"))]
    assert [r.split("|")[1].strip() for r in rows][:3] == ["dtw-knn", "dtw-py", "cnn"]  # JS first, then ours
    assert "| dtw-py | LOSO | 10 | 90.0% |" in md
    assert "| LOSO | 80.0% | 90.0% | 10.0 | **NO** |" in md  # JS vs Python gap > 5 points is flagged
    assert "Best LOO: **cnn** (100.0%)" in md
    assert "![dtw-py loso](results/dtw-py/confusion_loso.png)" in md
    assert "| true \\ pred | a | none |" in md  # dtw-knn has no png -> text table
    assert "`broken/loo.json`" in md  # skipped, not fatal


def test_report_with_no_results(tmp_path):
    out = tmp_path / "RESULTS.md"
    report.main(["--results", str(tmp_path / "nothing"), "--out", str(out)])
    assert "No results yet" in out.read_text()
