"""PROTOCOL.md §5, checked against hand computed values and a plain loop re-implementation of the spec."""

import math

import numpy as np
import pytest
from scipy.signal import lfilter_zi

from silent.preprocess import (
    GRID_HZ,
    PreOpts,
    apply_norm,
    butter_highpass,
    fit_norm,
    highpass,
    mirror_samples,
    mirror_signs,
    preprocess_clip,
    preprocess_clips,
    resample,
    to_grid,
)


def S(t, rx=0.0, ry=0.0, rz=0.0, ax=0.0, ay=0.0, az=0.0):
    return {"seq": 0, "t": t, "q": [1, 0, 0, 0], "rr": [rx, ry, rz], "ua": [ax, ay, az]}


# ---------- step 1 + 2: 50 Hz grid ----------

def test_grid_is_50hz():
    assert GRID_HZ == 50


def test_grid_25hz_input_is_upsampled_linearly():
    g = to_grid([S(0.0, rx=0), S(0.04, rx=1), S(0.08, rx=2), S(0.12, rx=3)], ["rr.x"])
    assert g.shape == (1, 7)  # k = 0..floor(0.12 * 50 + 1e-9) = 6
    np.testing.assert_allclose(g[0], [0, 0.5, 1, 1.5, 2, 2.5, 3], atol=1e-12)


def test_grid_sorts_and_drops_duplicate_t_keeping_the_first():
    g = to_grid([S(0.04, rx=1), S(0.0, rx=0), S(0.04, rx=99), S(0.08, rx=2)], ["rr.x"])
    np.testing.assert_allclose(g[0], [0, 0.5, 1, 1.5, 2], atol=1e-12)


def test_grid_includes_last_point_despite_float_error():
    # (9.81695 - 9.71695) * 50 = 4.99999999999998 -> the + 1e-9 makes it k = 0..5 (6 points)
    assert (9.81695 - 9.71695) * 50 < 5
    g = to_grid([S(9.71695, rx=0), S(9.81695, rx=1)], ["rr.x"])
    assert g.shape == (1, 6)


def test_grid_stops_before_t_last_when_off_grid():
    g = to_grid([S(0.0, rx=0), S(0.05, rx=5)], ["rr.x"])  # floor(2.5) = 2 -> t = 0, 0.02, 0.04
    np.testing.assert_allclose(g[0], [0, 2, 4], atol=1e-12)


def test_channel_order_and_selection():
    s = [S(0.0, 1, 2, 3, 4, 5, 6), S(0.02, 1, 2, 3, 4, 5, 6)]
    np.testing.assert_allclose(to_grid(s)[:, 0], [1, 2, 3, 4, 5, 6])  # rr.x rr.y rr.z ua.x ua.y ua.z
    np.testing.assert_allclose(to_grid(s, ["ua.z", "rr.y"])[:, 0], [6, 2])


# ---------- step 3: high pass ----------

def test_butterworth_coefficients_match_bilinear_formula():
    # 2nd order Butterworth high pass, bilinear transform with prewarping: K = tan(pi fc / fs)
    K = math.tan(math.pi * 1.0 / 50)
    den = 1 + math.sqrt(2) * K + K * K
    b, a = butter_highpass(1.0)
    np.testing.assert_allclose(b, [1 / den, -2 / den, 1 / den], rtol=1e-12)
    np.testing.assert_allclose(a, [1, 2 * (K * K - 1) / den, (1 - math.sqrt(2) * K + K * K) / den], rtol=1e-12)
    np.testing.assert_allclose(b, [0.91496914411, -1.82993828823, 0.91496914411], atol=1e-10)
    np.testing.assert_allclose(a, [1.0, -1.82269492520, 0.83718165126], atol=1e-10)


def _lfilter(b, a, x, zi):
    """Direct form II transposed, plain loops (what scipy.signal.lfilter does for a[0] = 1)."""
    z0, z1 = zi
    y = np.empty(len(x))
    for n, xn in enumerate(x):
        yn = b[0] * xn + z0
        z0 = b[1] * xn - a[1] * yn + z1
        z1 = b[2] * xn - a[2] * yn
        y[n] = yn
    return y


