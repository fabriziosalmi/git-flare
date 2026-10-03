#!/usr/bin/env node
// Drive the Artifacts load probe (POST /api/bench/artifacts, staging with BENCH=1) at increasing load.
// Each step fires `invocations` requests in parallel; each request runs `n` operations with `concurrency`
// in flight inside Cloudflare. Rates are computed from timings measured inside the Worker.
//
//   GF_ADMIN_KEY=... node scripts/bench-artifacts.mjs --base <staging url> --repo <repo> --op token \
//     --steps 1x50,10x50,40x50 [--concurrency 6] [--tree <sha>] [--out file.json]
import fs from 'node:fs';

const args = process.argv.slice(2);
const arg = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const BASE = arg('base');
const REPO = arg('repo');
const OP = arg('op');
const STEPS = arg('steps', '1x50,10x50').split(',').map((s) => s.split('x').map(Number));
const CONC = Number(arg('concurrency', '6'));
const TREE = arg('tree');
const OUT = arg('out');
const { GF_ADMIN_KEY } = process.env;
if (!BASE || !REPO || !OP || !GF_ADMIN_KEY) {
  console.error('usage: GF_ADMIN_KEY=... node scripts/bench-artifacts.mjs --base <url> --repo <repo> --op <get|info|token|readTree|refs|fork> [--steps PxN,...]');
  process.exit(2);
}

const pct = (xs, p) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] : null);

async function invoke(n, tag) {
  const res = await fetch(`${BASE}/api/bench/artifacts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${GF_ADMIN_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ op: OP, repo: REPO, n, concurrency: CONC, ...(TREE ? { tree: TREE } : {}), ...(tag ? { tag } : {}) }),
  });
  const body = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!res.ok || body.ok === false) return { invocationError: body.error ?? `HTTP ${res.status}` };
  return body;
}

const report = { date: new Date().toISOString(), base: BASE, repo: REPO, op: OP, concurrencyPerInvocation: CONC, steps: [] };
for (const [P, N] of STEPS) {
  const t0 = Date.now();
  const results = await Promise.all(Array.from({ length: P }, (_, i) => invoke(N, OP === 'fork' ? `${Date.now().toString(36)}${i}` : undefined)));
  const wallMs = Date.now() - t0;
  const ok = results.filter((r) => !r.invocationError);
  const lat = ok.flatMap((r) => r.latencies).sort((a, b) => a - b);
  const errors = {};
  for (const r of ok) for (const [k, v] of Object.entries(r.errors)) errors[k] = (errors[k] ?? 0) + v;
  for (const r of results.filter((r) => r.invocationError)) errors[`invocation: ${r.invocationError}`] = (errors[`invocation: ${r.invocationError}`] ?? 0) + 1;
  const succeeded = ok.reduce((a, r) => a + r.succeeded, 0);
  const attempted = P * N;
  const serverMs = Math.max(1, ...ok.map((r) => r.opMs));
  const revokeMs = Math.max(0, ...ok.map((r) => r.revokeMs ?? 0));
  const revoked = ok.reduce((a, r) => a + (r.revoked ?? 0), 0);
  const step = {
    invocations: P,
    perInvocation: N,
    attempted,
    succeeded,
    failed: attempted - succeeded,
    opWindowMs: serverMs,
    clientWallMs: wallMs,
    attemptedPerSec: Math.round((attempted / serverMs) * 1000),
    succeededPerSec: Math.round((succeeded / serverMs) * 1000),
    latencyMs: { p50: pct(lat, 50), p95: pct(lat, 95), p99: pct(lat, 99), max: lat.at(-1) ?? null },
    revoked,
    revokeWindowMs: revokeMs,
    revokedPerSec: revokeMs ? Math.round((revoked / revokeMs) * 1000) : null,
    created: ok.flatMap((r) => r.created ?? []),
    errors,
  };
  report.steps.push(step);
  const { created, ...printable } = step;
  console.error(JSON.stringify({ ...printable, created: created.length }));
  await new Promise((r) => setTimeout(r, 11_000)); // let the 10-second rate window drain between steps
}
const text = JSON.stringify(report, null, 2).replace(/art_v[A-Za-z0-9._-]+/g, 'art_v***');
if (OUT) fs.writeFileSync(OUT, text + '\n');
else console.log(text);
