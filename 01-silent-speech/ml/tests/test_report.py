import json

from silent import report
from silent.bench import write_result
from silent.metrics import compute_metrics
from silent.models import Pred

DTW = {"channels": ["rr.x", "rr.y", "rr.z", "ua.x", "ua.y", "ua.z"], "L": 64, "hpHz": 1.0, "band": 0.1, "k": 1, "norm": "global", "threshold": 0.5}
PY_SYNTH = {**DTW, "budNorm": "mirror", "data": ["shared/fixtures/dataset.synthetic.json"], "datasets": ["dataset.synthetic.json"],
            "sources": ["fake"], "buds": {"s1": "left"}}
JS_SYNTH = {**DTW, "hpHz": 1, "datasets": ["dataset.synthetic.json"], "radius": 6}  # what Phase 1 scripts/eval-dtw.ts wrote (no budNorm)
IDS = ["s1-a", "s1-b", "s2-c"]
REAL = {**DTW, "budNorm": "mirror", "data": ["data/raw/s1.json", "data/raw/s2.json"], "datasets": ["s1.json", "s2.json"], "sources": ["airpods"],
        "subjects": ["spiro"], "buds": {"s1": "right", "s2": "left"}, "exclude": "data/raw/exclude.json", "excludeIds": IDS, "excluded": 3,
        "excludedBySession": {"s1": 2, "s2": 1}, "perSession": {"s1": {"correct": 4, "n": 5}, "s2": {"correct": 3, "n": 5}}}


def fake(model, protocol, hits, params, n=10, none_fa=0, generated=None):
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
    m = compute_metrics(model, protocol, y, preds, 0.5, json.loads(json.dumps(params)), 2.0)
    if generated:
        m["generatedAt"] = generated
    return m


def build(tmp_path, results, args=()):
    res = tmp_path / "results"
    for m in results:
        d = res / "synthetic" if report.is_synthetic(m) else res
        if m["model"] == "dtw-knn":  # JS: json only, no png
            (d / "dtw-knn").mkdir(parents=True, exist_ok=True)
            (d / "dtw-knn" / f"{m['protocol']}.json").write_text(json.dumps(m))
        else:
            write_result(m, d)
    out = tmp_path / "RESULTS.md"
    assert report.main(["--results", str(res), "--out", str(out), *args]) == 0
    return out.read_text()


def ex_file(tmp_path, ids=IDS):
    p = tmp_path / "exclude.json"
    p.write_text(json.dumps({"format": "ss-exclude", "v": 1, "reason": "t", "ids": ids}))
    return ["--exclude", str(p)]


def test_synthetic_only_banner_counts_and_comparable_cross_check(tmp_path):
    md = build(tmp_path, [
        fake("dtw-py", "loso", 9, PY_SYNTH),
        fake("dtw-knn", "loso", 9, JS_SYNTH),
        fake("cnn", "loo", 10, {**PY_SYNTH, "timing": "rough: 4 processes in parallel"}),
        fake("minirocket", "loso", 9, PY_SYNTH, none_fa=1),
    ])
    real, synth = md.split("## Synthetic fixture (not real AirPods data)")
    assert "## Real AirPods data" in real and "No real data results yet" in real and "synthetic*" not in real
    assert synth.strip().startswith("> **Synthetic fixture, not real AirPods data.**")
    assert "not comparable across model families" in md and "DTW at its defaults 0.85" in md
    rows = [ln for ln in synth.splitlines() if ln.startswith(("| dtw", "| cnn", "| minirocket"))][:4]
    assert [r.split("|")[1].strip() for r in rows] == ["dtw-knn", "dtw-py", "minirocket", "cnn"]  # JS first, then ours
    assert "| dtw-knn | LOSO | 90.0% (9/10) | 0.899 | 0.0% | 2.0 | `dataset.synthetic.json` (*synthetic*) |" in md  # reads JS `datasets`
    assert "| ~2.0 |" in md  # rough timing marked
    assert "- Highest LOO on `dataset.synthetic.json`: **cnn**, 10/10 correct (100.0%)." in md
    assert "- Highest LOSO on `dataset.synthetic.json`: **dtw-knn (JS)** and **dtw-py** and **minirocket** (tie), 9/10 correct (90.0%)." in md
    # Phase 1 JS results have no budNorm: irrelevant on all left bud data, so still comparable
    assert "| LOSO | `dataset.synthetic.json` | 90.0% (9/10) | 90.0% (9/10) | 0.0 | 0.0% | 0.0% | yes, same confusion matrix |" in md
    assert "| minirocket | LOSO | 90.0% (9/10) | 0.899 | 20.0% |" in md  # 1 of 5 none clips accepted
    assert "![dtw-py loso](results/synthetic/dtw-py/confusion_loso.png)" in md
    assert "| true \\ pred | a | none |" in md  # dtw-knn has no png -> text table