def _filtfilt_by_hand(b, a, x):
    """filtfilt(b, a, x, padtype='odd', padlen=min(9, n-1)) spelled out, as the JS must do it."""
    n = len(x)
    p = min(9, n - 1)
    # steady state of a unit step, for 2nd order: Y = H(1); zi = [b1 + b2 - (a1 + a2) Y, b2 - a2 Y]
    Y = (b[0] + b[1] + b[2]) / (1 + a[1] + a[2])
    zi = np.array([b[1] + b[2] - (a[1] + a[2]) * Y, b[2] - a[2] * Y])
    np.testing.assert_allclose(zi, lfilter_zi(b, a), atol=1e-12)
    left = [2 * x[0] - x[i] for i in range(p, 0, -1)]
    right = [2 * x[-1] - x[n - 2 - i] for i in range(p)]
    ext = np.array(left + list(x) + right)
    fwd = _lfilter(b, a, ext, zi * ext[0])
    back = _lfilter(b, a, fwd[::-1], zi * fwd[-1])[::-1]
    return back[p : p + n]


@pytest.mark.parametrize("n", [2, 5, 10, 11, 64, 137])
def test_filtfilt_matches_hand_written_version(n):
    rng = np.random.default_rng(n)
    x = rng.normal(size=n).cumsum()
    b, a = butter_highpass(1.0)
    np.testing.assert_allclose(highpass(x[None])[0], _filtfilt_by_hand(b, a, x), atol=1e-10)


def test_highpass_kills_constant_offset():
    y = highpass(np.full((1, 80), 3.7))
    np.testing.assert_allclose(y, 0, atol=1e-10)


@pytest.mark.parametrize("dur", [2.0, 3.0])
def test_highpass_kills_0p2hz_keeps_5hz(dur):
    t = np.arange(int(dur * GRID_HZ)) / GRID_HZ
    slow = np.sin(2 * np.pi * 0.2 * t + 0.3)
    fast = np.sin(2 * np.pi * 5.0 * t + 0.3)
    p = lambda v: float(np.sum(v**2))
    assert p(highpass(slow[None])[0]) < 0.01 * p(slow)  # > 99% power gone (measured: 99.99%)
    assert p(highpass(fast[None])[0]) > 0.9 * p(fast)  # measured: 97%
    both = highpass((slow + fast)[None])[0]
    np.testing.assert_allclose(both, highpass(fast[None])[0] + highpass(slow[None])[0], atol=1e-12)  # linear


# ---------- step 4: resample to L ----------

def test_resample_positions_hand_values():
    # positions j * (n - 1) / (L - 1) = 0, 0.5, 1, 1.5, 2
    np.testing.assert_allclose(resample(np.array([[0.0, 1.0, 4.0]]), 5)[0], [0, 0.5, 1, 2.5, 4], atol=1e-12)
    # downsample 5 -> 3: positions 0, 2, 4
    np.testing.assert_allclose(resample(np.array([[0.0, 9, 2, 9, 4]]), 3)[0], [0, 2, 4], atol=1e-12)
    x = np.arange(64.0)[None] ** 2
    np.testing.assert_allclose(resample(x, 64), x)


# ---------- step 5: normalize ----------

def test_global_norm_hand_values():
    X = np.array([[[1.0, 3.0], [2.0, 2.0]], [[5.0, 7.0], [2.0, 2.0]]])  # (2 clips, 2 ch, L = 2)
    st = fit_norm(X, "global")
    np.testing.assert_allclose(st.mean, [4.0, 2.0])
    np.testing.assert_allclose(st.std, [math.sqrt(5), 1e-8])  # population std of 1,3,5,7; flat channel -> floor
    Z = apply_norm(X, st)
    np.testing.assert_allclose(Z[0, 0], [-3 / math.sqrt(5), -1 / math.sqrt(5)])
    np.testing.assert_allclose(Z[:, 1], 0)
    test_clip = np.array([[4.0 + math.sqrt(5), 4.0], [2.0, 3.0]])
    np.testing.assert_allclose(apply_norm(test_clip, st)[0], [1.0, 0.0])  # train stats applied to test


def test_clip_norm_hand_values():
    # per clip std of ch0: 1, 2, 4 -> median 2 -> floor 1.0
    X = np.array([[[0.0, 2.0]], [[0.0, 4.0]], [[0.0, 8.0]]])
    st = fit_norm(X, "clip")
    np.testing.assert_allclose(st.std, [1.0])
    np.testing.assert_allclose(apply_norm(X, st)[2, 0], [-1, 1])  # own std 4 > floor
    np.testing.assert_allclose(apply_norm(np.array([[2.0, 2.2]]), st)[0], [-0.1, 0.1])  # own std 0.1 -> floor 1.0


# ---------- whole pipeline ----------

