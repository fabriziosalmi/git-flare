# git-flare — Specification

Version 5 — 2026-10-03. Status: **draft, matches the implementation on `main`**.
Version 5 shows reviewers an ordered diff with context, fails content they cannot read, always lands the
queue's own commit, and leaves nothing of a test run behind; version 4 added project tests on the composed
tree; version 3 task sharding and the merge queue.

Every rule below is enforced in code. Most are covered by the workerd tests (`npm test`); the test container's
behaviour is checked on staging by `scripts/e2e-deps.mjs`; the few fixes without a dedicated test are listed in
`benchmarks/results/2026-10-03/mutations.txt`.

## 1. Actors and identity

| Role | Can | Identity |
|---|---|---|
| admin | register and revoke agents, initialize repositories | `ADMIN_KEY` secret (≥ 32 chars), constant-time comparison |
| worker | join, claim, heartbeat, release, submit | agent key |
| reviewer | read diffs, attest | agent key |
| platform | compute diffs, run gates, merge | the Durable Objects |

Agent keys are `gfk1.<base64url(payload)>.<base64url(HMAC-SHA256)>`, signed with `AUTH_SECRET`,
verified in the Worker without any lookup. Payload: `{v, sub (agentId), role, fam (model family), iat, exp}`.
The model family is normalized at registration (`trim`, lowercase, collapsed spaces; empty → `unknown`)
and can never be supplied per request.

**Revocation** (`POST /api/agents/:id/revoke`, admin): every key of that agent issued up to the current
second is refused with 401 `KEY_REVOKED`; keys issued from the next second on work. The list lives in one
Durable Object (`Revocations`, named `global`); each Worker isolate caches the whole list and refreshes it
every 30 s (one call per isolate per period, independent of the number of agents), so a revocation is
enforced everywhere within 30 s (measured on staging: last accepted request 16 s after the revocation).
A failed refresh keeps serving the cached list; with no list at all, authenticated requests fail closed
(503 `REVOCATIONS_UNAVAILABLE`). A revoked worker keeps push access to its own fork until its fork token
expires (≤ 1 h); it can no longer submit, so nothing reaches main.

**Rate limiting**: every authenticated agent request counts against a per-agent budget of 600 requests per
60 s (Cloudflare Rate Limiting binding `AGENT_LIMITER`, keyed by agent id; counters are per Cloudflare
location and approximate by design: 636 of 800 requests passed in the staging probe). Over budget: 429
`RATE_LIMITED`, `Retry-After: 10`. The binding is absent in local dev and tests.

Durable Objects are reachable only through the Worker and trust the identity it passes. Request bodies
never carry an agent id.

## 2. Topology

- **Registry** (one Durable Object per repository, named `<repo>`): repository config (shard count, main
  remote), agent forks, the review graph, the merge queue. It is the only component that writes `main`.
- **Task shards** (`RepoCoordinator`, named `<repo>#<i>`, `i < N`): task `t` lives on shard
  `fnv1a(t) % N`; a patch id is `p<i>_<12 hex>` and carries its shard.
- `N` is chosen at `init` (1–64, default 4) and is immutable for the repository name (the Worker caches it
  per isolate for routing). `/status` fans out to the registry and every shard.
- State lives in each object's SQLite-backed storage, one key per task, patch and review edge. A shard keeps
  tasks and patch metadata in memory with a per-file summary (path, status, line counts, blob id); the full
  change (added and removed lines) is stored under its own key and read only to serve `/diff` (a reload of
  10,000 patches is covered by a test). The registry keeps forks and review edges in memory with adjacency
  sets; recording a review writes one key and walks only what the author's identity reaches.

## 3. Workspace model (Cloudflare Artifacts)

- Main repo `<repo>`; one fork per agent (`<repo>--a<sha256(agentId)[0..12]>`, or the same name with
  `-r2` if the first attempt leaves an unreadable name), created by the registry on `join` (≈ 2–5 s, once).
  Every token on a new fork (including the 24 h token `fork()` mints) is revoked immediately.
- **Fork credentials come from `join`**: every call returns a fresh **write** token for the agent's own fork,
  valid 1 h (the `gf` CLI caches it and calls `join` again when less than 15 minutes remain). It is returned,
  never stored. Scope: that one fork; it cannot push to main (verified on the live service). It belongs to the
  agent, not to a lease: fencing is the lease epoch checked at submit, not the token.