def test_real_section_comes_first_with_counts_buds_folds_xbud_and_luck(tmp_path):
    xbud = {**REAL, "perSession": {"s1": {"correct": 6, "n": 10}},
            "xbud": {"trainBud": "left", "testBud": "right", "trainSessions": ["s2"], "testSessions": ["s1"]},
            "variants": {"none": {"accuracy": 0.3, "correct": 3, "nClips": 10}, "mirror": {"accuracy": 0.6, "correct": 6, "nClips": 10}}}
    perm = {"n": 500, "nClips": 10, "realCorrect": 7, "realAccuracy": 0.7, "shuffledMean": 0.12, "shuffledStd": 0.021, "shuffledMin": 0.0,
            "shuffledMax": 0.3, "atLeastReal": 0, "pValue": 1 / 501, "shuffledCorrectHistogram": {"0": 100, "1": 300, "3": 100}}
    md = build(tmp_path, [
        fake("dtw-py", "loso", 7, {**REAL, "permutation": perm}, none_fa=1),
        fake("cnn", "loso", 8, REAL),
        fake("dtw-py", "xbud", 6, xbud),
        fake("dtw-py", "loo", 9, REAL),
        fake("dtw-py", "loso", 10, PY_SYNTH),
    ], ex_file(tmp_path))
    real, synth = md.split("## Synthetic fixture (not real AirPods data)")
    assert md.index("## Real AirPods data") < md.index("## Synthetic fixture")
    assert "Synthetic fixture, not real" not in real and "(*synthetic*)" in synth and "| dtw-py | LOSO | 100.0% (10/10)" in synth
    assert "| s1 | **right** | 5 | 2 |" in real and "| s2 | left | 5 | 1 |" in real and "| **all** | | **10** | 3 |" in real
    assert "2 classes (`a`, `none`), so chance is about 50.0%." in real
    assert "| Model | Accuracy | Macro F1 | test s1 (right bud) | test s2 (left bud) | Settings | None false accept | Infer ms/clip |" in real
    assert "| dtw-py | 70.0% (7/10) | " in real and " | 80.0% (4/5) | 60.0% (3/5) | fixed before this data | 20.0% (1/5) | 2.0 |" in real
    assert "Settings picked on these folds" not in real  # Phase 1 DTW settings (REAL): no sweep note
    assert "- Highest LOSO with settings fixed before this data: **cnn**, 8/10 correct (80.0%)." in real
    assert "Train on every left bud clip (s2), test on every right bud clip (s1)." in real
    assert "| dtw-py | 30.0% (3/10) | 60.0% (6/10) | +30.0 |" in real
    assert "| dtw-py | 70.0% (7/10) | 12.0% (2.1) | 30.0% | 0 of 500 | 0.002 |" in real
    assert "![dtw-py luck test](results/dtw-py/luck_loso.png)" in real
    assert "Not run for cnn (each shuffle" in real
    assert "#### Leave one clip out" in real and "| dtw-py | 90.0% (9/10) | " in real
    assert real.index("(the headline)") < real.index("#### Cross bud") < real.index("#### Luck test") < real.index("#### Leave one clip out")
    assert "Warning" not in md
    assert "Seeds" not in md  # no seed spread recorded -> no column


def test_loso_table_shows_the_seed_spread(tmp_path):
    spread = {"seeds": [0, 1, 2], "correct": [7, 6, 9], "nClips": 10, "mean": 22 / 30, "min": 0.6, "max": 0.9}
    md = build(tmp_path, [fake("dtw-py", "loso", 8, REAL), fake("cnn", "loso", 7, {**REAL, "seedSpread": spread})])
    assert "| test s2 (left bud) | Seeds 0 to 2: mean (range) | Settings | None false accept |" in md
    assert "| 80.0% (4/5) | 60.0% (3/5) | 73.3% (60.0% to 90.0%) | fixed before this data | 0.0% (0/5) |" in md
    assert "| no randomness |" in md and "Accuracy is the first seed (0), fixed before the run." in md


