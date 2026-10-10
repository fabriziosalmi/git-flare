# G1, reference cell — 2026-10-10 (local, NOT pushed; Fab decides what to publish)

Result file: `g1.json`. Decision by the preregistered rule: **median 59% of 8 repositories, all 8 >= 20% -> "proceed" (phases 4-6)**.

Inputs, all fixed before the run: times file `benchmarks/results/2026-10-06/phase2/phase2-times.json` of branch
`results/phase2-times-2026-10-06` (sha256 609f62cf...1f82179), footprints `benchmarks/results/2026-10-05/footprints`,
scale 0.25, 3 reps, parallel 3, 10 agents, tests 30 s, kind human. Code: `scripts/queue-sim-g1.mjs` and `scripts/queue-sim.mjs` with the fix of the pull request "queue-sim: a patch the server
closes at submit...". Local server in mock mode; no Workers AI neurons were used.

## Deviations from the overnight plan (the overnight run left no G1 output; its work dir was gone)
1. Attempt 1 (2026-10-10 07:03Z): hono cell died with HTTP 500 / "Network connection lost" while the Mac load average was 45 (other
   programs). Whole attempt discarded, including the finished click cells; rerun from scratch on a fresh server.
2. Attempt 2: axios cell died: attest on a patch the server's gate had closed at submit (protected path .github/workflows/publish.yml).
   Cause: simulator, not environment. Fix: such a task ends without review or retry and is counted in tasksClosedAtSubmit; the rate is
   unchanged (stale / (merged + stale)). Axios: 1 of 12 footprints affected, eslint 2 of 7, others 0. Whole attempt discarded.
3. Attempt 3: prettier cell died with "Network connection lost" (HTTP 500 on claim) at low load. Rule written before the resume:
   a transport failure voids the interrupted cell, which is rerun with the same seed; anything else stops the loop. The resume
   (`supervisor.log`) finished without further failures; finished cells (click, hono, axios) were reused from disk.
4. The decision to rerun never depended on a rate. Server health over the final run: 24,215 requests, 0 errors, p50 11 ms, p99 60 ms, max 218 ms.

## Threats to validity (in the preregistered design, not changed)
- Footprints are drawn with replacement: 60 tasks from 7-12 distinct footprints, so identical footprints recur 5-8 times.
- 10 attempts at most: click gave up 14-17 of 60 tasks per cell.
- Eslint: its 2 protected-path footprints (of 7) never enter the queue, so its rate is on the other 5.

Note: the commit ids in `supervisor.log` are those of local snapshots of the code, not of this repository.
