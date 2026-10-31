# Early real test (Oct 31, 2026), before any of our own code

Spiro, AirPods Pro 3 + iPhone 17 (iOS 27), free Sensor Logger app, head resting against a chair.

## Test 1 (no markers)
- **AirPods Pro 3 stream headphone motion at 50 Hz** (20 ms steady, no repeated rows), not the ~25 Hz papers measured on AirPods Pro 2. Preprocessing grid moved to 50 Hz (PROTOCOL §5).
- Rhythmic bursts every ~3.7 s in the 2 to 8 Hz band, matching mouthing + pauses, but only 2 to 5x background and as big as small head tilts. Inconclusive without markers.

## Test 2 (markers before each attempt)
18 markers. Inferred layout: 1 extra tap, 5 × still, 6 × "Text mom I'm on my way", 6 × "Turn the volume up" (block break visible as a longer gap after marker 6). Marker clock differs from the motion clock in Sensor Logger, so alignment was found by maximizing post vs pre marker activity (offset 3.13 s).

| | still (2 to 6) | mouthing (7 to 18) |
|---|---|---|
| jaw band energy after marker (× quiet) | 0.9 to 1.3 | **8 to 14.5** |

Simple DTW 1-NN, leave one out (high pass 1 Hz, 6 channels, 2.9 s window, L = 64):
- 3 classes (still / text mom / volume up): **17 / 17 correct** (chance 33%)
- text mom vs volume up: **12 / 12** (chance 50%)
- Control, wrong but time contiguous labels: 67%. Control, alternating labels: 0%. Mean DTW distance within text 588, within volume 426, between 652.

## Read
- **Mouthing is clearly visible** in AirPods Pro 3 motion (≈10× the still baseline). GO on "can it see the jaw".
- **The two sentences look separable**, but each sentence was recorded as one block, so some of the score could be "clips close in time look alike". The Phase 1 pilot uses shuffled prompts, which removes that confound.

Scripts: `scripts/` (run with `uv run --with numpy --with scipy --with matplotlib python <script> <recording folder> <output png>`; `analyze.py` also writes `/tmp/sl_data/segs.npy`, so create `/tmp/sl_data` first). Raw recordings are not committed (they include device ids).
