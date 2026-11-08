# Fleet Planner: results and assumptions

The honest numbers, every modeling assumption, and every budget change. Phase 2 adds the one-brain vs many-brains
results and the sweep knee.

## Budget changes
| Budget | Was | Now | Why |
|---|---|---|---|
| Initial JS + CSS (gz) | 250 KB (tightened from the plan's 300 KB after Phase 0) | 280 KB | Phase 1 puts the real sim core and the one-brain planner on the main thread: the live view runs them every frame, so they can't load later (about +20 KB). The money model and FakeSim are kept out of the first-view bundle (money loads lazily). Still under the plan's 300 KB. |
