import json

import numpy as np
import pytest

from silent import bench
from silent.data import load_corpus
from silent.metrics import validate_metrics
from silent.models import torch_available
from silent.models.minirocket import ridge_scores
from tests.conftest import TINY

needs_torch = pytest.mark.skipif(not torch_available(), reason="torch not installed (uv sync --extra cnn)")


def test_dtw_py_loso_on_synthetic(synthetic, tmp_path):
    m = bench.evaluate(synthetic, "dtw-py", "loso")
    assert validate_metrics(m) == []
    assert m["model"] == "dtw-py" and m["protocol"] == "loso" and m["nClips"] == 120
    assert m["accuracy"] >= 0.9, m["accuracy"]  # brief gate
    pr = m["params"]
    assert pr["band"] == 0.1 and pr["k"] == 1 and pr["radius"] == 6 and pr["L"] == 64  # PROTOCOL §6 defaults
    assert pr["datasets"] == ["dataset.synthetic.json"] and pr["data"] == ["shared/fixtures/dataset.synthetic.json"]
    assert pr["sources"] == ["fake"] and pr["subjects"] == ["synthetic"]  # so reports can flag synthetic numbers
    assert pr["timing"] == "single process"
    assert m["labels"] == sorted(m["labels"])
    p = bench.write_result(m, tmp_path)
    assert p == tmp_path / "dtw-py" / "loso.json"
    assert validate_metrics(json.loads(p.read_text())) == []
    assert (tmp_path / "dtw-py" / "confusion_loso.png").stat().st_size > 1000


def test_confusion_png_title_says_synthetic(synthetic, monkeypatch, tmp_path):
    import matplotlib.axes

    titles = []
    monkeypatch.setattr(matplotlib.axes.Axes, "set_title", lambda self, t, **kw: titles.append(t))
    m = bench.evaluate(synthetic, "dtw-py", "loso")
    bench.plot_confusion(m, tmp_path / "a.png")
    bench.plot_confusion({**m, "params": {**m["params"], "sources": ["airpods"]}}, tmp_path / "b.png")
    assert "SYNTHETIC" in titles[0] and f"{round(m['accuracy'] * 120)}/120 correct" in titles[0]
    assert "SYNTHETIC" not in titles[1]


def test_cli_writes_results(tmp_path, capsys):
    rc = bench.main(["--model", "dtw-py", "--protocol", "loo", "--data", str(TINY), "--out", str(tmp_path)])
    assert rc == 0
    m = json.loads((tmp_path / "dtw-py" / "loo.json").read_text())
    assert m["nClips"] == 6 and m["params"]["data"] == ["shared/fixtures/dataset.tiny.json"]
    assert "dtw-py" in capsys.readouterr().out


def test_protocol_all_skips_loso_on_single_session_data(tmp_path, capsys):
    rc = bench.main(["--model", "dtw-py", "--protocol", "all", "--data", str(TINY), "--out", str(tmp_path)])
    assert rc == 0
    assert (tmp_path / "dtw-py" / "loo.json").exists()
    assert not (tmp_path / "dtw-py" / "loso.json").exists()
    assert "LOSO skipped" in capsys.readouterr().err


def test_parallel_folds_give_identical_predictions_but_rough_timing(tiny):
    a = bench.evaluate(tiny, "dtw-py", "loo")
    b = bench.evaluate(tiny, "dtw-py", "loo", jobs=2)
    assert a["confusion"] == b["confusion"] and a["accuracy"] == b["accuracy"]
    assert b["params"]["timing"].startswith("rough") and a["params"]["timing"] == "single process"


def test_ridge_scores_are_probabilities():
    s = ridge_scores(np.array([[0.9, -0.8, -1.2], [-1.5, -1.5, -1.5]]), 3)
    np.testing.assert_allclose(s.sum(axis=1), 1)
    assert s[0].argmax() == 0 and s[0, 2] == 0
    np.testing.assert_allclose(s[1], 1 / 3)  # all clipped to 0 -> uniform
    np.testing.assert_allclose(ridge_scores(np.array([0.5]), 2), [[0.25 / 1, 0.75 / 1]])


def test_minirocket_loso_on_synthetic(synthetic):
    # fewer kernels than the bench default (10k) to keep CI quick; most of the time is numba compiling
    m = bench.evaluate(synthetic, "minirocket", "loso", model_kw={"n_kernels": 2000})
    assert validate_metrics(m) == []
    assert m["accuracy"] >= 0.9, m["accuracy"]


