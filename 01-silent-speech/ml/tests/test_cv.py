import numpy as np
import pytest

from silent import bench
from silent.cv import loo, loso, splits, xbud
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


def test_xbud_trains_on_left_tests_on_right():
    sessions = ["s1", "s1", "s2", "s3", "s2", "s4"]
    buds = ["right", "right", "left", "left", "left", "default"]
    (tr, te), = list(xbud(sessions, buds))
    assert tr.tolist() == [2, 3, 4] and te.tolist() == [0, 1]  # the default bud session sits out


def test_xbud_refuses_a_session_on_both_buds_and_one_sided_data():
    with pytest.raises(ValueError, match="both buds"):
        list(xbud(["s1", "s1", "s2"], ["right", "left", "left"]))
    with pytest.raises(ValueError, match="needs left and right"):
        list(xbud(["s1", "s2"], ["left", "left"]))
    with pytest.raises(ValueError):
        list(splits("xbud", ["s1", "s2"]))  # buds missing


def test_xbud_on_real_data_is_s2_s3_to_s1(real):
    (tr, te), = list(splits("xbud", [c.session for c in real.clips], [c.loc for c in real.clips]))
    assert {real.clips[i].session for i in tr} == {"s2", "s3"} and {real.clips[i].session for i in te} == {"s1"}
    assert len(te) == 105 and len(tr) == 237


def test_evaluate_xbud_fits_on_left_only_and_scores_right_only(real_smoke, monkeypatch):
    calls = []

    def spy_fit_norm(X, mode="global"):
        calls.append(len(X))
        return real_fit_norm(X, mode)

    monkeypatch.setattr(bench, "make_model", lambda name, **kw: LeakDetector())
    monkeypatch.setattr(bench, "fit_norm", spy_fit_norm)
    m = bench.evaluate(real_smoke, "dtw-py", "xbud")
    n_right = sum(c.loc == "right" for c in real_smoke.clips)
    assert calls == [len(real_smoke.clips) - n_right] and m["nClips"] == n_right
    assert m["params"]["xbud"]["trainSessions"] == ["s2"] and m["params"]["xbud"]["testSessions"] == ["s1"]
    assert list(m["params"]["perSession"]) == ["s1"]
