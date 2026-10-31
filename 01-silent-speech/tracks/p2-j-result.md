# Track J: Recognize screen (result panel)

## Goal
The money shot: you mouth a sentence, it appears big, and (only when safe) the Mac does it.

## Owns
`web/src/panels/result.ts` (+ `web/src/panels/result/` for helpers, CSS, worker), `tests/e2e/result.spec.ts`, `tests/unit/result.test.ts`. Ports 4303 / 18903.

## Build
1. **Model source** in Recognize mode (`app.mode === 'classify'`): if the store has **real** (airpods) clips for ≥ 2 classes → `ml.train` on them (show "Your model: N recordings"); else fetch `${import.meta.env.BASE_URL}models/templates.json` → `ml.loadModel` (show "Spiro's model (public)"). Fake practice clips never train the live model. `app.setModel(...)`. Re-train button.
2. **Result card** (order 5, first in Recognize mode; CSS already puts `[data-panel=result]` first): big animated sentence, confidence ring, top 3 bars, a calm "Not sure, try again" state when not accepted, last 5 history chips. `data-testid`s: `result-label`, `result-confidence`, `result-top`, `result-state`, `result-model`.
3. **Actions, strict rule:** call `app.sendAction` **only if** source is `live`, `lastStatus.armed === true`, `lastStatus.simulated === false`, the model is the user's own (trained from their real clips), `pred.accepted`, the class has an action, and no action was sent in the last 3 s. Never retry on `timeout` / `disconnected` / `stopped`. Otherwise show a ghost chip "Would: <what it does>" (visitors and replay see this). Show `actionResult` as a toast (dry run, ok, error incl. `unpaired`: "This dashboard isn't paired with your Mac app. Open it from the Mac app's link.").
4. **Moments:** `demo_48h` → confetti (canvas, no library); `help` → full screen red alert with a big Dismiss; optional "Say it out loud" toggle (default off) using `speechSynthesis` to speak the recognized sentence.
5. Works with any source (fake, live, replay): fake mode lets visitors try Recognize with `app.fakeLabel`.

## Gate
`npm run typecheck && npm test && E2E_WEB_PORT=4303 E2E_MOCK_PORT=18903 npx playwright test` green. e2e: fake inject → right label shown; `none` never sends; with a mock bridge started with `--armed --token <t>` and the page paired via `#pair=<t>` and a live source reporting `simulated:false` (your own scratch mock or a test only mock option), exactly one action is sent per accepted prediction and its toast shows; unpaired → the unpaired toast; not armed → ghost chip only. Screenshots checked.