def test_real_results_without_the_exclusion_list_are_flagged(tmp_path):
    no_list = {k: v for k, v in REAL.items() if k not in ("excludeIds", "exclude")} | {"excluded": 0}
    md = build(tmp_path, [fake("dtw-py", "loso", 7, no_list), fake("cnn", "loso", 7, {**REAL, "excludeIds": IDS[:1]})], ex_file(tmp_path))
    assert "**Warning:** `dtw-py/loso.json` was made without the exclusion list." in md
    assert "**Warning:** `cnn/loso.json` was made with a different exclusion list." in md
    md = build(tmp_path / "b", [fake("dtw-py", "loso", 7, no_list)], ["--no-exclude"])
    assert "Warning" not in md


def test_cross_check_flags_gap_and_refuses_different_settings_or_data(tmp_path):
    md = build(tmp_path, [
        fake("dtw-py", "loso", 9, PY_SYNTH),
        fake("dtw-knn", "loso", 8, JS_SYNTH),
        fake("dtw-py", "loo", 9, PY_SYNTH),
        fake("dtw-knn", "loo", 9, {**JS_SYNTH, "k": 3}),
    ])
    assert "| LOSO | `dataset.synthetic.json` | 80.0% (8/10) | 90.0% (9/10) | 10.0 | 0.0% | 0.0% | **NO** |" in md
    assert "| LOO | `dataset.synthetic.json` | 90.0% (9/10) | 90.0% (9/10) | | 0.0% | 0.0% | not comparable: k 3 vs 1 |" in md

    md = build(tmp_path / "b", [fake("dtw-py", "loso", 9, PY_SYNTH), fake("dtw-knn", "loso", 9, {**JS_SYNTH, "datasets": ["dataset.tiny.json"]}, n=12)])
    assert "not comparable: clips 12 vs 10; data ['dataset.tiny.json'] vs ['dataset.synthetic.json']" in md
    # real JS vs synthetic Python: different sections, never paired
    md = build(tmp_path / "c", [fake("dtw-py", "loso", 9, PY_SYNTH), fake("dtw-knn", "loso", 9, {**JS_SYNTH, "datasets": ["s1.json"]}, n=12)])
    assert "Accuracy JS" not in md and "| dtw-knn (JS) | 75.0% (9/12) |" in md.split("## Synthetic")[0]


def test_real_cross_check_needs_the_same_bud_norm_and_exclusion_list(tmp_path):
    js = {k: v for k, v in REAL.items() if k not in ("perSession", "buds", "excludedBySession", "data")}  # roughly what the JS writes
    md = build(tmp_path, [fake("dtw-py", "loso", 7, REAL), fake("dtw-knn", "loso", 7, js)], ex_file(tmp_path))
    assert "| LOSO | `s1.json`, `s2.json` | 70.0% (7/10) | 70.0% (7/10) | 0.0 | 0.0% | 0.0% | yes, same confusion matrix |" in md
    md = build(tmp_path / "b", [fake("dtw-py", "loso", 7, REAL), fake("dtw-knn", "loso", 7, {**js, "budNorm": "none"})])
    assert "not comparable: budNorm none vs mirror" in md
    md = build(tmp_path / "c", [fake("dtw-py", "loso", 7, REAL), fake("dtw-knn", "loso", 7, {**js, "excludeIds": IDS[:2]})])
    assert "not comparable: different exclusion lists" in md


def test_a_copied_result_is_shown_once(tmp_path):
    m = fake("dtw-knn", "loso", 9, JS_SYNTH, generated="2026-10-01T00:00:00.000Z")
    res = tmp_path / "results"
    for d in (res / "dtw-knn", res / "synthetic" / "dtw-knn"):
        d.mkdir(parents=True)
        (d / "loso.json").write_text(json.dumps(m))
    results, problems = report.load_results(res)
    assert len(results) == 1 and not problems


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
    md = out.read_text()
    assert "No real data results yet" in md and "No synthetic results" in md