def test_cnn_without_torch_is_a_clear_error(monkeypatch, capsys):
    monkeypatch.setattr(bench, "torch_available", lambda: False)
    assert bench.main(["--model", "cnn"]) == 2
    assert "uv sync --extra cnn" in capsys.readouterr().err


@needs_torch
def test_cnn_is_seeded(synthetic):
    from silent.models.cnn import CnnModel
    from silent.preprocess import apply_norm, fit_norm, preprocess_clips

    X = preprocess_clips(synthetic.clips[::3])
    y = [c.label for c in synthetic.clips[::3]]
    Xn = apply_norm(X, fit_norm(X))
    p1 = CnnModel(seed=1, max_epochs=4).fit(Xn, y).predict(Xn[:5])
    p2 = CnnModel(seed=1, max_epochs=4).fit(Xn, y).predict(Xn[:5])
    assert [p.top for p in p1] == [p.top for p in p2]
    assert all(0 <= p.confidence <= 1 and len(p.top) == 3 for p in p1)


@needs_torch
def test_cnn_augment_keeps_shape_and_identity_when_off():
    import torch

    from silent.models.cnn import augment

    x = torch.randn(4, 6, 64)
    g = torch.Generator().manual_seed(0)
    assert augment(x, g).shape == x.shape
    torch.testing.assert_close(augment(x, g, warp=0, bend=0, shift=0, scale=0, jitter=0), x)
    shifted = augment(x, g, warp=0, bend=0, shift=1, scale=0, jitter=0)
    assert all(
        torch.allclose(shifted[i], x[i]) or torch.allclose(shifted[i, :, 1:], x[i, :, :-1]) or torch.allclose(shifted[i, :, :-1], x[i, :, 1:])
        for i in range(4)
    )


@needs_torch
def test_cnn_loso_on_synthetic(synthetic):
    m = bench.evaluate(synthetic, "cnn", "loso")
    assert validate_metrics(m) == []
    assert m["accuracy"] >= 0.9, m["accuracy"]


def test_ridge_label_is_the_highest_decision_not_the_clipped_score():
    from silent.models.minirocket import ridge_preds

    # a and b both clip to 1 in the mapped scores; the label must still be b (the higher decision)
    p = ridge_preds(["a", "b", "c"], np.array([[1.2, 1.5, -1.0]]))[0]
    assert p.label == "b" and p.confidence == 0.5 and [x[0] for x in p.top] == ["b", "a", "c"]
    assert ridge_preds(["a", "b"], np.array([-0.3]))[0].label == "a"  # binary: sklearn's 1-D decision


# ---------- real data smoke (2 sessions x 2 classes; full real runs are not part of pytest) ----------

def test_real_smoke_loso_and_cross_bud(real_smoke):
    m = bench.evaluate(real_smoke, "dtw-py", "loso")
    assert validate_metrics(m) == [] and m["nClips"] == 60
    pr = m["params"]
    assert pr["budNorm"] == "mirror" and pr["buds"] == {"s1": "right", "s2": "left"}
    assert pr["exclude"] == "data/raw/exclude.json" and len(pr["excludeIds"]) == 18 and pr["sources"] == ["airpods"]
    assert sum(v["n"] for v in pr["perSession"].values()) == 60
    assert sum(v["correct"] for v in pr["perSession"].values()) == round(m["accuracy"] * 60)
    assert m["accuracy"] >= 0.8, m["accuracy"]  # two very different sentences, even across buds

    x = bench.cross_bud(real_smoke, "dtw-py")
    assert x["protocol"] == "xbud" and x["nClips"] == 30 and x["params"]["budNorm"] == "mirror"
    v = x["params"]["variants"]
    assert set(v) == {"mirror", "none"} and v["mirror"]["accuracy"] == x["accuracy"]
    assert v["none"]["nClips"] == 30 and v["none"]["confusion"] != v["mirror"]["confusion"]  # mirroring changes predictions


def test_real_smoke_luck_test_reproduces_the_bench_and_is_seeded(real_smoke):
    from silent.luck import luck_test

    X, _ = bench.preprocess_corpus(real_smoke, bench.DEFAULT_OPTS)
    m = bench.evaluate(real_smoke, "dtw-py", "loso")
    a = luck_test(real_smoke, "dtw-py", X, n=30, seed=1, real=m)
    assert a["realCorrect"] == round(m["accuracy"] * 60) and a["nClips"] == 60
    assert sum(a["shuffledCorrectHistogram"].values()) == 30
    assert a["pValue"] == (1 + a["atLeastReal"]) / 31 and 0.2 < a["shuffledMean"] < 0.8  # 2 classes: chance is about 50%
    assert a == luck_test(real_smoke, "dtw-py", X, n=30, seed=1)
    bad = {**m, "confusion": [[1, 0], [0, 59]]}
    with pytest.raises(RuntimeError):
        luck_test(real_smoke, "dtw-py", X, n=1, real=bad)


