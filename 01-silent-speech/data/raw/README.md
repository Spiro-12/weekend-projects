# Spiro's real recordings

AirPods Pro 3 on a Mac (SilentSpeechBridge), recorded with the dashboard's Record panel on Oct 31, 2026. Head and jaw motion only (`ss-dataset` v1, PROTOCOL §3): no audio, no personal info. Published with Spiro's OK.

| File | Session | Sensor bud | Clips |
|---|---|---|---|
| `ss-dataset-s1-20261031-1621.json` | s1 | **right** | 8 classes × 15 |
| `ss-dataset-s2-20261031-1637.json` | s2 | left | 8 classes × 15 |
| `ss-dataset-s3-20261031-1654.json` | s3 | left | 8 classes × 15 |

- 50 Hz, under 1% gaps. Head resting against a chair. Silent mouthing, jaw a bit exaggerated.
- **`exclude.json`**: 18 `none` takes where Spiro mouthed "stay still" (old prompt wording). Every script skips them (`--exclude`); the raw files are never edited.
- Later `none` takes are nods or swallows (the old prompt said "maybe swallow or nod"). From Phase 2 the prompt says "Keep your mouth closed and still. Don't say anything."
- s1 used the right bud and s2/s3 the left, which is why bud normalization exists (PROTOCOL §5 step 0).

First results (DTW kNN, k = 1, before Phase 2 tuning): LOSO on s2 + s3 89.9% (8 classes, chance 12.5%); s1 on an s2 + s3 model 34% raw, 63% mirrored.