- **`claim` makes no per-claim Artifacts call.** It returns the base commit (main's head, cached by the shard
  for at most 1 s; dropped when a patch of the shard merges) and the shard's **shared read token for main**
  (minted with a 1 h TTL, kept in memory only, renewed when less than 30 minutes remain, never revoked: read
  access to main is what every agent gets anyway).
- Why: Artifacts throttles control-plane calls by queueing (measured, `benchmarks/results/2026-10-02/
  artifacts-load.json`: ~230 token mints/s on one repository, ~425/s across four, no 429s, latency growing
  with load). The earlier design (head + 2 tokens per claim, 2 revocations at submit) capped claims at 121/s
  with p95 provisioning 2.9 s on 16 shards; this one served 1,091 claims/s with p50 provisioning 0 ms and 16
  read tokens in total (`benchmarks/results/2026-10-02/claims-load.json`), limited by the single client.
- Agents push to branch `task/<taskId>/<leaseEpoch>` of their fork.
- Nobody but the registry ever holds a write token on main (Artifacts has no branch protection).

## 4. Task state machine (per shard)

| From | Event | Guard | To | Effects |
|---|---|---|---|---|
| available | claim | worker has joined | claimed | `leaseEpoch += 1` synchronously, `provisioning = true`, persisted before any external call |
| claimed (provisioning) | base commit + shared read token obtained | epoch unchanged | claimed | returned with the lease |
| claimed (provisioning) | any provisioning error | epoch unchanged | available | 502 `PROVISIONING_FAILED` |
| claimed | claim by anyone | lease valid, provisioning or op in flight | — | 409 `ALREADY_CLAIMED` / `ALREADY_HOLDER` |
| claimed | claim | lease expired | claimed (new epoch) | old holder fenced by the epoch |
| claimed | heartbeat(epoch) | holder, epoch, lease valid | claimed | lease extended (10 s – 10 min; total lease age ≤ 1 h) |
| claimed | release(epoch) | holder, epoch | available | — |
| claimed | lease expiry (alarm) | not provisioning, no op | available | — |
| claimed | submit(epoch, sha) | holder, epoch, lease valid | submitted / available | §5 |
| submitted | patch merged | — | merged | terminal |
| submitted | patch rejected / stale / expired | — | available | — |
| merged | anything | — | — | terminal |

## 5. Submit

1. The commit must exist in the agent's fork (404 `COMMIT_NOT_FOUND_IN_FORK`).
2. **Base** = the current main head if the commit descends from it (the agent rebased), else the claim's
   base commit, which the commit must descend from (409 `NOT_DESCENDANT_OF_BASE`; ≤ 200 commits walked).
3. The change is computed from repository objects between base and commit (trees by hash, changed blobs
   read; resulting blob id and mode recorded). Per modified text file an **ordered** line diff (Myers): a line
   moved elsewhere is removed and added, never invisible; reviewers get unified hunks with 3 lines of context,
   a missing final newline marked as git marks it (up to 400,000 characters of hunks per patch, then ordered
   removed/added lines). Myers stops at 2,000 edits per file and 20,000 per patch; past that, or when the two
   versions share no line, the whole differing middle is shown removed then added. Binary files (judged on the
   new content) carry their printable strings (tab included) and first 16 bytes; mode changes of an unchanged
   blob are reported. Limits: 200 files, 1 MB.
4. Platform gates (§7) run on it; a SimHash is computed over the canonical change.
5. Status: gate failed → `rejected`; else the **same canonical change** (equal sha256 of the canonical text:
   whitespace and line order aside) as a `rejected` or `duplicate` patch of the same task → `duplicate`; else
   `evaluating`. A SimHash within **14 bits** of such a patch adds `nearDuplicateOf: {patchId, distance}`, shown
   to reviewers in `/diff` and to the LLM reviewers in their prompt; the patch is still reviewed. 14 bits is the
   largest distance with no false positive on 10,947 calibration pairs from public repositories (recall 0.87 on
   resubmissions with small edits); at that distance a one-line logic change is as near as a cosmetic one,
   hence flag, not close (`simhash-calibration.json`). `stale` and `expired` patches never count.

## 6. Review policy

- Reviewer role; one review per reviewer per patch; no self-review (also across a second key with the same
  agent id); only `evaluating` patches accept reviews (`queued` → 409 `PATCH_QUEUED`).
