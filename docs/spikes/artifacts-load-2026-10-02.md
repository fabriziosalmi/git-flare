# Artifacts under load

Measured on 2 October 2026 from inside the staging Worker (`git-flare-staging`, namespace `gf-staging`), one
deployment, one client location. Raw data: [`benchmarks/results/2026-10-02/artifacts-load.json`](../../benchmarks/results/2026-10-02/artifacts-load.json)
and [`claims-load.json`](../../benchmarks/results/2026-10-02/claims-load.json). Probe: `src/bench.ts`
(admin-only, routed only with `BENCH=1`), driven by `scripts/bench-artifacts.mjs`.

## Documented limits

[Artifacts limits](https://developers.cloudflare.com/artifacts/platform/limits/), read on 2 October 2026:
control plane 2,000 requests per 10 s per namespace; git 2,000 requests per 10 s per repository; repositories
and namespaces unlimited; 1 GB per repository.

## What we measured

| Operation | Load | Result |
|---|---|---|
| `info()` on one repository | 4,000 calls, 480 in flight | 348/s, p50 1.3 s, 0 errors |
| `createToken(read)` on one repository | 4,000 calls | 230/s, p50 1.8 s, 0 errors |
| `createToken(read)` on four repositories at once | 4 × 2,000 calls | 103–114/s each, ~425/s in total, 0 errors |
| `revokeToken` | thousands | 125–340/s |
| `readTree()` on one repository | 4,000 calls | 322/s, p50 1.5 s, 0 errors |
| git `GET info/refs` on one repository | 4,000 requests | 367/s, p50 1.3 s, 0 errors |
| git `GET info/refs` on two repositories at once | 2 × 4,000 | 340/s + 257/s; 5 HTTP errors (status not recorded by that build) |
| `fork()` of a minutes-old repository | 20, then 80 concurrent | 17/20 (3 "internal error"), then 80/80 in 5.0 s, p50 2.8 s |

At low load single calls take 40–100 ms. Every operation except the git request also calls `ns.get()` first.

## What it means

1. **No 429 among the statuses recorded** (5 failed git requests were logged without their status). Past
   roughly 200–400 operations per second the control plane queues: throughput flattens and latency grows with
   the number of calls in flight. Nothing fails loudly, so a design that calls Artifacts
   on every request degrades into multi-second latencies instead of errors.
2. **Per repository and per namespace.** Token minting reached ~230/s on one repository and ~425/s spread over
   four: part of the ceiling is per repository, part is shared. Where the shared part sits (namespace,
   account, the calling Worker's location) cannot be told from one deployment.
3. **The earlier claim path hit exactly this.** Each claim read main's head and minted two tokens (one on
   main), and each submit revoked both: about 10 binding calls per task, six of them on the main repository.
   On staging with 16 shards it served 121 claims/s with provisioning p95 2.9 s; a 4,000-claim run had requests
   waiting more than 5 minutes.
4. **Change made.** Claims now make no per-claim Artifacts call: main's head is cached per shard for one
   second, the read token for main is shared per shard (one mint per half hour), and the write token for an
   agent's fork comes from `join` (one per agent per hour). On the same 2,000-claim run: 687 claims/s,
   provisioning p95 0.57 s; a 4,000-claim run: 1,091 claims/s, provisioning p50 0 ms / p95 145 ms, 16 tokens
   minted for 4,000 claims. From one client (one machine, 200 requests in flight): the server's ceiling was
   not reached.

## What remains bounded by Artifacts

- **Clones and fetches of main**: one repository serves ~320–370 git requests/s, so roughly 100 clones/s
  (`ls-refs` + `fetch`), and under heavy clone load it answers 5xx. Read replicas of main (forks refreshed by
  the merge queue after each push, `mirrors` at init) spread that load: with 4 replicas, failed clones went from
  26 % to 5 % and successful clones/s from 43 to 123 (`replicas.json`).
- **Agent onboarding**: one fork per agent, ~16 forks/s at 80 concurrent; 100,000 agents joining one
  repository would take on the order of hours at that rate (once).
- **Submit**: the server-side diff reads objects through the binding (fork and main); a 1-file change costs a
  handful of calls, a 200-file change a few hundred.
- **Merge queue**: one push per round and a few reads per patch; not a bottleneck at the measured ~12
  patches/s per repository.
