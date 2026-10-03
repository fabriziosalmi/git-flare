# Feedback for Cloudflare (Artifacts, Queues event subscriptions, Containers, Wrangler, vitest-pool-workers)

Found while building git-flare on Workers, Durable Objects, Artifacts (open beta), Queues and Containers,
2 October 2026. Every item has a reproduction, what we observed, what we expected, and what we do instead.
No account identifiers are included. Raw data: `benchmarks/results/2026-10-02/` and `docs/spikes/`.

Where to file: Wrangler and vitest-pool-workers items are issues for
[cloudflare/workers-sdk](https://github.com/cloudflare/workers-sdk/issues). Artifacts, event subscriptions and
Containers items go to the products' feedback channels (Cloudflare Developers Discord product channels or the
Community forum); Artifacts is in open beta.

| # | Product | Kind | Summary | Status |
|---|---|---|---|---|
| 1 | Artifacts | bug | upload-pack appends a flush-pkt after the pack | draft |
| 2 | Artifacts | bug | concurrent forks of a young repository leave "zombie" names for ~15 min | draft |
| 3 | Artifacts | feature | branch protection or ref-scoped tokens | draft |
| 4 | Artifacts | behaviour/docs | control plane past its documented rate queues silently, never 429 | draft |
| 5 | Artifacts | behaviour/docs | git endpoint answers 5xx under concurrent clones | draft |
| 6 | Artifacts | docs | token prefix, binding error codes, `lastPushAt` | draft |
| 7 | Queues event subscriptions | bug | `repo_name: "*"` accepted but matches nothing | draft |
| 8 | Queues event subscriptions | docs | event type names differ between creation and delivery | draft |
| 9 | Queues event subscriptions | behaviour/docs | a new subscription misses its first events | draft |
| 10 | Wrangler | bug | `queues subscription create --source artifacts.repo` cannot pass namespace/repo_name | filed: cloudflare/workers-sdk#16043 |
| 11 | Containers | bug | `container.exec(..., { user })` throws "internal error" | draft |
| 12 | vitest-pool-workers | bug | 0.22.0 pins vulnerable undici/sharp and an old wrangler | filed: cloudflare/workers-sdk#16044 (containers config), #16045 (undici/sharp) |

---

## 1. Artifacts: upload-pack appends a flush-pkt after the pack (no side-band)

**Repro.** `POST <repo>.git/git-upload-pack` with `want <sha> ofs-delta no-progress`, flush, `done` (no
`side-band`/`side-band-64k` capability). Save the body after the `NAK` pkt-line.

**Observed.** The pack (valid SHA-1 trailer) is followed by four extra bytes `0000`. `git index-pack` on the
saved body: `fatal: pack has junk at the end`.

**Expected.** Without side-band, the response ends with the pack's trailer (git's `upload-pack` sends no
flush after the pack in this mode).

**Impact / workaround.** Any client that streams the response straight into `index-pack` fails. We strip the
four bytes only when they are `0000` and the pack checksum validates without them (`src/git/smart-http.ts`,
`extractPack`).

## 2. Artifacts: concurrent forks of a young repository leave unusable names

**Repro.** Create a repository, push one commit, and within a few seconds call `fork()` 20 times in parallel
(distinct names) through the Workers binding.

**Observed.** 20–30 % of attempts fail ("An internal error occurred."). The failed names then answer
"repository already exists" to `fork()`/`create()`, while `get()` answers "Repository not found" and the name
is absent from `list` for about 15 minutes, after which it can be created again. On repositories older than a
minute: 0 failures in 32 concurrent forks and 80/80 in another run (5.0 s, p50 2.8 s), but 3 of 20 failed the
same way in a later run on a repository minutes old.

**Expected.** A failed fork leaves nothing behind, or `get()`/`list` show it; or the error says to retry later.

**Workaround.** Wait-and-retry with backoff, then an alternate name (`<name>-r2`), and revoke every token on
the new fork.

## 3. Artifacts: no branch protection; tokens are repository-wide (feature request)

**Repro.** With a `write` token on a repository: `git push --force origin HEAD~1:refs/heads/main` → accepted
(`+ abc...def HEAD~1 -> main (forced update)`); creating and deleting branches is also allowed.

**Request.** Either protected refs (no force push, no deletion, optionally only fast-forward from a given
token) or tokens scoped to ref patterns (e.g. write only to `refs/heads/task/*`). With ref-scoped tokens a
platform could give each agent write access to its own branch namespace in one shared repository instead of
one fork per agent (forks cost 2–9 s each, seen by the client, and one repository per agent).

**Workaround.** No agent ever holds a write token on main; a single Durable Object writes main; and a guard
compares main's head and the `pushed` / `token.created` events with what that object wrote, stopping merges and
restoring main when something else wrote it (`src/guard.ts`).

## 4. Artifacts: past the documented control-plane rate, calls queue instead of failing

**Repro.** From one Worker deployment, 4,000 `createToken('read')` calls on one repository with ~480 in
flight (`src/bench.ts`, `scripts/bench-artifacts.mjs`).

