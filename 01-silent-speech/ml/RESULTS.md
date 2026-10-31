# Silent Speech: model benchmark

> **Synthetic fixture, not real AirPods data.** Rows marked *synthetic* use generated fake motion from `shared/fixtures/`.
> They show the code works end to end. They say nothing yet about real mouthed sentences.

Made by `uv run python -m silent.report` from `ml/results/*/*.json`. Don't edit by hand.

- **LOO** = leave one clip out. **LOSO** = leave one session out (train on the other sessions, test on a
  new one: closest to real use, so the number that matters).
- **None false accept** = share of true `none` clips the model accepted as an action (label is not `none` and
  confidence >= the 0.5 threshold). Each model family has its own confidence scale (DTW: vote x separation,
  MiniRocket: mapped ridge scores, CNN: softmax), so at a fixed 0.5 this column is **not comparable across
  model families**. Phase 2 tunes a threshold per model.
- **Infer ms** = per clip, preprocessing + predict, one clip at a time. `~` = rough (folds ran in parallel
  processes). JS (`dtw-knn`) is timed by its own runner.

| Model | Protocol | Accuracy | Macro F1 | None false accept | Infer ms/clip | Data |
|---|---|---:|---:|---:|---:|---|
| dtw-py | LOO | 98.3% (118/120) | 0.984 | 0.0% | 13.6 | `dataset.synthetic.json` (*synthetic*) |
| dtw-py | LOSO | 98.3% (118/120) | 0.984 | 0.0% | 7.1 | `dataset.synthetic.json` (*synthetic*) |
| minirocket | LOO | 98.3% (118/120) | 0.983 | 0.0% | 2.9 | `dataset.synthetic.json` (*synthetic*) |
| minirocket | LOSO | 99.2% (119/120) | 0.992 | 0.0% | 2.4 | `dataset.synthetic.json` (*synthetic*) |
| cnn | LOO | 98.3% (118/120) | 0.984 | 0.0% | 1.0 | `dataset.synthetic.json` (*synthetic*) |
| cnn | LOSO | 97.5% (117/120) | 0.975 | 0.0% | 0.6 | `dataset.synthetic.json` (*synthetic*) |

- Highest LOO on `dataset.synthetic.json`: **dtw-py** and **minirocket** and **cnn** (tie), 118/120 correct (98.3%).
- Highest LOSO on `dataset.synthetic.json`: **minirocket**, 119/120 correct (99.2%).

## JS vs Python DTW cross check

Needs both `results/dtw-knn/` (JS, `scripts/eval-dtw.ts`) and `results/dtw-py/` for the same protocol.

## Confusion matrices

Rows = true label, columns = predicted.

### dtw-py

![dtw-py loo](results/dtw-py/confusion_loo.png)

![dtw-py loso](results/dtw-py/confusion_loso.png)

### minirocket

![minirocket loo](results/minirocket/confusion_loo.png)

![minirocket loso](results/minirocket/confusion_loso.png)

### cnn

![cnn loo](results/cnn/confusion_loo.png)

![cnn loso](results/cnn/confusion_loso.png)
