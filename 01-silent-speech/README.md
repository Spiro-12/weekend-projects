# Silent Speech

> $0 silent speech on the AirPods you already own.

**Live demo:** https://spiro-12.github.io/weekend-projects/01-silent-speech/

_Work in progress. Full write up, demo GIF and real accuracy numbers land in Phase 3._

- [RESEARCH.md](RESEARCH.md): what AirPods can and can't sense, prior work, competitors
- [PLAN.md](PLAN.md): the phased build plan
- [PROTOCOL.md](PROTOCOL.md): the contracts between the Mac app, the dashboard and the ML

## Dev
```
npm ci
npm run dev            # dashboard on localhost:5173 (add ?mode=fake for fake data)
npm run bridge -- --allow-origin http://localhost:5173   # mock Mac app on ws://127.0.0.1:18765
                       # then open localhost:5173/weekend-projects/01-silent-speech/?mode=live&ws=ws://127.0.0.1:18765
npm run typecheck && npm test && npx playwright test
```
