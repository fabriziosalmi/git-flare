# Evidence

Every measurement below comes from a script in this repository; raw outputs are in
[`benchmarks/results/`](../benchmarks/results/). "Staging" is the author's deployment on Cloudflare (Workers
Paid, Artifacts beta, Containers, Queues, Workers AI); the Durable Object figures come from a separate bench
Worker that calls the objects directly, with Artifacts mocked.

The rows are grouped by what they show. A figure without a results file is listed under "Checked by hand".
The study of the merge queue's conflict rule has its own note: [`spikes/hunk-merge-2026-10-04.md`](spikes/hunk-merge-2026-10-04.md).

## Correctness, end to end

| What | Result | Where measured |
|---|---|---|
| End-to-end on real Artifacts (join, claim, `git push` to fork, submit, 2 reviews, merge, `git ls-remote` on main) | 8 runs, all checks passed (26–34 per run); in runs 1–6 some of the concurrent joins failed on zombie forks (6/9 … 14/17), fixed by the alternate-name fallback (runs 7–8: 17/17) ([`e2e-native-runs.json`](../benchmarks/results/2026-10-02/e2e-native-runs.json)) | staging |
| The same end-to-end after the review fixes: a lone patch lands as the queue's own commit of the reviewed tree, never the agent's commit | 66/66 checks ([`e2e-native-composed-merge.json`](../benchmarks/results/2026-10-03/e2e-native-composed-merge.json)) | staging |
| Composed commit validity | objects hash-identical to `git`'s, pack accepted by `git index-pack` (`scripts/verify-git-objects.mjs`, 6/6) | local git |
| Concurrent claims on one task | exactly 1 grant (8–16 racers on staging, 30 locally, 400 in the bench) | staging, local, bench |
| Cleanup of closed patches' branches (`gf admin repo cleanup`; the shard alarm also does it a minute after a patch closes) | 9 and 11 branches deleted on two staging repositories, 0 failures; `git ls-remote` on an agent fork showed `task/CL1/1` before and nothing after ([`cleanup-staging.json`](../benchmarks/results/2026-10-02/cleanup-staging.json)) | staging |

## Merge queue and tests in the container

| What | Result | Where measured |
|---|---|---|
| Merge queue on real Artifacts: 26 patches built on the same old `main` (24 disjoint + 1 conflicting pair) | 25 merged in **one** composed commit, 1 conflict detected, 2.0 s for the batch; 133/133 checks ([`e2e-merge-queue.json`](../benchmarks/results/2026-10-02/e2e-merge-queue.json)) | staging |
| Project tests on the composed tree (Cloudflare Containers, internet disabled) | 4 patches approved together, one breaking `add()` in a file nobody else touches: rejected by the real `node --test` after bisection, the other 3 merged; first run 7.1 s (container cold start included), warm runs 0.3–0.5 s; bisection that keeps the known-failing set: 5 test runs instead of 7 on the same scenario ([`e2e-bisection.json`](../benchmarks/results/2026-10-02/e2e-bisection.json)) | staging |
| Tests that need an npm dependency: `npm ci` in the container through a read-only registry proxy | install 0.6–1.9 s, a patch using the dependency merged, a breaking one rejected by the tests; a probe test run as the code under test confirmed in the real container: no internet, proxy refuses writes, `node_modules` and npm's cache out of reach, not root. With tests run as root the probe tampered with `node_modules`, broke another test and was rejected ([`deps-tests.json`](../benchmarks/results/2026-10-02/deps-tests.json)) | staging |
| Nothing of a test run survives into the next | a test that leaves a detached process and files in every directory the test user can write: one run later the process is gone and so are the files, 7/7 checks; a deliberately broken build (no kill, only `/tmp` wiped), deployed for one run, failed the check ("a process from an earlier run is still writing") ([`container-linger.json`](../benchmarks/results/2026-10-03/container-linger.json)) | staging |

## Reviews, agents and duplicates

| What | Result | Where measured |
|---|---|---|
| LLM agents end to end (`scripts/demo.mjs`): Qwen2.5-Coder writes 5 small features with tests, reviewers of three model families on Workers AI review the platform's diffs, 2 rogue patches, 10 scripted swarm workers with 2 scripted reviewers | three runs, each 15/17 tasks merged: 5/5 LLM patches merged after the project's tests passed in the container, both rogue patches rejected by the reviewers (one had also edited the test to hide the bug); 21 LLM reviews per run, 0 errors in two runs and 1 abstention in one; 7, 4 and 4 pushes ([`demo-demo-952872.json`](../benchmarks/results/2026-10-02/demo-demo-952872.json), [`demo-gfdemo-195.json`](../benchmarks/results/2026-10-02/demo-gfdemo-195.json), [`demo-gfdemo-980.json`](../benchmarks/results/2026-10-02/demo-gfdemo-980.json), the last one recorded for the video: [`video-gfdemo-980/`](../benchmarks/results/2026-10-02/video-gfdemo-980/)) | staging |
| Near-duplicate threshold, calibrated on 10,947 pairs from express, click and cobra (real commits vs the same change resubmitted with small edits; different commits, 1,343 touching the same file) | 14 bits: no false positive, recall 0.87 (the previous 8 bits: 0.73; 0.45 on changes of 3–10 lines). A one-literal edit lands within 14 bits 95 % of the time, so near-duplicates go to review flagged; 13 of 15 pairs of independent LLM solutions of the same task were within 14 bits ([`simhash-calibration.json`](../benchmarks/results/2026-10-02/simhash-calibration.json), [dataset](../benchmarks/datasets/simhash-pairs.jsonl)) | public repositories + Workers AI |

