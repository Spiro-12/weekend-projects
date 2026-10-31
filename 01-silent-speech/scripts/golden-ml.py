"""Golden values for the JS preprocessing + DTW (PROTOCOL.md §5 incl. step 0 bud normalization, §6), made with real scipy.

Run from 01-silent-speech/:
    uv run --no-project --with scipy==1.18.1 --with numpy==2.5.4 python -I scripts/golden-ml.py
Writes tests/unit/ml/golden.json. tests/unit/ml/golden.test.ts checks the JS against it to 1e-6.

This is an independent reference written straight from the spec text, using scipy.signal.butter,
scipy.signal.lfilter_zi, scipy.signal.filtfilt and np.interp.
"""
import json
from pathlib import Path

import numpy as np
import scipy
from scipy import signal

ROOT = Path(__file__).resolve().parent.parent
GRID_HZ = 50
CH = {'rr.x': ('rr', 0), 'rr.y': ('rr', 1), 'rr.z': ('rr', 2), 'ua.x': ('ua', 0), 'ua.y': ('ua', 1), 'ua.z': ('ua', 2)}
DEFAULT_CH = list(CH)


def to_grid(samples, channels):
    t = np.array([s['t'] for s in samples], float)
    order = np.argsort(t, kind='stable')
    ts = t[order]
    keep = np.ones(len(ts), bool)
    keep[1:] = np.diff(ts) > 0  # drop duplicate t, keep the first
    idx, ts = order[keep], ts[keep]
    n = int(np.floor((ts[-1] - ts[0]) * GRID_HZ + 1e-9)) + 1
    tg = ts[0] + np.arange(n) / GRID_HZ
    return np.array([np.interp(tg, ts, [samples[j][CH[c][0]][CH[c][1]] for j in idx]) for c in channels])


def highpass(x, hp):
    b, a = signal.butter(2, hp, 'highpass', fs=GRID_HZ)
    n = x.shape[-1]
    return signal.filtfilt(b, a, x, axis=-1, padtype='odd', padlen=min(9, n - 1))


def resample(x, L):
    n = x.shape[-1]
    pos = np.arange(L) * (n - 1) / (L - 1)
    return np.array([np.interp(pos, np.arange(n), row) for row in x])


def raw(samples, channels=DEFAULT_CH, L=64, hp=1.0):
    return resample(highpass(to_grid(samples, channels), hp), L)


def mirror(samples):
    """Step 0 for a right bud clip (budNorm 'mirror'): rr -> [x, -y, -z], ua -> [-x, y, z]."""
    return [{**s, 'rr': [s['rr'][0], -s['rr'][1], -s['rr'][2]], 'ua': [-s['ua'][0], s['ua'][1], s['ua'][2]]} for s in samples]


def norm_global(raws):
    allv = np.concatenate([r for r in raws], axis=1)  # (ch, nClips * L)
    return allv.mean(axis=1), np.maximum(allv.std(axis=1), 1e-8)


def norm_clip_floor(raws):
    return 0.5 * np.median(np.array([r.std(axis=1) for r in raws]), axis=0)


def apply_clip(r, floor):
    return (r - r.mean(axis=1, keepdims=True)) / np.maximum(r.std(axis=1, keepdims=True), floor[:, None])


def dtw_ref(a, b, r):
    """Plain full matrix DTW, dependent, squared Euclidean summed over channels, Sakoe-Chiba |i-j| <= r."""
    n, m = a.shape[1], b.shape[1]
    D = np.full((n + 1, m + 1), np.inf)
    D[0, 0] = 0.0
    for i in range(1, n + 1):
        for j in range(max(1, i - r), min(m, i + r) + 1):
            cost = float(np.sum((a[:, i - 1] - b[:, j - 1]) ** 2))
            D[i, j] = cost + min(D[i - 1, j - 1], D[i - 1, j], D[i, j - 1])
    return float(D[n, m])


def r5(x):
    return float(round(float(x), 5))


def fake_samples(rng, n, hz, jitter, shuffle=False, dup=False, drop=0.0):
    out, t = [], 100.0 + rng.uniform(0, 1)
    for i in range(n):
        t += 1.0 / hz + rng.normal(0, jitter)
        if drop and rng.uniform() < drop:
            continue
        ph = 2 * np.pi * i / hz
        out.append({
            'seq': i, 't': r5(t), 'q': [1, 0, 0, 0],
            'rr': [r5(0.3 * np.sin(3 * ph) + 0.2 + rng.normal(0, 0.02)), r5(0.1 * np.cos(7 * ph) + rng.normal(0, 0.02)), r5(0.05 * ph + rng.normal(0, 0.01))],
            'ua': [r5(0.01 * np.sin(5 * ph) + rng.normal(0, 0.002)), r5(-0.02 + rng.normal(0, 0.003)), r5(0.004 * np.sin(0.2 * ph))],
        })
    if dup:
        out.insert(5, {**out[4], 'rr': [9, 9, 9], 'ua': [9, 9, 9]})  # same t as out[4]: must be dropped
    if shuffle:
        rng.shuffle(out)
    return out


