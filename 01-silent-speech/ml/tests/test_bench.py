import json

import numpy as np
import pytest

from silent import bench
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
    assert m["params"]["band"] == 0.1 and m["params"]["k"] == 3 and m["params"]["L"] == 64
    p = bench.write_result(m, tmp_path)
    assert p == tmp_path / "dtw-py" / "loso.json"
    assert validate_metrics(json.loads(p.read_text())) == []
    assert (tmp_path / "dtw-py" / "confusion_loso.png").stat().st_size > 1000


def test_cli_writes_results(tmp_path, capsys):
    rc = bench.main(["--model", "dtw-py", "--protocol", "loo", "--data", str(TINY), "--out", str(tmp_path)])
    assert rc == 0
    m = json.loads((tmp_path / "dtw-py" / "loo.json").read_text())
    assert m["nClips"] == 6 and m["params"]["data"] == ["shared/fixtures/dataset.tiny.json"]
    assert "dtw-py" in capsys.readouterr().out


def test_parallel_folds_give_identical_predictions(tiny):
    a = bench.evaluate(tiny, "dtw-py", "loo")
    b = bench.evaluate(tiny, "dtw-py", "loo", jobs=2)
    assert a["confusion"] == b["confusion"] and a["accuracy"] == b["accuracy"]


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
