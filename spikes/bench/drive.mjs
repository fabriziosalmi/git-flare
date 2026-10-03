#!/usr/bin/env node
// Drives the gf-bench Worker (spikes/bench/index.ts, deployed with `wrangler deploy -c spikes/bench/wrangler.jsonc`
// and secret BENCH_TOKEN). Prints JSON.
//
//   BENCH_TOKEN=... node spikes/bench/drive.mjs claims  [--n 400] [--parallel 1,8,32]
//   BENCH_TOKEN=... node spikes/bench/drive.mjs reviews [--steps 0,2000,5000,10000,20000,50000,100000]
const args = process.argv.slice(2);
const op = args[0];
const arg = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const BASE = arg('base');
const { BENCH_TOKEN } = process.env;
if (!BENCH_TOKEN || !BASE || !['claims', 'reviews'].includes(op)) {
  console.error('usage: BENCH_TOKEN=... node spikes/bench/drive.mjs claims|reviews --base https://<gf-bench url> [options]');
  process.exit(2);
}
const run = Date.now().toString(36);
const get = async (path) => {
  const r = await fetch(`${BASE}/${BENCH_TOKEN}/${path}`, { signal: AbortSignal.timeout(1_200_000) });
  const body = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (!r.ok) throw new Error(`${path.split('?')[0]}: ${JSON.stringify(body)}`);
  return body;
};

const out = { date: new Date().toISOString(), base: BASE, op, runs: [] };
if (op === 'claims') {
  const n = Number(arg('n', '400'));
  for (const p of arg('parallel', '1,8,32').split(',').map(Number)) {
    const res = await Promise.all(Array.from({ length: p }, (_, i) => get(`claims?n=${n}&run=${run}p${p}s${i}`)));
    const ok = res.reduce((a, r) => a + r.claims.ok, 0);
    const wall = Math.max(...res.map((r) => r.claims.wallMs));
    const firstOk = res.reduce((a, r) => a + r.firstClaims.ok, 0);
    const firstWall = Math.max(...res.map((r) => r.firstClaims.wallMs));
    out.runs.push({
      shards: p,
      claimsPerShard: n,
      steady: { ok, slowestShardWallMs: wall, aggregatePerSec: Math.round((ok / wall) * 1000), perShard: res.map((r) => r.claims.perSec) },
      firstClaim: { ok: firstOk, slowestShardWallMs: firstWall, aggregatePerSec: Math.round((firstOk / firstWall) * 1000) },
      joinsPerSec: res.map((r) => r.joins.perSec),
    });
    console.error(JSON.stringify(out.runs.at(-1)));
  }
} else {
  // One registry; edges are added in chunks below the per-invocation subrequest limit, then 200 reviews timed.
  let from = 0;
  let fresh = 1;
  for (const to of arg('steps', '0,2000,5000,10000,20000,50000,100000').split(',').map(Number)) {
    const t0 = Date.now();
    while (from < to) {
      const step = Math.min(to, from + 4500);
      await get(`reviews?from=${from}&to=${step}&n=1&run=${run}&fresh=${fresh}`);
      fresh = 0;
      from = step;
    }
    const prefillWallMs = Date.now() - t0;
    const r = await get(`reviews?from=${to}&to=${to}&n=200&run=${run}&fresh=${fresh}`);
    fresh = 0;
    out.runs.push({ edges: to, prefillWallMs, reviewsPerSec: r.reviews.perSec, wallMsFor200: r.reviews.wallMs });
    console.error(JSON.stringify(out.runs.at(-1)));
  }
}
console.log(JSON.stringify(out, null, 2));
