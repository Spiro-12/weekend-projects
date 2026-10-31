# Phase 2 tracks

Same rules as Phase 1 (`tracks/README.md`): read `PROTOCOL.md` + `web/src/core/contracts.ts` first, touch only your files, branch `p2-<letter>-<name>` off `p2`, push, CI green, no PR/merge, independent reviewer after you. Never use port 8765.

What's new in the contracts (lead, Phase 2a): per clip `loc`, `budNorm` (mirror right bud into the left frame, PROTOCOL §5 step 0), `predict(samples, ctx?: { loc })`, exclusion list `data/raw/exclude.json`, pairing `token` on every action (`error unpaired`), mock bridge `--token`. Real data: `data/raw/*.json` (see `data/raw/README.md`).

| Track | Brief | Owns | Ports |
|---|---|---|---|
| F | `p2-f-dtw-real.md` | `web/src/ml/**`, `scripts/{eval-dtw,export-model,golden-ml}.*`, `tests/unit/ml/**`, `web/public/models/`, `ml/results/dtw-knn/` | 4301 / 18901 |
| G | `p2-g-shootout.md` | `ml/**` except `ml/results/dtw-knn/` | – |
| I | `p2-i-mac-actions.md` | `mac/**` (Protocol.swift: lead) | – |
| J | `p2-j-result.md` | `web/src/panels/result.ts` (+ `web/src/panels/result/`), `tests/e2e/result.spec.ts`, `tests/unit/result.test.ts` | 4303 / 18903 |
| K | `p2-k-replay.md` | `web/src/sources/replay.ts`, `web/src/panels/{replay,session-recorder}.ts` (+ subfolders), `scripts/build-replay.ts`, `web/public/replay/`, `tests/e2e/replay.spec.ts`, `tests/unit/replay*.test.ts` | 4304 / 18904 |

Hand offs: F's public model is trained on **s1 + s2 only** (clean); **s3 is held out** and K builds the public replay from s3, so the visitor replay shows honest accuracy. J loads models; K only replays. F and G must agree clip for clip on real data (G's cross check).