**Observed.** No error in the token runs, and no 429 among the statuses recorded in any run (5 failed git
requests were logged without their status). Throughput flattens (≈230 mints/s on one repository, ≈425/s over
four, ≈350 `info()`/`readTree()`/git `info/refs` per second per repository) and latency grows with the number
in flight (p50 1.8 s at 4,000 mints). The documented limit is 2,000 requests per 10 s per namespace.

**Expected.** 429 with `Retry-After` past the limit, or documentation that excess requests are queued (and up
to what latency), so clients can choose between waiting and shedding load.

## 5. Artifacts: the git endpoint answers 5xx under concurrent clones

**Repro.** Clones of one small repository (ref advertisement + `git-upload-pack` of main) from a Worker with 120,
240, 360 and 480 in flight.

**Observed.** 120: 500/500; 240: 999/1,000; 360: 22 % failed; 480: 26–33 % failed, all HTTP 5xx on the
advertisement or the upload-pack. Successful throughput stayed around 30–100 clones/s depending on the run.
The same load spread over four repositories: 0.1–5 % failed.

**Expected.** 429 with `Retry-After` (as for an overloaded origin), and a documented per-repository clone
capacity. **Workaround.** Read replicas (forks kept at main's head by the platform).

## 6. Artifacts: small documentation gaps

- Tokens look like `art_v2_x_<hex>?expires=<unix>`; the docs show `art_v1_`.
- Binding errors are plain `Error`s without a `code` (e.g. `"ArtifactsError: Repository not found: <name>."`):
  callers have to match on the message.
- `info().lastPushAt` stays `null` and `updatedAt` does not change after pushes; `log({ ref, limit: 1 })` is
  the reliable way to see that a branch moved.

## 7. Event subscriptions: `repo_name: "*"` is accepted and matches nothing

**Repro.** `POST /accounts/{id}/event_subscriptions/subscriptions` with `source: { type: "artifacts.repo",
namespace: "<ns>", repo_name: "*" }`, `events: ["pushed"]` → created. Push to any repository of the namespace.

**Observed.** No message within 60 s (an exact-name subscription created next to it delivered `pushed`,
`cloned` and `token.created` for its repository within seconds).

**Expected.** Either reject `*` at creation, or support it (a namespace-wide `pushed` stream would let
platforms watch every agent repository without one subscription each).

## 8. Event subscriptions: event type names differ between creation and delivery

Creation accepts `pushed`, `token.created`, … and rejects `cf.artifacts.repo.pushed` ("Unrecognized event types
for source type"), while delivered messages carry `type: "cf.artifacts.repo.pushed"` and Wrangler's own list of
Artifacts event types uses the `cf.artifacts.repo.*` names. Accepting both, or documenting the creation names
next to the schemas, would avoid the confusion.

## 9. Event subscriptions: a new subscription misses its first events

**Observed.** Subscriptions created seconds before activity on five repositories (main and four forks)
delivered 6 of the first 10 `pushed` events; minutes later every push was delivered (5/5 within 6 s).

**Expected.** Documentation of the activation delay (or a status field that says when a subscription is
live). **Workaround.** The guard does not depend on events alone: it also checks main's head on every merge.

## 10. Wrangler: `queues subscription create --source artifacts.repo` cannot be used

**Repro.** `npx wrangler queues subscription create <queue> --source artifacts.repo --events pushed`
(wrangler 4.146/4.147).

**Observed.** `Validation error: Required at "source.namespace"; Required at "source.repo_name"`. The command
has no flags for them (`parseSourceArgument` returns `{ type: "artifacts.repo" }`).

**Expected.** `--namespace` and `--repo-name` options for `artifacts.repo` (as `--zone-id`/`--domain` exist for
`email.sending`). **Workaround.** The REST API (`scripts/watch-repo.mjs`).

## 11. Containers: `exec` with the `user` option throws "internal error"

**Repro.** In a Durable Object with a container (image `node:22-alpine`, user `node` exists, uid 1000):
`await ctx.container.exec(['sh', '-c', 'id'], { user: 'node' })`.

**Observed.** `internal error; reference = …` on every attempt; the same call without `user` works. The option
is in `ContainerExecOptions` in workers-types.

**Workaround.** `su-exec node:node …` in the image (`/sbin/su-exec`).

## 12. vitest-pool-workers 0.22.0: old pinned dependencies

`@cloudflare/vitest-pool-workers@0.22.0` (latest on 2 October 2026) depends on `miniflare 5.20260815.0-alpha`
(undici 7.29.0, sharp 0.35.2: 11 Dependabot alerts, 3 high) and bundles wrangler 4.124, which rejects the
Durable Object-managed `containers` configuration that current wrangler accepts; its workerd supports
compatibility dates only up to 2026-08-22. Workarounds: npm `overrides` for undici/sharp and a separate
`wrangler.test.jsonc` without the containers section. Related, closed: cloudflare/workers-sdk#10408 ("Cloudflare containers don't
work with vitest-pool-workers").

---

No existing workers-sdk issue matched items 10–12 (searched 2 October 2026); filed the same day as cloudflare/workers-sdk#16043, #16044 and #16045. Items 1–9 and 11 go to the product feedback channels (Discord / Community).