def main():
    rng = np.random.default_rng(1234)
    g = {'generator': 'scripts/golden-ml.py', 'scipy': scipy.__version__, 'numpy': np.__version__}

    g['butter'] = []
    for fc in [0.5, 1.0, 2.0, 5.0]:
        b, a = signal.butter(2, fc, 'highpass', fs=GRID_HZ)
        g['butter'].append({'fc': fc, 'b': b.tolist(), 'a': a.tolist(), 'zi': signal.lfilter_zi(b, a).tolist()})

    b, a = signal.butter(2, 1.0, 'highpass', fs=GRID_HZ)
    g['filtfilt'] = []
    for n in [2, 3, 5, 9, 10, 11, 30, 64, 150]:
        x = np.cumsum(rng.normal(0, 1, n)) + 3.0
        g['filtfilt'].append({'x': x.tolist(), 'padlen': min(9, n - 1), 'y': signal.filtfilt(b, a, x, padtype='odd', padlen=min(9, n - 1)).tolist()})

    cases = [
        ('25hz-jitter-unsorted-dup', fake_samples(rng, 60, 25, 0.004, shuffle=True, dup=True)),
        ('50hz', fake_samples(rng, 120, 50, 0.001)),
        ('25hz-drops', fake_samples(rng, 80, 25, 0.002, drop=0.15)),
        ('short-10', fake_samples(rng, 10, 25, 0.0)),
    ]
    # exactly on the grid: the last point must be included (the 1e-9 in the formula)
    on = [{'seq': i, 't': r5(10 + i * 0.04), 'q': [1, 0, 0, 0], 'rr': [r5(np.sin(i)), r5(np.cos(i)), r5(i * 0.01)], 'ua': [r5(0.1 * np.sin(2 * i)), 0.0, r5(0.01 * i)]} for i in range(26)]
    cases.append(('on-grid', on))
    g['grid'] = []
    for name, s in cases:
        g['grid'].append({'name': name, 'samples': s, 'grid': to_grid(s, DEFAULT_CH).tolist()})

    g['raw'] = []
    for name, s in cases:
        for L, hp, chans in [(64, 1.0, DEFAULT_CH), (48, 1.0, DEFAULT_CH), (96, 2.0, ['ua.z', 'rr.x'])]:
            g['raw'].append({'name': name, 'L': L, 'hpHz': hp, 'channels': chans, 'x': raw(s, chans, L, hp).tolist()})

    # Norm stats on real fixture clips (looked up by id in shared/fixtures/dataset.synthetic.json)
    ds = json.loads((ROOT / 'shared/fixtures/dataset.synthetic.json').read_text())
    clips = ds['clips'][:6]
    ids = [c['id'] for c in clips]
    raws = [raw(c['samples']) for c in clips]
    mean, std = norm_global(raws)
    floor = norm_clip_floor(raws)
    g['norm'] = {
        'ids': ids,
        'raw0': raws[0].tolist(),
        'global': {'mean': mean.tolist(), 'std': std.tolist(), 'x0': ((raws[0] - mean[:, None]) / std[:, None]).tolist()},
        'clip': {'floor': floor.tolist(), 'x0': apply_clip(raws[0], floor).tolist()},
    }

    g['dtw'] = []
    for n, m, C, r in [(64, 64, 6, 0), (64, 64, 6, 1), (64, 64, 6, 6), (64, 64, 2, 64), (20, 20, 3, 3), (12, 15, 2, 2)]:
        A = rng.normal(0, 1, (C, n))
        B = rng.normal(0, 1, (C, m))
        A32, B32 = A.astype(np.float32).astype(float), B.astype(np.float32).astype(float)  # JS passes Float32Array
        g['dtw'].append({'a': A32.tolist(), 'b': B32.tolist(), 'r': r, 'd': dtw_ref(A32, B32, max(r, abs(n - m)))})

    # Step 0 (bud normalization): a right bud clip, mirrored then steps 1-4. Added last so the values above don't move.
    g['budnorm'] = []
    for name, s in cases[1:3]:
        for L, hp, chans in [(64, 1.0, DEFAULT_CH), (48, 1.0, ['ua.x', 'rr.y', 'ua.z'])]:
            g['budnorm'].append({'name': name, 'loc': 'right', 'L': L, 'hpHz': hp, 'channels': chans, 'x': raw(mirror(s), chans, L, hp).tolist()})

    out = ROOT / 'tests/unit/ml/golden.json'
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(g) + '\n')
    print('wrote', out.relative_to(ROOT), f'{out.stat().st_size / 1024:.0f} KB')


if __name__ == '__main__':
    main()
