import math

import numpy as np
import pytest

from silent.models.dtw import DtwKnn, band_radius, classify, dtw, dtw_many, dtw_pairs, reference_distance, same_class_nn


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


def test_dtw_pairs_matches_reference_and_chunks():
    rng = np.random.default_rng(5)
    A, B = rng.normal(size=(2, 7, 3, 16))
    want = [dtw(a, b, 2) for a, b in zip(A, B)]
    np.testing.assert_allclose(dtw_pairs(A, B, 2), want, rtol=1e-12)
    np.testing.assert_allclose(dtw_pairs(A, B, 2, chunk=3), want, rtol=1e-12)


def test_same_class_nn_and_dref():
    rng = np.random.default_rng(6)
    X = rng.normal(size=(6, 2, 12))
    y = np.array([0, 1, 0, 0, 1, 2])
    nn = same_class_nn(X, y, 2)
    for i in range(6):
        others = [dtw(X[i], X[j], 2) for j in range(6) if j != i and y[j] == y[i]]
        assert nn[i] == pytest.approx(min(others)) if others else nn[i] == np.inf
    assert reference_distance(np.array([1.0, 3.0, np.inf, 2.0])) == 2.0  # median of the finite ones
    assert reference_distance(np.array([1.0, 2.0, 3.0, 4.0])) == 2.5
    assert reference_distance(np.array([np.inf])) is None


def test_vote_ties_and_unsafe_cap():
    # k = 3, no dRef (unsafe): a = 1/0.5 + 1/1 = 3, b = 1/2 -> label a; confidence capped at threshold / 2
    p = classify(np.array([1.0, 2.0, 0.5, 10.0]), np.array([0, 1, 0, 1]), ["a", "b"], k=3, ref=None, threshold=0.5)
    assert p.label == "a" and p.confidence == 0.25
    # the vote decides, not the single nearest template (b has it, a has more weight)
    assert classify(np.array([1.0, 1.1, 0.9]), np.array([0, 0, 1]), ["a", "b"], k=3, ref=1.0, energy=99).label == "a"
    # equal votes and equal distances -> sorted label order, whatever the template order
    assert classify(np.array([1.0, 1.0]), np.array([1, 0]), ["a", "b"], k=2, ref=1.0, energy=99).label == "a"
    assert classify(np.array([1.0]), np.array([0]), ["a"], ref=1.0).confidence <= 0.25  # one class: unsafe


def test_confidence_hand_values_close_clip():
    # k = 1, dRef = 1 -> T = 0.1; nearest a = 1.0, b = 2.0; unknown at 1.7; stillness at 1.25 * 10
    p = classify(np.array([1.0, 2.0]), np.array([0, 1]), ["a", "b"], k=1, ref=1.0, energy=10.0)
    z = 1 + math.exp(-10) + math.exp(-7) + math.exp(-115)
    assert p.label == "a" and p.confidence == pytest.approx(1 / z, rel=1e-12)
    assert p.top == [("a", pytest.approx(1 / z)), ("b", pytest.approx(math.exp(-10) / z))]


def test_confidence_drops_far_from_every_template():
    p = classify(np.array([3.0, 3.5]), np.array([0, 1]), ["a", "b"], k=1, ref=1.0, energy=10.0)
    assert p.label == "a" and p.confidence < 1e-5  # 3 x dRef away: "unknown" (1.7 x dRef) wins the softmax


def test_stillness_backs_none():
    # quiet clip (energy 1 -> stillness at 1.25) nearest to none (1.5): none gets its own share + stillness
    labels = ["a", "none"]
    p = classify(np.array([2.0, 1.5]), np.array([0, 1]), labels, k=1, ref=1.0, energy=1.0)
    e = math.exp
    z = 1 + e(-2.5) + e(-4.5) + e(-7.5)
    assert p.label == "none" and p.confidence == pytest.approx((e(-2.5) + 1) / z, rel=1e-12)
    # the same quiet clip nearest to "a" is not accepted: stillness counts against it
    p = classify(np.array([1.5, 2.0]), np.array([0, 1]), labels, k=1, ref=1.0, energy=1.0)
    assert p.label == "a" and p.confidence == pytest.approx(e(-2.5) / z, rel=1e-12) and p.confidence < 0.5


def test_dtw_model_fits_and_predicts(synthetic):
    from silent.preprocess import apply_norm, fit_norm, preprocess_clips

    X = preprocess_clips(synthetic.clips[:24])
    st = fit_norm(X)
    y = [c.label for c in synthetic.clips[:24]]
    m = DtwKnn().fit(apply_norm(X, st), y)
    assert m.radius == 6
    preds = m.predict(apply_norm(X[:3], st))
    assert [p.label for p in preds] == y[:3]  # a clip's nearest template is itself


def test_matches_js_dtw_knn_clip_by_clip(synthetic):
    """Parity with the JS classifier: same label and confidence for every held out clip (LOSO, defaults).
    Regenerate tests/data/js_dtw_knn_loso.json from the JS (`crossValidate(clips, {}, 'loso')`) if knn.ts changes."""
    import json
    from pathlib import Path

    from silent.bench import run_fold
    from silent.cv import splits
    from silent.preprocess import preprocess_clip

    js = json.loads((Path(__file__).parent / "data" / "js_dtw_knn_loso.json").read_text())["preds"]
    X = np.stack([preprocess_clip(c.samples) for c in synthetic.clips])
    y = np.array([c.label for c in synthetic.clips], dtype=object)
    got = {}
    for tr, te in splits("loso", [c.session for c in synthetic.clips]):
        preds, _, _ = run_fold("dtw-py", {}, "global", X, y, tr, te)
        got.update({synthetic.clips[i].id: p for i, p in zip(te, preds)})
    assert len(js) == len(got) == 120
    for cid, label, conf in js:
        assert got[cid].label == label, cid
        assert got[cid].confidence == pytest.approx(conf, abs=1e-9), cid


def test_matches_js_dtw_knn_on_real_data_with_bud_mirroring(real_smoke):
    """Same as above on real AirPods clips: s1 (right bud, mirrored by step 0) + s2 (left bud), 2 classes, LOSO.
    Regenerate tests/data/js_dtw_knn_real_smoke_loso.json from the JS (see its `_from`) if knn.ts or preprocess.ts change."""
    import json
    from pathlib import Path

    from silent.bench import run_fold
    from silent.cv import splits
    from silent.preprocess import preprocess_clip

    js = json.loads((Path(__file__).parent / "data" / "js_dtw_knn_real_smoke_loso.json").read_text())
    assert js["opts"] == {}  # JS defaults = Python defaults (budNorm mirror, L 64, band 0.1, k 1, global norm)
    clips = real_smoke.clips
    X = np.stack([preprocess_clip(c.samples, loc=c.loc) for c in clips])
    y = np.array([c.label for c in clips], dtype=object)
    got = {}
    for tr, te in splits("loso", [c.session for c in clips]):
        preds, _, _ = run_fold("dtw-py", {}, "global", X, y, tr, te)
        got.update({clips[i].id: p for i, p in zip(te, preds)})
    assert len(js["preds"]) == len(got) == 60
    for cid, label, conf in js["preds"]:
        assert got[cid].label == label, cid
        assert got[cid].confidence == pytest.approx(conf, abs=1e-9), cid
