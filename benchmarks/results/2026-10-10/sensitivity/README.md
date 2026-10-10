# G1 sensitivities — 2026-10-10 (local, NOT pushed)

Result file: `sensitivity.json`; per-cell data under `<condition>/<repo>/`. Each condition is the G1 reference cell (10 agents, tests 30 s,
scale 0.25, 3 reps, times file of phase 2, kind human) with ONE change. Code: commit dfb86f9 (branch `sensitivity/2026-10-10`) on the G1 snapshot;
conditions and the criterion are in the header of `scripts/queue-sim-sensitivity.mjs`, committed before any run.

| Condition | Median | Repositories (rejection per submission; G1 reference in brackets) |
|---|---|---|
| human-nohot | 58.5% (8 repos) | click 78.8 (87.7), hono 49.7 (51.1), axios 70.3 (69.9), prettier 59.3 (59.0), eslint 58.5 (68.5), vite 58.4 (58.5), svelte 48.6 (48.4), cli 58.3 (59.0) |
| agent | 59.8% (2) | click 77.7 (87.7), hono 41.9 (51.1) |
| work x0.5 / x2 / x6 | 67.8 / 68.6 / 66.0% (2) | click 87.7 / 87.6 / 85.7, svelte 47.8 / 49.6 / 46.3 |
| wave-replace (10 tasks, with replacement) | 35.8% (5) | click 80.6, hono 24.6, axios 51.8, vite 35.8, svelte 29.9 |
| wave-noreplace (10 tasks, no repeated footprint) | 26.5% (5) | click 79.5, hono 18.1, axios 44.3, vite 26.5, svelte 14.2 |

Reading, stated with its limits: no condition takes the median below 20%, so the G1 decision ("proceed") holds mechanically in every one.
But the size of the 59% depends on the sampler: with no repeated footprint (wave-noreplace) the median falls to 26.5% and two of five repositories
are under 20%. The work time (x0.5 to x6) and the hot-file filter change almost nothing in this scenario. The wave conditions cover five
repositories (the others have fewer than 10 footprints) and ONE wave of 10 tasks, not the six waves of G1: they are not the G1 number without
repetition, they show how much of it comes from repetition. A like-for-like check needs 60 distinct footprints per repository (more pull requests).

## Failures during the run (all voided cells were rerun with the same seed; `supervisor.log`)
- Run 1 started by mistake with a dry-run argument the supervisor ignores, killed by hand.
- Run 1 stopped: HTTP 500 INTERNAL on two claims, server log "Cannot perform I/O on behalf of a different request" (validation.ts:61, before queue logic).
  The retry rule was extended, with no rate in sight, to: HTTP 500 plus that signature or "Network connection lost" voids the cell; anything else stops.
- Runs 2 and 3: one "HTTP 500 {}" each ("Network connection lost"), cells rerun. Run 4 finished. Whole sensitivity: 119,638 requests, p50 11 ms, p99 55 ms.
- tasksGivenUp (10 attempts at most) is high on click in the reference scenario (22-55 of 180 tasks per condition); axios and eslint tasks on protected paths close at submit (tasksClosedAtSubmit).
