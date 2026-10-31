import numpy as np
import pytest

from silent import bench
from silent.cv import loo, loso, splits
from silent.models import Model, Pred
from silent.preprocess import fit_norm as real_fit_norm


def _check_partition(folds, n):
    tests = np.concatenate([te for _, te in folds])
    assert sorted(tests.tolist()) == list(range(n))  # every clip tested exactly once
    for tr, te in folds:
        assert not set(tr) & set(te)
        assert len(tr) + len(te) == n


def test_loo():
    folds = list(loo(5))
    assert len(folds) == 5
    assert all(len(te) == 1 for _, te in folds)
    _check_partition(folds, 5)


def test_loso_never_leaks_a_session(synthetic):
    sessions = [c.session for c in synthetic.clips]
    folds = list(loso(sessions))
    assert len(folds) == 3
    _check_partition(folds, len(sessions))
    for tr, te in folds:
        test_sessions = {sessions[i] for i in te}
        assert len(test_sessions) == 1
        assert not test_sessions & {sessions[i] for i in tr}
        assert len(te) == sum(s in test_sessions for s in sessions)  # the whole session is held out


def test_loso_interleaved_sessions():
    sessions = ["b", "a", "b", "c", "a", "c", "b"]
    for tr, te in splits("loso", sessions):
        assert len({sessions[i] for i in te}) == 1
        assert not {sessions[i] for i in te} & {sessions[i] for i in tr}


def test_loso_needs_two_sessions():
    with pytest.raises(ValueError):
        list(loso(["s1", "s1"]))


class LeakDetector(Model):
    """Fails if a test clip (or its session) was seen in training."""

    name = "leak"

    def fit(self, X, y):
        self.train = X.copy()
        return self

    def predict(self, X):
        for x in X:
            assert not any(np.allclose(x, t) for t in self.train), "test clip was in the training fold"
        return [Pred("none", 1.0, [("none", 1.0)]) for _ in X]

    def params(self):
        return {}


@pytest.mark.parametrize("protocol", ["loo", "loso"])
def test_evaluate_fits_norm_and_model_on_train_only(synthetic, monkeypatch, protocol):
    calls = []

    def spy_fit_norm(X, mode="global"):
        calls.append(len(X))
        return real_fit_norm(X, mode)

    monkeypatch.setattr(bench, "make_model", lambda name, **kw: LeakDetector())
    monkeypatch.setattr(bench, "fit_norm", spy_fit_norm)
    m = bench.evaluate(synthetic, "dtw-py", protocol)
    n = len(synthetic.clips)
    assert m["nClips"] == n
    assert calls == ([n - 1] * n if protocol == "loo" else [80, 80, 80])
