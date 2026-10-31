# Silent Speech: model benchmark

Made by `uv run python -m silent.report` from `ml/results/` (real data) and `ml/results/synthetic/` (synthetic
fixture). Don't edit by hand. Rerun: `uv run python -m silent.bench --real --model all --protocol all`, then
`uv run python -m silent.bench --real --model dtw-py minirocket --protocol loso --permutations 500` (luck test).

- **LOSO** = leave one session out (train on the other sessions, test on a new one: closest to real use, so the
  number that matters). **LOO** = leave one clip out. **Cross bud** = train on one AirPod, test on the other.
- **None false accept** = share of true `none` clips the model accepted as an action (label is not `none` and
  confidence >= the 0.5 threshold). Each model family has its own confidence scale (DTW: vote x separation,
  MiniRocket: mapped ridge scores, CNN: softmax), so at a fixed 0.5 this column is **not comparable across
  model families**.
- **Infer ms** = per clip, preprocessing + predict, one clip at a time. `~` = rough (folds ran in parallel
  processes). JS (`dtw-knn`) is timed by its own runner. The machine was shared with other jobs: rough either way.
- Norm stats and models are always fit on the training fold only; every test clip is predicted on its own.

## Real AirPods data

Spiro's own recordings (`data/raw/`, see its README): one person, AirPods Pro 3 on a Mac, silent mouthing,
head resting against a chair. The clips in `data/raw/exclude.json` are skipped everywhere (`none` takes where
he mouthed "stay still"); the raw files are never edited.

### Data: `ss-dataset-s1-20261031-1621.json`, `ss-dataset-s2-20261031-1637.json`, `ss-dataset-s3-20261031-1654.json`

| Session | Sensor bud | Clips used | Skipped (exclusion list) |
|---|---|---:|---:|
| s1 | **right** | 105 | 15 |
| s2 | left | 117 | 3 |
| s3 | left | 120 | 0 |
| **all** | | **342** | 18 |

8 classes (`calendar`, `call_back`, `demo_48h`, `focus_music`, `help`, `none`, `text_mom`, `volume_up`), so chance is about 12.5%.

Settings (LOSO runs): **dtw-py**: L 64, 6 channels, high pass 1.0 Hz, global norm, budNorm mirror; band 0.1, k 1; **minirocket**: L 64, 6 channels, high pass 1.0 Hz, global norm, budNorm mirror; 10000 kernels, seed 0; **cnn**: L 64, 6 channels, high pass 1.0 Hz, global norm, budNorm mirror; max 300 epochs, seed 0.

#### Leave one session out (the headline)

Train on the other sessions, test on a whole new one: the closest thing to real use. Each test column is one fold.

| Model | Accuracy | Macro F1 | test s1 (right bud) | test s2 (left bud) | test s3 (left bud) | Seeds 0 to 4: mean (range) | None false accept | Infer ms/clip |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| dtw-py | 81.9% (280/342) | 0.820 | 64.8% (68/105) | 94.0% (110/117) | 85.0% (102/120) | no randomness | 3.7% (1/27) | 51.4 |
| minirocket | 76.3% (261/342) | 0.776 | 49.5% (52/105) | 92.3% (108/117) | 84.2% (101/120) | 77.8% (76.3% to 79.8%) | 0.0% (0/27) | 3.9 |
| cnn | 76.6% (262/342) | 0.780 | 51.4% (54/105) | 91.5% (107/117) | 84.2% (101/120) | 77.3% (74.9% to 81.3%) | 3.7% (1/27) | 2.1 |

Accuracy is the first seed (0), fixed before the run. MiniRocket and the CNN are random (kernels, weights), so the
seed column shows the same LOSO with other seeds: differences of a few points between models are within that spread.

- Highest LOSO on `ss-dataset-s1-20261031-1621.json`, `ss-dataset-s2-20261031-1637.json`, `ss-dataset-s3-20261031-1654.json`: **dtw-py**, 280/342 correct (81.9%).

#### Cross bud

Train on every left bud clip (s2 + s3), test on every right bud clip (s1).
**Raw** = the right bud clips as recorded. **Mirrored** = bud normalization on (PROTOCOL §5 step 0: right bud
motion mirrored into the left bud frame; the default everywhere, so this is also the LOSO fold that tests that session).

| Model | Raw | Mirrored | Gain (points) |
|---|---:|---:|---:|
| dtw-py | 31.4% (33/105) | 64.8% (68/105) | +33.3 |
| minirocket | 33.3% (35/105) | 49.5% (52/105) | +16.2 |
| cnn | 21.0% (22/105) | 51.4% (54/105) | +30.5 |

#### Luck test

Could the LOSO accuracy be luck? Each model is run through the same LOSO folds 500 more times with the
training labels shuffled inside every fold (the test labels stay true). Shuffled models score about chance.
p value = (1 + shuffles that reached the real accuracy) / (shuffles + 1). Idea from github.com/joeblau/subvox.

| Model | Real LOSO | Shuffled labels: mean (sd) | Best shuffle | Shuffles at or above real | p value |
|---|---:|---:|---:|---:|---:|
| dtw-py | 81.9% (280/342) | 12.7% (3.2) | 22.8% | 0 of 500 | 0.002 |
| minirocket | 76.3% (261/342) | 12.7% (2.3) | 19.9% | 0 of 500 | 0.002 |

![dtw-py luck test](results/dtw-py/luck_loso.png)

![minirocket luck test](results/minirocket/luck_loso.png)

Not run for cnn (each shuffle means retraining every fold; the cheap exact shortcut exists only for
dtw-py and minirocket).

#### Leave one clip out

Train on every other clip, including takes from the same sitting, so it is optimistic. Shown for completeness.

