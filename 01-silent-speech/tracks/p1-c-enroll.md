# Track C: Enroll (record training data)

## Goal
A guided recording screen that makes collecting ~15 reps × 8 classes painless, shows live accuracy, and exports the `ss-dataset` v1 file (`PROTOCOL.md` §3).

## Owns
`web/src/panels/enroll.ts`, `web/src/store.ts` (extend it, keep the `ClipStore` interface + `createStore()`), `tests/e2e/enroll.spec.ts`, `tests/unit/store.test.ts`.
Your ports: `E2E_WEB_PORT=4202 E2E_MOCK_PORT=18802` (see `tracks/README.md`).
Uses: `ml.train`, `ml.evaluate` from `web/src/ml/index.ts` (Track D implements in parallel; until then they throw "not implemented". Handle that: show "model not ready").

## Build
- **store.ts**: autosave to **IndexedDB** (one record per clip, or per session; localStorage is shared by every site on spiro-12.github.io and only ~5 MB), restore on load, `toDataset(meta)` and `load(ds)` (import). **`load` dedupes by clip `id`** (importing the same file twice adds nothing).
- **panels/enroll.ts** (order 40, wide): only active when `app.mode === 'enroll'`.
  - Session name (default `s1`, s2, …), reps per class (default 15), class list from `app.classes`.
  - Prompt: shows the current sentence BIG. Order = shuffled blocks (each block has every class once). For `none`: "stay still, maybe swallow or nod".
  - **In fake mode, set `app.fakeLabel` to the current prompt's id** so fake data matches labels.
  - On bus `clip`: label it with the current prompt → `DatasetClip` (globally unique `id` via `newId(session)`, rep, startedAt, pressT, releaseT, padSec, quality from clip.gapPct + nSamples, session) → store → next prompt. Auto reject (with a visible message) if gapPct > 20, fewer than 10 samples, **any interval between samples > 0.5 s** (a stall), or the clip is longer than 10 s.
  - Buttons: Redo last, Skip, Clear session (confirm), Export JSON (**current session only**, download `ss-dataset-<session>-<yyyymmdd-hhmm>.json`; `source` = `airpods` if `app.source.kind === 'live' && app.lastStatus?.simulated === false` else `fake`; device `AirPods Pro 3`, `loc` from `app.lastStatus`), Import JSON (validate with `validateDataset`).
  - Progress: per class count / target, total.
  - **Live accuracy**: after each clip (debounced), if ≥ 2 clips per class for ≥ 2 classes, run `ml.evaluate(clips, {}, 'loo')` and show accuracy + mini confusion matrix (labels short). Show LOSO too if ≥ 2 sessions.
  - **Train & use** button: `app.setModel(ml.train(clips))` then `app.setMode('classify')`.
- `data-testid`s: `enroll-prompt`, `enroll-progress`, `enroll-export`, `enroll-import`, `enroll-accuracy`, `enroll-train`.

## Gate
- `npm run typecheck && npm test && npx playwright test` green.
- `tests/unit/store.test.ts`: add/remove/persist/round trip `toDataset` → `validateDataset` = [].
- `tests/e2e/enroll.spec.ts` in `?mode=fake`: record 3 classes × 3 reps (hold Space ~1.2 s each) → 9 clips stored, labels match prompts, export file downloads and passes `validateDataset`, reload restores clips. If Track D is merged: accuracy shows ≥ 0.9 on fake data.