def test_swept_dtw_settings_are_flagged_and_variants_kept_apart(tmp_path):
    swept = {**REAL, "L": 96, "band": 0.05, "k": 3, "norm": "clip", "threshold": 0.85}
    js = {k: v for k, v in swept.items() if k not in ("perSession", "buds", "excludedBySession", "data", "excludeIds")}
    js |= {"exclude": "exclude.json", "nExcluded": 3}  # what F's eval-dtw writes
    md = build(tmp_path, [
        fake("dtw-knn", "loso", 9, js),
        fake("dtw-py", "loso", 9, swept),
        fake("dtw-py", "loso", 7, {**REAL, "variant": "phase1-settings"}),
        fake("cnn", "loso", 7, {**REAL, "L": 96, "norm": "clip", "variant": "L96-clip"}),
    ], ex_file(tmp_path))
    assert "| dtw-py | 90.0% (9/10) |" in md and "| picked on these folds (sweep) |" in md
    assert "| dtw-py (phase1-settings) | 70.0% (7/10) |" in md and "| fixed before this data |" in md
    assert "| cnn (L96-clip) | 70.0% (7/10) |" in md and "| preprocessing from the DTW sweep |" in md
    assert "**Settings picked on these folds:**" in md
    assert "Warning" not in md  # the JS exclude name + count is accepted
    # the cross check pairs the JS result with the default dtw-py only, never a variant
    rows = [ln for ln in md.splitlines() if ln.startswith("| LOSO | `s1.json`")]
    assert rows == ["| LOSO | `s1.json`, `s2.json` | 90.0% (9/10) | 90.0% (9/10) | 0.0 | 0.0% | 0.0% | yes, same confusion matrix |"]
    assert "##### dtw-py (phase1-settings)" in md


def test_js_exclusion_by_name_and_count():
    m = fake("dtw-knn", "loso", 9, {**JS_SYNTH, "datasets": ["s1.json"], "exclude": "exclude.json", "nExcluded": 3})
    assert report.exclusion_problem(m, IDS, "data/raw/exclude.json") is None
    assert report.exclusion_problem(m, IDS, "other.json") == "made with a different exclusion list"
    m0 = fake("dtw-knn", "loso", 9, {**JS_SYNTH, "datasets": ["s1.json"]})
    assert report.exclusion_problem(m0, IDS) == "made without the exclusion list"


def test_tuned_dtw_sits_next_to_the_nested_number_and_is_not_crowned(tmp_path):
    from silent.report import NESTED_DTW

    data = {**REAL, "datasets": NESTED_DTW["datasets"], "data": [f"data/raw/{x}" for x in NESTED_DTW["datasets"]],
            "buds": {"s1": "right", "s2": "left", "s3": "left"},
            "perSession": {"s1": {"correct": 88, "n": 105}, "s2": {"correct": 114, "n": 117}, "s3": {"correct": 120, "n": 120}}}
    swept = {**data, "L": 96, "band": 0.05, "k": 3, "norm": "clip", "threshold": 0.85,
             "permutation": {"n": 500, "nClips": 342, "realCorrect": 322, "realAccuracy": 322 / 342, "shuffledMean": 0.125, "shuffledStd": 0.03,
                             "shuffledMin": 0.05, "shuffledMax": 0.23, "atLeastReal": 0, "pValue": 1 / 501, "shuffledCorrectHistogram": {"40": 500}}}
    phase1 = {**data, "variant": "phase1-settings",
              "permutation": {**swept["permutation"], "realCorrect": 280, "realAccuracy": 280 / 342}}
    spread = {"seeds": [0, 1, 2, 3, 4], "correct": [290, 287, 294, 302, 287], "nClips": 342, "mean": 0.854, "min": 287 / 342, "max": 302 / 342}
    mr = {**data, "L": 96, "norm": "clip", "variant": "L96-clip", "seedSpread": spread}
    md = build(tmp_path, [
        fake("dtw-py", "loso", 322, swept, n=342),
        fake("dtw-py", "loso", 280, phase1, n=342),
        fake("minirocket", "loso", 290, mr, n=342),
    ], ex_file(tmp_path))
    rows = md.splitlines()
    i = next(k for k, ln in enumerate(rows) if ln.startswith("| dtw-py | 94.2% (322/342)"))
    assert rows[i + 1].startswith("| **DTW, nested** (same settings search, test session left out) | **88.2% (301.5/342)** |")
    assert "| 67% | 96.6% | 98.3% |" in rows[i + 1]
    assert "s3 is only held out of the public model's training" in md and "played no part" not in md
    assert "per held out session s1 67%, s2 96.6%, s3 98.3%." in md and "94.2% when tuned on all three sessions is about 6 points" in md
    assert "- Highest LOSO with settings fixed before this data: **dtw-py (phase1-settings)**, 280/342 correct (81.9%)." in md
    assert "**dtw-py** (" not in md.split("Highest LOSO")[1].split("\n")[0]  # the tuned row is never crowned
    assert ("- Tuned DTW: 88.2% with settings chosen without the test session (the honest number) vs **minirocket (L96-clip)** at 84.8% "
            "(seeds 0 to 4: 83.9% to 88.3%): DTW's lead is within that model's seed noise.") in md
    assert "It does not measure tuning optimism: the tuned 94.2% and the untuned 81.9% DTW both get" in md
    assert "p = 0.002. For that, see the nested 88.2% above." in md