| Model | Accuracy | Macro F1 | None false accept | Infer ms/clip |
|---|---:|---:|---:|---:|
| dtw-py | 89.2% (305/342) | 0.894 | 0.0% (0/27) | ~203.2 |
| minirocket | 89.8% (307/342) | 0.901 | 0.0% (0/27) | ~6.8 |

#### JS vs Python DTW cross check

Needs both `dtw-knn` (JS, `scripts/eval-dtw.ts`) and `dtw-py` results on the same data and protocol.

#### Confusion matrices

Rows = true label, columns = predicted.

##### dtw-py

![dtw-py loso](results/dtw-py/confusion_loso.png)

![dtw-py loo](results/dtw-py/confusion_loo.png)

![dtw-py xbud](results/dtw-py/confusion_xbud.png)

##### minirocket

![minirocket loso](results/minirocket/confusion_loso.png)

![minirocket loo](results/minirocket/confusion_loo.png)

![minirocket xbud](results/minirocket/confusion_xbud.png)

##### cnn

![cnn loso](results/cnn/confusion_loso.png)

![cnn xbud](results/cnn/confusion_xbud.png)

## Synthetic fixture (not real AirPods data)

> **Synthetic fixture, not real AirPods data.** Generated fake motion from `shared/fixtures/`.
> It shows the code works end to end. It says nothing about real mouthed sentences.

| Model | Protocol | Accuracy | Macro F1 | None false accept | Infer ms/clip | Data |
|---|---|---:|---:|---:|---:|---|
| dtw-knn | LOSO | 98.3% (118/120) | 0.984 | 0.0% | 1.1 | `dataset.synthetic.json` (*synthetic*) |
| dtw-knn | LOO | 98.3% (118/120) | 0.984 | 0.0% | 1.6 | `dataset.synthetic.json` (*synthetic*) |
| dtw-py | LOSO | 98.3% (118/120) | 0.984 | 0.0% | ~18.9 | `dataset.synthetic.json` (*synthetic*) |
| dtw-py | LOO | 98.3% (118/120) | 0.984 | 0.0% | ~45.3 | `dataset.synthetic.json` (*synthetic*) |
| minirocket | LOSO | 99.2% (119/120) | 0.992 | 0.0% | ~3.8 | `dataset.synthetic.json` (*synthetic*) |
| minirocket | LOO | 98.3% (118/120) | 0.983 | 0.0% | ~7.0 | `dataset.synthetic.json` (*synthetic*) |
| cnn | LOSO | 97.5% (117/120) | 0.975 | 0.0% | 2.1 | `dataset.synthetic.json` (*synthetic*) |
| cnn | LOO | 98.3% (118/120) | 0.984 | 0.0% | 1.0 | `dataset.synthetic.json` (*synthetic*) |

- Highest LOSO on `dataset.synthetic.json`: **minirocket**, 119/120 correct (99.2%).
- Highest LOO on `dataset.synthetic.json`: **dtw-knn** and **dtw-py** and **minirocket** and **cnn** (tie), 118/120 correct (98.3%).

### JS vs Python DTW cross check (synthetic)

Same data and the same settings (L, band, k, norm, channels, hpHz, threshold, and budNorm when there are right bud
clips) are checked first.

| Protocol | Data | Accuracy JS | Accuracy Python | Gap (points) | None FA JS | None FA Python | Within 5? |
|---|---|---:|---:|---:|---:|---:|---|
| LOSO | `dataset.synthetic.json` | 98.3% (118/120) | 98.3% (118/120) | 0.0 | 0.0% | 0.0% | yes, same confusion matrix |
| LOO | `dataset.synthetic.json` | 98.3% (118/120) | 98.3% (118/120) | 0.0 | 0.0% | 0.0% | yes, same confusion matrix |

### Confusion matrices (synthetic)

Rows = true label, columns = predicted.

#### dtw-knn

**LOSO**

| true \ pred | calendar | call_back | demo_48h | focus_music | help | none | text_mom | volume_up |
|---|---|---|---|---|---|---|---|---|
| **calendar** | 15 | . | . | . | . | . | . | . |
| **call_back** | . | 15 | . | . | . | . | . | . |
| **demo_48h** | . | . | 15 | . | . | . | . | . |
| **focus_music** | . | . | . | 15 | . | . | . | . |
| **help** | . | . | . | . | 14 | 1 | . | . |
| **none** | . | . | . | . | . | 15 | . | . |
| **text_mom** | . | . | . | . | . | . | 15 | . |
| **volume_up** | . | . | . | . | . | 1 | . | 14 |

**LOO**

| true \ pred | calendar | call_back | demo_48h | focus_music | help | none | text_mom | volume_up |
|---|---|---|---|---|---|---|---|---|
| **calendar** | 15 | . | . | . | . | . | . | . |
| **call_back** | . | 15 | . | . | . | . | . | . |
| **demo_48h** | . | . | 15 | . | . | . | . | . |
| **focus_music** | . | . | . | 15 | . | . | . | . |
| **help** | . | . | . | . | 14 | 1 | . | . |
| **none** | . | . | . | . | . | 15 | . | . |
| **text_mom** | . | . | . | . | . | . | 15 | . |
| **volume_up** | . | . | . | . | . | 1 | . | 14 |

#### dtw-py

![dtw-py loso](results/synthetic/dtw-py/confusion_loso.png)

![dtw-py loo](results/synthetic/dtw-py/confusion_loo.png)

#### minirocket

![minirocket loso](results/synthetic/minirocket/confusion_loso.png)

![minirocket loo](results/synthetic/minirocket/confusion_loo.png)

#### cnn

![cnn loso](results/synthetic/cnn/confusion_loso.png)

![cnn loo](results/synthetic/cnn/confusion_loo.png)
