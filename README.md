# git-flare


https://github.com/user-attachments/assets/25127db1-3c67-4440-9ab2-684a7f111ec9


<!-- Inline player: in GitHub's web editor, drag git-flare-demo.mp4 onto the first empty line below this comment. -->


**[Demo video](https://github.com/fabriziosalmi/git-flare/releases/download/demo-video/git-flare-demo.mp4)**
(6:39, English, captions in [`video/git-flare-demo.srt`](video/git-flare-demo.srt)) — 0:15 the problem ·
0:41 how it works · 1:28 a live run on Cloudflare with five LLM coding agents, two rogue agents and ten scripted
workers · 3:02 the main guard catching a write made outside the platform · 3:48 tests in a container with internet
disabled · 4:26 scale, measured on Cloudflare · 5:48 limits · 6:11 try it. Every measurement in it comes from
[`benchmarks/results/`](benchmarks/results/); how it was made: [`video/README.md`](video/README.md).

Coordination, review and merge for many coding agents working on one repository, built on
Cloudflare Workers, Durable Objects and [Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/).

An agent **joins** a repository (gets its own Artifacts fork), **claims** a task (gets an atomic lease
and short-lived git credentials), pushes a commit to its fork with plain `git`, and **submits the commit
SHA**. The platform computes the diff itself, runs its gates, collects reviews from agents of different
model families, and hands approved patches to a **merge queue** that composes every non-conflicting patch
into one commit, **runs the project's own tests on that exact tree in a container with internet disabled**
(only a read-only npm proxy is reachable), and only then pushes it to `main` with a compare-and-swap — git
objects and packfile built inside a Durable Object. A failing batch is bisected until the culprit is
rejected. `main` only ever receives commits the queue built from reviewed file contents, never an agent's
commit. Tasks are sharded across Durable Objects; no agent-declared diffs; no shared write access to `main`.

Independent project, not affiliated with or endorsed by Cloudflare.

## Why

- **Claim stampedes.** Agents that coordinate through `git push` race and retry. Here a task-shard
  Durable Object grants each task to exactly one agent; the lease has a monotonically increasing epoch
  (fencing token), so a paused agent that wakes up after losing its lease cannot submit.
- **Correlated reviewers.** Ten instances of the same model agreeing are not ten independent reviews.
  Reviews are grouped by model family (fixed at agent registration, not self-declared per review) and
  discounted geometrically inside a family; merging needs approvals from at least two families.
- **Trust in what is merged.** Reviewers and gates see the diff the platform computed from repository
  objects, between the claim's base commit and the submitted commit: an ordered line diff with context, so a
  line moved elsewhere shows up; content a reviewer cannot read (binary data other than image, font and media
  files that carry their format's signature, symbolic links) fails a gate. Those file contents are what the queue merges, in a commit it builds.

## What is verified

Every measurement below comes from a script in this repository; raw outputs are in
[`benchmarks/results/`](benchmarks/results/). "Staging" is the author's deployment on Cloudflare (Workers
Paid, Artifacts beta, Containers, Queues, Workers AI); the Durable Object figures come from a separate bench
Worker that calls the objects directly, with Artifacts mocked.

| What | Result | Where measured |
|---|---|---|
| End-to-end on real Artifacts (join, claim, `git push` to fork, submit, 2 reviews, merge, `git ls-remote` on main) | 8 runs, all checks passed (26–34 per run); in runs 1–6 some of the concurrent joins failed on zombie forks (6/9 … 14/17), fixed by the alternate-name fallback (runs 7–8: 17/17) ([`e2e-native-runs.json`](benchmarks/results/2026-10-02/e2e-native-runs.json)) | staging |
| The same end-to-end after the review fixes: a lone patch lands as the queue's own commit of the reviewed tree, never the agent's commit | 66/66 checks ([`e2e-native-composed-merge.json`](benchmarks/results/2026-10-03/e2e-native-composed-merge.json)) | staging |
| Merge queue on real Artifacts: 26 patches built on the same old `main` (24 disjoint + 1 conflicting pair) | 25 merged in **one** composed commit, 1 conflict detected, 2.0 s for the batch; 133/133 checks ([`e2e-merge-queue.json`](benchmarks/results/2026-10-02/e2e-merge-queue.json)) | staging |
| Project tests on the composed tree (Cloudflare Containers, internet disabled) | 4 patches approved together, one breaking `add()` in a file nobody else touches: rejected by the real `node --test` after bisection, the other 3 merged; first run 7.1 s (container cold start included), warm runs 0.3–0.5 s; bisection that keeps the known-failing set: 5 test runs instead of 7 on the same scenario ([`e2e-bisection.json`](benchmarks/results/2026-10-02/e2e-bisection.json)) | staging |
| Tests that need an npm dependency: `npm ci` in the container through a read-only registry proxy | install 0.6–1.9 s, a patch using the dependency merged, a breaking one rejected by the tests; a probe test run as the code under test confirmed in the real container: no internet, proxy refuses writes, `node_modules` and npm's cache out of reach, not root. With tests run as root the probe tampered with `node_modules`, broke another test and was rejected ([`deps-tests.json`](benchmarks/results/2026-10-02/deps-tests.json)) | staging |
| Nothing of a test run survives into the next | a test that leaves a detached process and files in every directory the test user can write: one run later the process is gone and so are the files, 7/7 checks; a deliberately broken build (no kill, only `/tmp` wiped), deployed for one run, failed the check ("a process from an earlier run is still writing") ([`container-linger.json`](benchmarks/results/2026-10-03/container-linger.json)) | staging |
| Composed commit validity | objects hash-identical to `git`'s, pack accepted by `git index-pack` (`scripts/verify-git-objects.mjs`, 6/6) | local git |
| Concurrent claims on one task | exactly 1 grant (8–16 racers on staging, 30 locally, 400 in the bench) | staging, local, bench |
| Claim throughput on real Artifacts (16 shards, 200 claims in flight from one client) | on a 2,000-claim run of each design: **121 → 687 claims/s**, provisioning p95 2.9 s → 0.57 s, after claims stopped calling Artifacts (the earlier design minted 2 tokens and read the head per claim); on a 4,000-claim run: **1,091 claims/s**, p95 145 ms, 16 read tokens minted in total. One client: the server's ceiling was not reached ([`claims-load.json`](benchmarks/results/2026-10-02/claims-load.json)) | staging |
| Artifacts under load (control plane and git, from inside the Worker) | ~230 token mints/s on one repository, ~425/s over four; ~320–370 reads or git requests/s per repository; 80 concurrent forks in 5 s. No 429 among the statuses recorded (5 failed git requests have no recorded status); past a few hundred operations/s the control plane queues and latency grows ([`artifacts-load.json`](benchmarks/results/2026-10-02/artifacts-load.json)) | staging |
| Server-side diff + gates for a 1-file change | median 376 ms (138–558), 8 runs on earlier builds of this code, before the merge queue and the ordered diff | staging, measured inside the Worker |
| Pack relay with compare-and-swap (moves the read replicas; earlier builds also used it to fast-forward main) | median 778 ms (483–1,311), the same 8 runs | staging, measured inside the Worker |
| Fork creation (once per agent) | 2–9 s seen by the client (up to 19 s in concurrent bursts before the alternate-name fallback); 15–33 % of concurrent forks failed on the service side, on a seconds-old and on a minutes-old repository, and are retried under an alternate name | staging |
| One task shard (agent already known to the shard) | ~1,030 claims/s; an agent's first claim on a shard looks its fork up in the registry: 330–590/s ([`do-throughput-v2.json`](benchmarks/results/2026-10-02/do-throughput-v2.json)) | bench Worker, Artifacts mocked |
| 32 shards in parallel | 12,900 and 19,200 claims/s aggregate in two of three runs; the third reached 2,875/s, held back by one slow shard | bench Worker, Artifacts mocked |
| Registry: recording reviews as the approval graph grows | about 880–1,400 reviews/s from 0 to 100,000 edges; the earlier build fell from 775/s to 65/s at 20,000 edges ([`do-throughput-v2.json`](benchmarks/results/2026-10-02/do-throughput-v2.json)) | bench Worker |
| LLM agents end to end (`scripts/demo.mjs`): Qwen2.5-Coder writes 5 small features with tests, reviewers of three model families on Workers AI review the platform's diffs, 2 rogue patches, 10 scripted swarm workers with 2 scripted reviewers | three runs, each 15/17 tasks merged: 5/5 LLM patches merged after the project's tests passed in the container, both rogue patches rejected by the reviewers (one had also edited the test to hide the bug); 21 LLM reviews per run, 0 errors in two runs and 1 abstention in one; 7, 4 and 4 pushes ([`demo-demo-952872.json`](benchmarks/results/2026-10-02/demo-demo-952872.json), [`demo-gfdemo-195.json`](benchmarks/results/2026-10-02/demo-gfdemo-195.json), [`demo-gfdemo-980.json`](benchmarks/results/2026-10-02/demo-gfdemo-980.json), the last one recorded for the video: [`video-gfdemo-980/`](benchmarks/results/2026-10-02/video-gfdemo-980/)) | staging |
| Cleanup of closed patches' branches (`gf admin repo cleanup`; the shard alarm also does it a minute after a patch closes) | 9 and 11 branches deleted on two staging repositories, 0 failures; `git ls-remote` on an agent fork showed `task/CL1/1` before and nothing after ([`cleanup-staging.json`](benchmarks/results/2026-10-02/cleanup-staging.json)) | staging |
| Near-duplicate threshold, calibrated on 10,947 pairs from express, click and cobra (real commits vs the same change resubmitted with small edits; different commits, 1,343 touching the same file) | 14 bits: no false positive, recall 0.87 (the previous 8 bits: 0.73; 0.45 on changes of 3–10 lines). A one-literal edit lands within 14 bits 95 % of the time, so near-duplicates go to review flagged; 13 of 15 pairs of independent LLM solutions of the same task were within 14 bits ([`simhash-calibration.json`](benchmarks/results/2026-10-02/simhash-calibration.json), [dataset](benchmarks/datasets/simhash-pairs.jsonl)) | public repositories + Workers AI |
| Read replicas of main: 2,000 clones with 480 in flight | main alone 26 % failed (HTTP 5xx), 43 clones/s; with 4 replicas 5 % failed, 123 clones/s (2.9×); p50 per replica 2.7–3.5 s. An upper bound with 4 independent repositories: 33 % → 0.05 % failed, 64 → 152 clones/s. E2E with 4 replicas 68/68, all 4 moved to a new head in 0.7 s ([`replicas.json`](benchmarks/results/2026-10-02/replicas.json)); a tampered replica is reset by the next sync (workerd test) | staging |
| Main guard (Artifacts has no branch protection): a commit pushed to main with a write token issued outside the platform | alert 5 s after the tamper started (the foreign `token.created` event arrived before the push), merge queue stopped; `restore` put main back to the queue's last head and revoked 3 write tokens; 18 events of a full E2E run (2 own pushes, 10 clones) raised no alert; event lag at most 8.0 s ([`guard-staging.json`](benchmarks/results/2026-10-02/guard-staging.json)). A rollback to an earlier queue head is caught on the push event, without waiting for a merge round (workerd test) | staging |
| Tests | 110 tests inside workerd; 20 fixes of the pre-publication review re-introduced on purpose, one at a time: each made a test fail; 1 more live on staging; the fixes without a dedicated test are listed ([`mutations.txt`](benchmarks/results/2026-10-03/mutations.txt)); CI on GitHub runs the tests, clippy, the reproducible WASM build and the deploy dry-runs | `npm test`, GitHub Actions |

Checked by hand on staging, no raw output kept: a fork token cannot push to `main` (403); a revoked agent
key was refused about 16 s after `gf admin agent revoke` (bound: 30 s while the revocation list is
reachable); one agent firing 800 requests got 636 served, then 429 with `Retry-After` (600/min per
location, approximate by design); `gf admin repo delete` removed 18 agent forks and main in 32 s;
`git fsck --strict` clean on a real `main` built by the queue.

Facts about Artifacts established on the live service (tokens, TTL, revocation, ref CAS, absence of
branch protection, a protocol quirk) are in [`docs/spikes/artifacts-2026-10-02.md`](docs/spikes/artifacts-2026-10-02.md).

## What it is not (yet)

- Conflicts are detected at **file** granularity (same file → the later patch becomes `stale` and its agent
  rebases). Semantic incompatibility across files is caught only if the repository declares tests in
  `.gitflare/gates.json`; repositories without that file merge on review + static gates alone.
- The test container has **internet disabled**. npm dependencies are supported through a read-only registry
  proxy (`test.install` in `.gitflare/gates.json`, e.g. `npm ci --ignore-scripts`), which the tests can reach
  too (GET only); other package managers (`pip`, `cargo`, …) are not, yet. Dependencies are installed on every
  run (npm's own cache keeps it to ~1–2 s for a small tree); the tree's package-manager configs are removed
  first. Each test command runs alone: processes it started are killed when it ends, so a service a test needs
  must be started inside the same command. A patch whose tests time out is rejected like a failing one, and a
  lone patch is rejected on a single failing run: a flaky suite can reject it.
- Platform gates are static (protected paths, secret scan, a dynamic-eval heuristic, no unreadable content:
  binary data other than image, font and media files with their format's signature — WebAssembly and
  executables included — and symbolic links fail). An image crafted to also be valid JavaScript would pass the
  binary gate; its printable strings are shown to reviewers and scanned. Behaviour is checked only by the
  project's own tests in the merge queue.
- One registry Durable Object per repository holds forks, the review graph and the queue: joins, reviews
  and merges go through it. It recorded about 880–1,400 reviews/s in the bench; the queue merged about 12
  patches/s per repository (batch of 25 in 2 s, batches capped at 32).
- One Artifacts repository serves about 30–100 clones/s (it varied between runs) and answers 5xx beyond a
  few hundred concurrent clones. Read replicas (`mirrors` at init) spread clones over K forks of main; the
  merge queue keeps them at main's head. Fetches by agents that already have a clone are not distributed
  differently.
- Each agent needs its own fork (created once, 2–9 s; some concurrent forks fail on the service side and are
  retried under an alternate name).
- Collusion detection follows approval edges between identities. Roles are fixed per key, so a cycle forms
  only when one identity both writes and reviews: a worker and reviewers run by one operator under different
  identities are not caught. The two-family quorum is the real defence.
- Revoking an agent refuses its new requests within 30 s; patches it already submitted and reviews it already
  gave stay valid until an admin closes them. A shard shares one read token among its agents, and one worker
  can hold several tasks at once (bounded by its rate limit and the lease length).
- The status API and the dashboard are public by design: anyone who knows a repository's name sees its tasks,
  patches, reviews with their reasoning and test log tails. Public read routes are not rate limited.
- LLM reviewers are a signal, not a proof: in the demo one reviewer scored a correct patch at 10 %; the
  family quorum outvoted it. They abstain on a change longer than what they read (14,000 characters). The
  scripted swarm reviewers are labelled as scripted in every output.
- Near-duplicate detection is textual (SimHash over changed lines, threshold calibrated on public repositories):
  it cannot tell a cosmetic resubmission from a one-line logic fix inside a larger change, so near-duplicates
  are flagged for reviewers, not closed; only an identical change is closed as a duplicate.

## The `gf` CLI

Agents use `gf` (Node ≥ 22, no dependencies) plus plain `git`. Credentials go to git through environment
variables, never through URLs or the command line. Put it on the `PATH` with `npm link` in this repository
(or `alias gf='node /path/to/git-flare/cli/gf.mjs'`).

```bash
gf login --base <url> --key <agent-key>
gf join tiny-lib                 # once: provisions your Artifacts fork
gf tasks tiny-lib
gf claim tiny-lib T1             # lease + clone of main at the base commit, on the task branch
cd tiny-lib-T1 && $EDITOR src/math.mjs && git commit -am "T1"
gf submit                        # push to your fork, submit the SHA; the platform computes the diff
gf status tiny-lib               # tasks, patches, reviews, merge queue
```

Reviewers: `gf diff <repo> <patch>` and `gf review <repo> <patch> <1-99> --reason "..."`.
Admins log in with `gf login --base <url> --admin-key <key>`, then: `gf admin agent add <id> --role worker|reviewer --family <family>`, `gf admin agent revoke <id>`,
`gf admin repo init <repo> --tasks tasks.json`, `gf admin repo cleanup <repo>` and `gf admin repo delete <repo>`. `gf --help` lists everything.
`GF_ADMIN_KEY=<key> npm run e2e:cli -- --base <url> --repo <seeded repo>` runs the whole flow against a
deployment using only `gf`.

## LLM agents on Workers AI and the demo

[`agents/`](agents/) is a second Worker (`gf-agents`) that calls Workers AI and talks to git-flare through a
service binding:

- `POST /review {repo}`: reviewers of three model families read each patch's platform-computed diff and
  answer with a verdict, a certainty and a reason, submitted as attestations under their own agent keys:
  `meta-llama` (Llama 3.3 70B), `openai` (gpt-oss-120b), `mistral` (Mistral Small 3.1 24B).
- `POST /code {task, files, feedback?}`: the coding model (Qwen2.5-Coder 32B) returns full file contents for a
  task; `feedback` carries the failing test log when the merge queue rejected the previous attempt.

[`scripts/demo.mjs`](scripts/demo.mjs) runs the whole scenario with one command on a seeded copy of
[`fixtures/tiny-lib`](fixtures/tiny-lib): LLM workers claim, code, run the tests locally and submit through
`gf`; two scripted rogue agents try to break `add()`; LLM reviewers review; the merge queue composes, tests
in the container and pushes; an agent whose patch fails the tests retries once with the log.

```bash
node scripts/seed-repo.mjs <repo>                 # a fresh copy of fixtures/tiny-lib on Artifacts
GF_ADMIN_KEY=... GF_AGENTS_TOKEN=... node scripts/demo.mjs \
  --base https://<git-flare url> --agents https://<gf-agents url> --repo <repo> [--swarm 10] [--mirrors 2]
```

The run is written to `benchmarks/results/<date>/demo-<repo>.json`.

## Run it locally (no Cloudflare account needed)

Prerequisites: Node ≥ 22.18 and git. Docker only to rebuild the WASM core (`npm run build:wasm`) or to deploy
the test container; Rust through rustup only for `npm run test:rust`.

```bash
npm ci
cp .dev.vars.example .dev.vars.dev   # ADMIN_KEY and AUTH_SECRET, at least 32 characters each
npm run dev                          # wrangler dev --env dev; its warning about bindings not on env.dev is expected
```

```bash
GF_ADMIN_KEY=<your ADMIN_KEY> npm run e2e -- --base http://localhost:8787   # the whole workflow over HTTP, ~2 s
```

Dashboard: http://localhost:8787/?repo=<repo>. Tests: `npm test` (110 tests in workerd, about 2 minutes).
Rust core: `npm run test:rust`.

Local mode mocks what needs Cloudflare. Artifacts lives in memory: a repository disappears when its Durable
Object is evicted, after about 10 s idle, so run the end-to-end in one go. The test runner is a stand-in that
passes unless a file contains `@gf-test-fail`. `gf` login, tasks, status, diff, review and the admin commands
work against it; `gf claim` and `gf submit` need a deployment (the local end-to-end commits through a
mock-only endpoint instead of git). Real tests, the LLM agents and the main guard need Cloudflare.

## Run it on Cloudflare

Prerequisites: a Workers Paid account with access to Artifacts (beta) and Containers, Docker running (the
deploy builds the test container image) and `npx wrangler login` (the setup scripts use that login through
`wrangler auth token`, with the first account it lists).

```bash
npx wrangler queues create gf-events-staging      # Artifacts events for the main guard
npx wrangler deploy --env staging
npx wrangler secret put ADMIN_KEY --env staging
npx wrangler secret put AUTH_SECRET --env staging
```

```bash
node scripts/seed-repo.mjs <name>                  # Artifacts repository in gf-staging, seeded with fixtures/tiny-lib
node scripts/watch-repo.mjs <name>                 # subscribe main to the events queue (main guard)
GF_ADMIN_KEY=<key> npm run e2e -- --base https://<your-staging-url> --native --repo <name>
```

The top-level environment of `wrangler.jsonc` is production: queue `gf-events`, Artifacts namespace `gf-prod`.

LLM agents: as admin (`gf login --base <url> --admin-key <key>`), register one reviewer per family (`gf admin agent add rev-llama --role reviewer --family meta-llama`,
and the same for `openai` and `mistral`), then deploy `gf-agents` with its secrets (`AGENTS_TOKEN`, a random
bearer token for the demo script; `REVIEWER_KEYS`, a JSON object `{family: agent key}`):

```bash
npx wrangler deploy -c agents/wrangler.jsonc
npx wrangler secret put AGENTS_TOKEN -c agents/wrangler.jsonc
npx wrangler secret put REVIEWER_KEYS -c agents/wrangler.jsonc
```

## API

| Method | Path | Who | Body |
|---|---|---|---|
| POST | `/api/agents` | admin | `{agentId, role: worker\|reviewer, modelFamily}` → `{apiKey}` |
| POST | `/api/agents/:id/revoke` | admin | — → every key of the agent issued so far is refused (everywhere within 30 s) |
| POST | `/api/repos/:repo/guard` | admin | `{action: accept\|restore}` after a main guard alert: take main's current head, or move main back to the last head the queue produced and revoke its write tokens |
| POST | `/api/repos/:repo/cleanup` | admin | `{idleDays?: 1..365 (default 7), dryRun?}`: delete closed patches' branches from agent forks, and forks whose agent has not called `/join` for `idleDays` (never one a queued patch reads from) |
| DELETE | `/api/repos/:repo` | admin | deletes every agent fork, main and all state; repeat while `done` is false (`gf admin repo delete` loops) |
| POST | `/api/repos/:repo/init` | admin | `{tasks: [{id, title, description?}], shards?: 1..64 (default 4, immutable), mirrors?: 0..8 read replicas (immutable), reset?}` |
| POST | `/api/repos/:repo/join` | worker | — → `{fork: {name, remote, token, tokenExpiresAt}}` (fork created once; fresh 1 h write token for it on every call) |
| POST | `/api/repos/:repo/claim` | worker | `{taskId, leaseMs?}` → lease, epoch, base commit, branch, fork remote, main remote + shared read token |
| POST | `/api/repos/:repo/heartbeat` | worker | `{taskId, leaseEpoch, extendMs?}` |
| POST | `/api/repos/:repo/release` | worker | `{taskId, leaseEpoch}` |
| POST | `/api/repos/:repo/submit` | worker | `{taskId, leaseEpoch, commitSha}` |
| GET | `/api/repos/:repo/patches/:id/diff` | any agent | platform-computed change |
| POST | `/api/repos/:repo/attest` | reviewer | `{patchId, confidencePercent: 1..99, reasoning?}` |
| GET | `/api/repos/:repo/status` | public | tasks, patches, stats, merge queue (no credentials) |

Details, state machines and the review policy: [`docs/SPEC.md`](docs/SPEC.md).

## Layout

```
src/index.ts                      HTTP edge: auth, validation, routing
src/routing.ts                    task → shard, patch id → shard
src/durable_objects/RepoCoordinator.ts   task shard: leases, submit, review, healer
src/durable_objects/RepoRegistry.ts      per repo: forks, review graph, merge queue (sole writer of main)
src/artifacts/client.ts           Artifacts gateway (native binding + in-memory mock shared via the registry)
src/git/objects.ts                git blob/tree/commit encoding, tree composition, packfile writer
src/git/smart-http.ts             git smart HTTP: pack relay (fast-forward) and receive-pack with CAS
src/git/diff.ts                   server-side diff from repository objects
src/epistemic/policy.ts           review aggregation and merge/reject rules
src/epistemic/collusion.ts        mutual-approval clusters (Tarjan SCC)
src/gates.ts                      static platform gates
src/testing/runner.ts             test declaration, tree materialization, mock runner
src/durable_objects/TestRunner.ts container (Cloudflare Containers) that runs the project's tests, internet disabled
src/ui/dashboard.ts               live dashboard (/?repo=<repo>): shards, queue, tests, reviews
containers/test-runner/Dockerfile test image (Node 22 + git)
cli/gf.mjs                        the gf CLI
agents/                           gf-agents Worker: LLM reviewers and coding model on Workers AI
scripts/demo.mjs                  one-command demo; scripts/e2e*.mjs end-to-end checks
fixtures/tiny-lib/                demo repository with .gitflare/gates.json
crates/aimp-wasm/                 Rust → WASM SimHash (built by scripts/build-wasm.sh, reproducible)
```

## License

MIT ([LICENSE](LICENSE)). Third-party work used here (Kumo design tokens, the Inter font) is listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Independent project, not affiliated with or endorsed by
Cloudflare.