def _pipeline_by_hand(samples, L=64):
    """Steps 1 to 4 with plain loops, straight from the PROTOCOL text."""
    keys = [("rr", 0), ("rr", 1), ("rr", 2), ("ua", 0), ("ua", 1), ("ua", 2)]
    pts = sorted(samples, key=lambda s: s["t"])
    dedup = []
    for s in pts:
        if not dedup or s["t"] != dedup[-1]["t"]:
            dedup.append(s)
    t = [s["t"] for s in dedup]
    K = math.floor((t[-1] - t[0]) * 50 + 1e-9)
    out = []
    b, a = butter_highpass(1.0)
    for key, i in keys:
        v = [s[key][i] for s in dedup]
        grid, seg = [], 0
        for k in range(K + 1):
            tk = t[0] + k / 50
            while seg < len(t) - 2 and t[seg + 1] < tk:
                seg += 1
            w = (tk - t[seg]) / (t[seg + 1] - t[seg])
            w = min(max(w, 0.0), 1.0)
            grid.append(v[seg] + (v[seg + 1] - v[seg]) * w)
        hp = _filtfilt_by_hand(b, a, np.array(grid))
        n = len(hp)
        row = []
        for j in range(L):
            pos = j * (n - 1) / (L - 1)
            i0 = min(math.floor(pos), n - 2)
            row.append(hp[i0] + (hp[i0 + 1] - hp[i0]) * (pos - i0))
        out.append(row)
    return np.array(out)


def test_pipeline_matches_hand_version_on_fixture(synthetic):
    for clip in synthetic.clips[::17]:
        np.testing.assert_allclose(preprocess_clip(clip.samples), _pipeline_by_hand(clip.samples), atol=1e-9)


def test_preprocess_clips_shape(synthetic):
    X = preprocess_clips(synthetic.clips[:5], PreOpts(L=48))
    assert X.shape == (5, 6, 48)
    assert np.isfinite(X).all()


# ---------- step 0: bud normalization ----------

def test_mirror_samples_hand_values():
    s = [{"t": 0.0, "rr": [1.0, 2.0, 3.0], "ua": [4.0, 5.0, 6.0], "g": [7.0, 8.0, 9.0], "q": [1, 0, 0, 0]}]
    m = mirror_samples(s)[0]
    assert m["rr"] == [1.0, -2.0, -3.0] and m["ua"] == [-4.0, 5.0, 6.0] and m["g"] == [-7.0, 8.0, 9.0]
    assert m["q"] == [1, 0, 0, 0] and s[0]["rr"] == [1.0, 2.0, 3.0]  # copies, input untouched
    assert mirror_samples(mirror_samples(s)) == s


def test_mirror_signs():
    np.testing.assert_array_equal(mirror_signs(["rr.x", "rr.y", "rr.z", "ua.x", "ua.y", "ua.z"]), [1, -1, -1, -1, 1, 1])
    np.testing.assert_array_equal(mirror_signs(["ua.z", "rr.y"]), [1, -1])


def test_right_bud_is_bit_for_bit_the_mirrored_samples(real_smoke):
    clip = next(c for c in real_smoke.clips if c.loc == "right")
    a = preprocess_clip(clip.samples, PreOpts(), "right")
    np.testing.assert_array_equal(a, preprocess_clip(mirror_samples(clip.samples), PreOpts(), "left"))
    assert not np.allclose(a, preprocess_clip(clip.samples, PreOpts(), "left"))


@pytest.mark.parametrize("loc", ["left", "default", "unknown", None])
def test_only_right_bud_is_mirrored(synthetic, loc):
    s = synthetic.clips[0].samples
    np.testing.assert_array_equal(preprocess_clip(s, PreOpts(), loc), preprocess_clip(s))


def test_bud_norm_none_is_a_no_op(synthetic):
    s = synthetic.clips[0].samples
    np.testing.assert_array_equal(preprocess_clip(s, PreOpts(bud_norm="none"), "right"), preprocess_clip(s))
    assert PreOpts().bud_norm == "mirror" and PreOpts().as_params()["budNorm"] == "mirror"  # PROTOCOL §5 default
    with pytest.raises(ValueError):
        preprocess_clip(s, PreOpts(bud_norm="flip"), "right")  # type: ignore[arg-type]


def test_preprocess_clips_uses_each_clips_bud(real_smoke):
    clips = [c for c in real_smoke.clips if c.loc == "right"][:2] + [c for c in real_smoke.clips if c.loc == "left"][:2]
    X = preprocess_clips(clips)
    for x, c in zip(X, clips):
        np.testing.assert_array_equal(x, preprocess_clip(c.samples, PreOpts(), c.loc))