- `MLO[p] = round(1000·ln(p/(100−p)))`, `p ∈ 1..99`, generated table checked in CI. `p > 50` approves,
  `p < 50` objects.
- Per family, ranked by |MLO| then reviewer id, weights 1, ½, ¼, … (integer basis points); aggregate = sum.
- **Collusion**: the registry keeps edges reviewer → author for every approval (across all shards).
  Approvals from reviewers in the author's strongly connected component (size > 1) are excluded. Roles are
  fixed per key, so such a cycle needs an identity that both writes and reviews; identities run by one
  operator are not linked (the two-family quorum is the defence there).
- **Decision** after each review: gate failed → reject; no gate results → never merge; ≥ 2 approvals from
  ≥ 2 families and aggregate ≥ +2944 → **queue**; ≥ 2 objections from ≥ 2 families and ≤ −2944 → reject;
  else pending. Unreviewed patches expire after 30 minutes.

## 7. Gates (static)

`non-empty`, `protected-paths` (`.github/workflows/`, `.gitflare/`), `binary-content` (binary data — a NUL
byte — unless the file is an image, font or media file by extension **and** by its format's signature in the
first bytes: a reviewer cannot read it; WebAssembly, executables and archives included), `no-symlinks` (mode
120000), `secret-scan` (new lines — added minus removed, so a moved line is not new — and binary files'
printable strings, including any match past what reviewers are shown), `dynamic-eval-heuristic` (new lines of
script files and binary files' strings; bypassable, catches accidents).

**Project tests** (§8, step 3b): a repository opts in with `.gitflare/gates.json` on main —
`{"test": {"commands": ["…"], "timeoutSec": 10..900}}` (1–10 commands). `.gitflare/` is a protected path, so
agents cannot change it. Missing file → no tests. Invalid file, or tests declared but no runner configured →
**fail closed**: nothing lands, `lastError` is reported in `/status`, the queue retries every 30 s.

## 8. Merge queue (registry)

A patch reaching the merge decision becomes `queued` and is appended to the registry's queue with its
fork, commit, base and changed files (path, resulting blob id and mode, or deletion). An alarm runs a
round 150 ms after the first enqueue and again while the queue is not empty. Each round:

1. Read main's head `H`. Take up to 32 queued patches in arrival order.
2. **Fast path**: exactly one patch and `H` is an ancestor of its commit → relay the fork's pack to main
   (upload-pack `want commit` / `have H`, then receive-pack `H → commit`): main becomes the exact commit.
3. Otherwise, for each patch in order: `C_main` = files changed on main between the patch's base and `H`
   (trees only). If any file of the patch is in `C_main` or already taken by an earlier patch of this
   round (same path, or a file/directory clash) → **conflict**: the patch becomes `stale`
   (`mergeError: CONFLICT: <path> …`) and its task returns to the pool; the agent re-claims and rebases.
   Otherwise its files join the batch.
3b. **Tests**: if the repository declares tests, the registry materializes the tree the batch would
   produce (all files of `H`, the batch's files applied; blobs cached by id) and sends it as a tar to the
   repository's `TestRunner` (a Durable Object with a Cloudflare Container, `standard-1`, started with
   **internet disabled**). Optional `test.install` commands (≤ 5) run first, as root, without any
   package-manager config of the tree (`.npmrc`, `.yarnrc`, `.yarnrc.yml`, `.pnpmfile.cjs`, at any depth,
   removed first; npm's `git` program, yarn's `yarn-path` and scripts pinned off), with npm pointed at `registry.npm.internal`:
   the only name the container can reach (during install and tests alike), routed by
   `interceptOutboundHttp` to the `RegistryProxy` entrypoint, which forwards GET/HEAD to registry.npmjs.org and
   refuses anything else; `npm_config_ignore_scripts=true`; npm's cache is root-only and content-addressed
   (checked against the lockfile's integrity hashes). Test commands then run as the unprivileged `node` user
   (su-exec): `node_modules` and the npm cache are out of reach. Nothing of a run survives into the next: every
   process of the test user is killed (and checked gone) before and after each run and after each command,
   timeouts included (so each test command runs alone), and every directory that user can write (`/tmp`,
   `/var/tmp`, `/dev/shm`, `/dev/mqueue`, its home, the test HOME and the run directory) is wiped before each
   run; tini, PID 1, reaps the killed processes. Each run
   records the image digest it used. Commands run in order under one time budget; the first
   non-zero exit or timeout fails the run. A failing batch of more than one patch becomes the **suspect
   set** (known to fail on `H`); each following round tests the first half of the suspects. A passing half
   lands and the suspects shrink to the other half, which is known to fail on the new main and is not
   re-tested as a whole; a failing half becomes the new suspect set; patches outside it wait. A patch is
   rejected only after failing **alone** on the current main (`TESTS_FAILED`, last 1.5 KB of the log),
   never by inference (a flaky failure in that run still rejects it: there is no retry); its task returns to
   the pool. If `main` moves for any other reason the suspect set is dropped. Cost for one culprit among n
   patches: about log2(n) + 2 runs (4 patches: 4–5 runs; 8 patches: 5). A patch that breaks only
   together with an earlier one is tested on top of it once the earlier one lands. Infrastructure errors
   count as merge attempts (3 → `MERGE_FAILED`).
4. The batch becomes one commit, parent `H` — always, also for a single patch whose commit descends from `H`:
   main never receives an agent's commit, whose tree and history may hold more than its diff. Deletions apply
   first, so a patch can replace a file with a directory or a directory with a file. Blobs are read from each author's fork and re-hashed (the
   hash must match), the trees on the changed paths are rebuilt, a commit is written with one
   `Git-Flare-Patch: <patchId> task=… author=… commit=<original sha>` trailer per patch, everything is
   packed (version 2, whole objects) and sent with receive-pack `H → new commit` (CAS). Write token: 5
   minutes, revoked afterwards.
5. CAS refused (`ng … stale ref`) → nothing changes, patches stay queued, next round re-reads `H`. Other
   errors: up to 3 attempts per patch, then `stale` with `MERGE_FAILED`.
6. Outcomes are delivered to the owning shards (at-least-once, retried; shards apply them idempotently).

Artifacts appends a flush-pkt after the upload-pack pack even without side-band; it is stripped only when
the pack's SHA-1 trailer validates without it.

**Semantics**: conflicts are file-level; semantic incompatibility is caught only by the repository's
declared tests. The test container has internet disabled; npm dependencies install through the read-only
registry proxy (3b).

## 8-bis. Resource lifecycle

- A closed patch's branch (`task/<taskId>/<leaseEpoch>` in the author's fork) is deleted by the shard about
  a minute after it closes (alarm, ≤ 50 per run) or on `POST /api/repos/:repo/cleanup`: one receive-pack
  request with delete commands and one short-lived write token per fork. Merged patches' objects are in main
  by then. A fork that no longer exists counts as cleaned.
