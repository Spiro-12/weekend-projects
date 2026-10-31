# Silent Speech on AirPods: Research

Done Oct 31, 2026 with 4 parallel research agents (sensors, papers, competitors, build stack).
Note: most paper sites were blocked from the research sandbox, so some numbers come from search summaries.

## TL;DR
- **Possible, with limits.** One paper (SwanTrumpet, IMWUT 2025) got 91% word accuracy from the built in IMU of normal earbuds at 25 Hz. So the signal is there.
- **Free sentences: no.** Fixed phrases: yes. We treat each whole phrase as one "word". Longer phrases have more distinct rhythm, so they may be *easier* than single words.
- **Nobody has open sourced silent speech on AirPods.** We'd be first.

## What AirPods give us
| Signal | Access? | Notes |
|---|---|---|
| Head motion IMU (`CMHeadphoneMotionManager`) | Yes, native app only (iOS 14+, macOS 14+) | ~25 Hz, one bud at a time, fused data: attitude, rotationRate, userAcceleration. Rate is not settable. Dropouts in ANC mode. |
| Voice accelerometer (bone conduction) | No | Firmware only, no API, private or public. |
| Inner (in ear) mic | No | You only get the processed beamformed mic. |
| Ultrasound echo sensing | No | Bluetooth mic is 16 to 24 kHz and AAC cuts high frequencies. |
| Browser access | No | No web API for headphone motion. |
| Private Bluetooth protocol (LibrePods, AAP) | Maybe | Linux/Android hackers read orientation directly. A claimed ~100 Hz is unverified. Side quest. |

Physics check: jaw opening moves at ~4 to 8 Hz (syllable rate). 25 Hz sampling can capture up to 12.5 Hz. So syllable rhythm and mouth opening show up; lips and tongue mostly don't.

## Prior work (most relevant)
| System | Sensor | Result |
|---|---|---|
| SwanTrumpet (IMWUT 2025) | built in IMU of 2 commercial earbuds, ~25 Hz | 91.2% words, 7.1% sentence WER, user independent. Code/data: https://zenodo.org/records/15253376 |
| MuteIt (UbiComp 2022) | IMU on jaw joint + reference IMU | 94.8% on 100 commands |
| Unvoiced (SenSys 2024) | jaw IMU → spectrogram → speech model + LLM | <9% WER on open phrases |
| QuietSync (MSR 2024) | headphone IMU + electrodes | 94.2% on 12 commands, adapts with 5 samples |
| EchoSpeech (Cornell CHI 2023) | sonar on glasses | ~95% on 31 commands |
| LipLearner (CHI 2023) | phone camera | F1 0.89 from 1 example per command |
| Talking / chewing detection (eSense, AirPods) | earbud IMU | ~91 to 94% |

## Competitors
- **Subvocal (YC F26):** radar glasses, raised ~$1.3M, $499, ships Q1 2027, claims 200+ wpm.
- **Apple bought Q.ai (Jan 2026, ~$1.6 to 2B):** silent speech from facial micro movements. Apple patents also describe lip reading from AirPods motion sensors.
- **AlterEgo (MIT spinout):** EMG, relaunched 2025.
- **Open source AirPods projects:** only head nods, chewing counters, data loggers. No silent speech.

Our hook: **"$0 silent speech on the AirPods you already own"** vs $499 glasses and a $2B acquisition.

## Expected accuracy (one user, still head, push to talk)
- 5 to 8 distinct phrases: ~75 to 90%
- Digits 0 to 9: ~50 to 70%
- Open sentences: not realistic this weekend

## How to give it the best shot
- Pick phrases that differ in **syllable count and mouth opening**, not in lips/tongue ("bat" vs "pat" is hopeless).
- Use rotationRate + userAcceleration, high pass above ~1 Hz to kill head drift.
- Push to talk for segmentation. Add a "none" class.
- Head motion is the main noise. Keep head still for v1.
- Model: start with DTW + kNN (no training, works with 10 samples, ~50 lines JS). Try MiniRocket and a small few shot CNN offline and publish all scores.
- ~10 to 20 repeats per phrase (2 to 5 min of enrollment).