def test_luck_test_minirocket_path_matches_the_model(real_smoke):
    from silent.luck import luck_test

    kw = {"n_kernels": 840, "seed": 0}
    X, _ = bench.preprocess_corpus(real_smoke, bench.DEFAULT_OPTS)
    m = bench.evaluate(real_smoke, "minirocket", "loso", model_kw=kw)
    a = luck_test(real_smoke, "minirocket", X, n=3, model_kw=kw, real=m)  # raises if the unshuffled path differs
    assert a["n"] == 3 and a["realAccuracy"] == m["accuracy"]


def test_dtw_luck_fast_path_equals_classify():
    from silent.luck import DtwFold
    from silent.models.dtw import classify

    rng = np.random.default_rng(3)
    X = rng.normal(size=(12, 2, 16))
    y = np.array(list("aabbccaabbcc"), dtype=object)
    tr, te = np.arange(8), np.arange(8, 12)
    for k in (1, 3):
        f = DtwFold(X, tr, te, "global", k=k)
        f.D[0, 2] = f.D[0, 0] = f.D[0].min()  # a tie between an a and a b template: the earlier one wins
        labels = sorted(set(y[tr]))
        idx = np.array([labels.index(v) for v in y[tr]])
        assert f.predict(y[tr]) == [classify(d, idx, labels, k).label for d in f.D]


def test_fold_permutations_are_seeded_permutations():
    from silent.luck import fold_permutations

    folds = [(np.arange(5), np.arange(5, 7)), (np.arange(3), np.arange(3, 4))]
    a, b = fold_permutations(folds, 4, 7), fold_permutations(folds, 4, 7)
    assert all(np.array_equal(x, y) for pa, pb in zip(a, b) for x, y in zip(pa, pb))
    assert all(sorted(p[0].tolist()) == list(range(5)) and sorted(p[1].tolist()) == list(range(3)) for p in a)


def test_results_go_to_the_right_folder(synthetic, real_smoke):
    assert bench.default_out(synthetic) == bench.SYNTHETIC_RESULTS_DIR
    assert bench.default_out(real_smoke) == bench.RESULTS_DIR


def test_cli_refuses_raw_data_without_the_exclude_list(tmp_path, capsys):
    from tests.conftest import REAL_FILES

    assert bench.main(["--data", str(REAL_FILES[0]), "--out", str(tmp_path)]) == 2
    assert "--exclude" in capsys.readouterr().err
    assert not list(tmp_path.iterdir())


def test_cli_real_luck_and_xbud_write_files(tmp_path, monkeypatch):
    from tests.conftest import REAL_FILES

    real_smoke = load_corpus(REAL_FILES[:2], exclude=bench.EXCLUDE_FILE).select(labels=["text_mom", "volume_up"])
    monkeypatch.setattr(bench, "load_corpus", lambda data, exclude=None: real_smoke)
    rc = bench.main(["--real", "--protocol", "loso", "xbud", "--permutations", "5", "--out", str(tmp_path)])
    assert rc == 0
    m = json.loads((tmp_path / "dtw-py" / "loso.json").read_text())
    assert m["params"]["permutation"]["n"] == 5 and (tmp_path / "dtw-py" / "luck_loso.png").stat().st_size > 1000
    x = json.loads((tmp_path / "dtw-py" / "xbud.json").read_text())
    assert validate_metrics(x) == [] and set(x["params"]["variants"]) == {"mirror", "none"}


def test_seed_spread_keeps_the_first_seed_as_the_result(real_smoke):
    kw = {"n_kernels": 840, "seed": 3}
    m = bench.evaluate(real_smoke, "minirocket", "loso", model_kw=kw)
    sp = bench.seed_spread(real_smoke, "minirocket", bench.DEFAULT_OPTS, 0.5, kw, m, 2)
    assert sp["seeds"] == [3, 4] and sp["correct"][0] == round(m["accuracy"] * 60) and sp["nClips"] == 60
    assert sp["min"] <= m["accuracy"] <= sp["max"] and sp["mean"] == pytest.approx(sum(sp["correct"]) / 120)