- Every `/join` stamps the agent's fork with `lastSeenAt` (gf calls it at least hourly to renew its token).
  `cleanup` deletes forks unseen for `idleDays` (≥ 1, default 7) unless a queued patch reads from them; shards
  drop the cached fork and the agent gets a new fork on its next join. Forks recorded before the stamp existed
  start counting at the first sweep. `dryRun` reports without deleting.
- `DELETE /api/repos/:repo` removes every fork, the replicas, main and all state (§6 of the API table).

## 8a. Read replicas of main

`init` takes `mirrors: 0..8` (immutable). The registry creates `<repo>--m<i>` as forks of main; shard `s` reads
from replica `s mod K`: claims return the replica's head as base and the shard's shared read token on that
replica (`main.replica` names it). After delivering each round's outcomes the registry brings every replica to
the head the queue produced: it reads the replica's head (never trusting its own record), fast-forward relays
from main, and resets a replica that is not an ancestor with a CAS ref update. A replica is a cache of main.
Replica pushes count as the platform's own for the main guard. Submit refuses a base that is not in main's
history (409 `BASE_NOT_ON_MAIN`); a base built on top of main's head is diffed against main's head, so any
content a tampered replica added shows in the diff reviewers read. Measured: with 480 clones in flight, main
alone failed 26–33 % (5xx) at 43–64 clones/s; four replicas failed 0.1–5 % at 123–152 clones/s
(`replicas.json`).

## 8b. Main guard

Artifacts has no branch protection and accepts non-fast-forward pushes (verified): any write token on the main
repository can move or rewrite main. The registry is the only intended writer, so it records what it wrote
(every head it landed, the id of every write token it minted on main) and checks two independent signals:

