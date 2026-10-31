import numpy as np
import pytest

from silent.models.dtw import DtwKnn, band_radius, dtw, dtw_many, knn_vote


def test_band_radius():
    assert band_radius(0.1, 64) == 6  # PROTOCOL §6
    assert band_radius(0.05, 64) == 3  # floor(3.2 + 0.5)
    assert band_radius(0.2, 48) == 10  # floor(9.6 + 0.5)
    assert band_radius(0.0, 64) == 1  # never below 1
    assert band_radius(0.078125, 64) == 5  # 5.0 + 0.5 -> 5


def test_dtw_hand_value_single_channel():
    a = np.array([[0.0, 0, 1, 2]])
    b = np.array([[0.0, 1, 2, 2]])
    assert np.sum((a - b) ** 2) == 2  # lock step
    assert dtw(a, b, 1) == 0  # warping lines them up


def test_dtw_is_dependent_multivariate():
    # Each channel alone could warp to 0, but they need opposite warps: one shared path costs 2.
    a = np.array([[0.0, 1, 1], [0.0, 0, 1]])
    b = np.array([[0.0, 0, 1], [0.0, 1, 1]])
    assert dtw(a[:1], b[:1], 1) == 0 and dtw(a[1:], b[1:], 1) == 0
    assert dtw(a, b, 1) == 2


def test_dtw_returns_total_cost_not_normalized():
    a = np.zeros((2, 10))
    b = np.ones((2, 10))
    assert dtw(a, b, 1) == pytest.approx(2 * 10)  # 10 diagonal cells x 2 channels x 1


def test_dtw_identity_symmetry():
    rng = np.random.default_rng(0)
    a, b = rng.normal(size=(2, 6, 32))
    assert dtw(a, a, 3) == 0
    assert dtw(a, b, 3) == pytest.approx(dtw(b, a, 3))
    assert dtw(a, b, 3) <= np.sum((a - b) ** 2) + 1e-12  # diagonal is always allowed


def test_band_limits_warping():
    a = np.zeros((1, 20))
    a[0, 5] = 1
    b = np.zeros((1, 20))
    b[0, 12] = 1  # 7 steps apart
    assert dtw(a, b, 7) == 0
    assert dtw(a, b, 6) > 0


@pytest.mark.parametrize("r", [1, 3, 6, 70])
def test_vectorized_matches_reference(r):
    rng = np.random.default_rng(r)
    q = rng.normal(size=(6, 24))
    T = rng.normal(size=(5, 6, 24))
    np.testing.assert_allclose(dtw_many(q, T, r), [dtw(q, t, r) for t in T], rtol=1e-12)


def test_warped_copy_is_closer_than_other_class():
    t = np.linspace(0, 1, 64)
    bump = lambda c: np.exp(-((t - c) ** 2) / 0.003)
    a = np.stack([bump(0.4), -bump(0.4)])
    warped = np.stack([bump(0.45), -bump(0.45)])
    other = np.stack([-bump(0.4), bump(0.4)])
    d = dtw_many(a, np.stack([warped, other]), band_radius(0.1, 64))
    assert d[0] < d[1]


def test_knn_distance_weighted_vote():
    p = knn_vote(np.array([1.0, 2.0, 0.5, 10.0]), ["a", "b", "a", "b"], k=3)
    # neighbours: a (0.5), a (1.0), b (2.0) -> a = 1/0.5 + 1/1 = 3, b = 0.5
    assert p.label == "a"
    assert p.confidence == pytest.approx(3 / 3.5)
    assert [lab for lab, _ in p.top] == ["a", "b"]
    assert p.top[1][1] == pytest.approx(0.5 / 3.5)


def test_knn_tie_goes_to_nearest():
    p = knn_vote(np.array([1.0, 1.0]), ["b", "a"], k=2)
    assert p.label == "b" and p.confidence == pytest.approx(0.5)


def test_knn_exact_match_dominates():
    p = knn_vote(np.array([0.0, 0.1, 0.1]), ["a", "b", "b"], k=3)
    assert p.label == "a" and p.confidence > 0.999


def test_dtw_model_fits_and_predicts(synthetic):
    from silent.preprocess import apply_norm, fit_norm, preprocess_clips

    X = preprocess_clips(synthetic.clips[:24])
    st = fit_norm(X)
    y = [c.label for c in synthetic.clips[:24]]
    m = DtwKnn().fit(apply_norm(X, st), y)
    assert m.radius == 6
    preds = m.predict(apply_norm(X[:3], st))
    assert [p.label for p in preds] == y[:3]  # a clip's nearest template is itself