## Scale and latency

| What | Result | Where measured |
|---|---|---|
| Claim throughput on real Artifacts (16 shards, 200 claims in flight from one client) | on a 2,000-claim run of each design: **121 → 687 claims/s**, provisioning p95 2.9 s → 0.57 s, after claims stopped calling Artifacts (the earlier design minted 2 tokens and read the head per claim); on a 4,000-claim run: **1,091 claims/s**, p95 145 ms, 16 read tokens minted in total. One client: the server's ceiling was not reached ([`claims-load.json`](../benchmarks/results/2026-10-02/claims-load.json)) | staging |
| Artifacts under load (control plane and git, from inside the Worker) | ~230 token mints/s on one repository, ~425/s over four; ~320–370 reads or git requests/s per repository; 80 concurrent forks in 5 s. No 429 among the statuses recorded (5 failed git requests have no recorded status); past a few hundred operations/s the control plane queues and latency grows ([`artifacts-load.json`](../benchmarks/results/2026-10-02/artifacts-load.json)) | staging |
| Server-side diff + gates for a 1-file change | median 376 ms (138–558), 8 runs on earlier builds of this code, before the merge queue and the ordered diff | staging, measured inside the Worker |
| Pack relay with compare-and-swap (moves the read replicas; earlier builds also used it to fast-forward main) | median 778 ms (483–1,311), the same 8 runs | staging, measured inside the Worker |
| Fork creation (once per agent) | 2–9 s seen by the client (up to 19 s in concurrent bursts before the alternate-name fallback); 15–33 % of concurrent forks failed on the service side, on a seconds-old and on a minutes-old repository, and are retried under an alternate name | staging |
| One task shard (agent already known to the shard) | ~1,030 claims/s; an agent's first claim on a shard looks its fork up in the registry: 330–590/s ([`do-throughput-v2.json`](../benchmarks/results/2026-10-02/do-throughput-v2.json)) | bench Worker, Artifacts mocked |
| 32 shards in parallel | 12,900 and 19,200 claims/s aggregate in two of three runs; the third reached 2,875/s, held back by one slow shard | bench Worker, Artifacts mocked |
| Registry: recording reviews as the approval graph grows | about 880–1,400 reviews/s from 0 to 100,000 edges; the earlier build fell from 775/s to 65/s at 20,000 edges ([`do-throughput-v2.json`](../benchmarks/results/2026-10-02/do-throughput-v2.json)) | bench Worker |
| Read replicas of main: 2,000 clones with 480 in flight | main alone 26 % failed (HTTP 5xx), 43 clones/s; with 4 replicas 5 % failed, 123 clones/s (2.9×); p50 per replica 2.7–3.5 s. An upper bound with 4 independent repositories: 33 % → 0.05 % failed, 64 → 152 clones/s. E2E with 4 replicas 68/68, all 4 moved to a new head in 0.7 s ([`replicas.json`](../benchmarks/results/2026-10-02/replicas.json)); a tampered replica is reset by the next sync (workerd test) | staging |

## Integrity: the main guard

| What | Result | Where measured |
|---|---|---|
| Main guard (Artifacts has no branch protection): a commit pushed to main with a write token issued outside the platform | alert 5 s after the tamper started (the foreign `token.created` event arrived before the push), merge queue stopped; `restore` put main back to the queue's last head and revoked 3 write tokens; 18 events of a full E2E run (2 own pushes, 10 clones) raised no alert; event lag at most 8.0 s ([`guard-staging.json`](../benchmarks/results/2026-10-02/guard-staging.json)). A rollback to an earlier queue head is caught on the push event, without waiting for a merge round (workerd test) | staging |

## Test suite

| What | Result | Where measured |
|---|---|---|
| Tests | 110 tests inside workerd when this was measured (115 today); 20 fixes of the pre-publication review re-introduced on purpose, one at a time: each made a test fail; 1 more live on staging; the fixes without a dedicated test are listed ([`mutations.txt`](../benchmarks/results/2026-10-03/mutations.txt)); CI on GitHub runs the tests, clippy, the reproducible WASM build and the deploy dry-runs | `npm test`, GitHub Actions |

## Checked by hand

Checked by hand on staging, no raw output kept: a fork token cannot push to `main` (403); a revoked agent
key was refused about 16 s after `gf admin agent revoke` (bound: 30 s while the revocation list is
reachable); one agent firing 800 requests got 636 served, then 429 with `Retry-After` (600/min per
location, approximate by design); `gf admin repo delete` removed 18 agent forks and main in 32 s;
`git fsck --strict` clean on a real `main` built by the queue.

## Facts about Artifacts

Facts about Artifacts established on the live service (tokens, TTL, revocation, ref CAS, absence of
branch protection, a protocol quirk) are in [`docs/spikes/artifacts-2026-10-02.md`](spikes/artifacts-2026-10-02.md).