- **Artifacts events**, delivered by a Queues event subscription on main (`scripts/watch-repo.mjs <repo>`:
  `pushed`, `token.created`, `cloned`, `fetched`) to the Worker's `queue()` handler, then to the registry. A push
  to main whose `after` is not a head the queue landed, a push to any other ref of main, or a `write` token it
  did not mint raises an alert. Events that arrive while a round is pushing are judged after the round records
  its landing. Subscriptions are per repository (the API requires `namespace` and `repo_name`; a `*` name matches
  nothing), so agent forks are not watched; only main and its read replicas can move main. A subscription
  created seconds before activity missed its first events (4 of the first 10 pushes on staging), which is
  why the head check below does not depend on events.
- **main's head at every merge round** (no event needed), and after every batch of events with a push to main
  (an event alone takes a rollback to an earlier queue head for an own push; read twice 2 s apart, so a read
  lagging behind the queue's own push raises nothing; a failed read leaves it to the next round): if it differs
  from the last head the queue produced, an alert is raised. Pushes and token events deferred while a round runs
  are stored until judged.

An alert stops the merge queue (`lastError: MAIN_GUARD: …`; patches stay queued) and shows on `/status` and the
dashboard. `POST /api/repos/:repo/guard` (admin) resolves it: `accept` takes the current head as the new
baseline; `restore` revokes every write token on main (a failure fails the restore) and on its replicas (an
unreachable replica does not block it), then moves main back to the last head the platform produced
(empty-pack receive-pack, CAS on the current head). The Worker holds no account credentials: subscriptions
are created by the operator with their own `wrangler login`. Measured on staging: alert 5 s after a foreign
token and push; after the restore main's head was the queue's last head (`guard-staging.json`).

## 9. HTTP

Errors are `{ok: false, error, detail?}` with 400 (validation; unknown fields rejected), 401, 403, 404, 409,
413, 429, 502, 503. Bodies ≤ 64 KB (512 KB for dev routes). Repository names `^[a-z0-9][a-z0-9-]{0,47}$`, ids
`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`. `/status` is public, never contains credentials, and includes the
merge queue (length, counters, recent rounds). Dev-only routes (`dev-commit`, `dev-advance-main`,
`dev-main-files`) exist only when `ARTIFACTS_MODE=mock`. The dashboard renders values with `textContent`.

## 10. Environments

`wrangler.jsonc` top level is production (namespace `gf-prod`); `--env staging` uses `gf-staging`;
`--env dev` mocks Artifacts in memory inside each repository's registry (shards reach it over RPC).
`ARTIFACTS_MODE` must be exactly `native` or `mock`. `QUEUE_BATCH_WINDOW_MS` optionally overrides the
batching window (tests set it high and drive the queue explicitly).

## 11. Capacity (measured 2026-10-02, `benchmarks/results/2026-10-02/`)

- One task shard: ~1,030 claims/s once the agent is known to the shard (its first claim there asks the
  registry for its fork: 330–590/s); 32 shards in parallel: 12,900–19,200 claims/s in two runs, 2,875/s in a
  third held back by one slow shard (a bench Worker calling the objects directly, Artifacts mocked;
  `do-throughput-v2.json`).
- On real Artifacts, claims make no per-claim Artifacts call (§3): 121 → 687 claims/s on the same 2,000-claim
  run, 1,091 claims/s on a 4,000-claim run, over 16 shards from one client (`claims-load.json`).
- Registry review recording: about 880–1,400 reviews/s from 0 to 100,000 approval edges (one key per edge,
  adjacency sets); the earlier whole-graph rewrite fell to 65/s at 20,000 edges.
- Merge queue on real Artifacts: a round merging 25 patches into one commit took 2.0 s (≈ 12 patches/s per
  repository; rounds are capped at 32 patches).
- The registry is a single Durable Object per repository: joins, reviews (edge recording) and merges go
  through it: about 880–1,400 review recordings/s measured, merges about 12 patches/s.
- Test container: first run 7.1 s (cold start included), warm runs 0.3–0.5 s for the `tiny-lib` fixture; bisection
  isolated one culprit among 4 patches in 5 runs (2.8 s of test time, warm container; 7 runs with the earlier
  scheme that re-tested the whole remainder after each passing half).
