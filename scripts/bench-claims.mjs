#!/usr/bin/env node
// Claim throughput on a native deployment (real Artifacts): many tasks over many shards, a few agents
// (each agent needs a fork, created once), many claims in flight. Measures claims/s seen by the client,
// the provisioning time measured inside the shard, and how many distinct main read tokens were handed out
// (one per shard is expected: claims mint nothing per claim).
//
//   GF_ADMIN_KEY=... node scripts/bench-claims.mjs --base <staging url> --repo <seeded repo> \
//     [--tasks 4000] [--shards 16] [--agents 20] [--concurrency 200] [--out file.json]
import fs from 'node:fs';

const args = process.argv.slice(2);
const arg = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const BASE = arg('base');
const REPO = arg('repo');
const TASKS = Number(arg('tasks', '4000'));
const SHARDS = Number(arg('shards', '16'));
const AGENTS = Number(arg('agents', '20'));
const CONC = Number(arg('concurrency', '200'));
const OUT = arg('out');
const { GF_ADMIN_KEY } = process.env;
if (!BASE || !REPO || !GF_ADMIN_KEY) {
  console.error('usage: GF_ADMIN_KEY=... node scripts/bench-claims.mjs --base <url> --repo <seeded repo> [--tasks N] [--shards N] [--agents N] [--concurrency N]');
  process.exit(2);
}
const run = Date.now().toString(36);
const log = (...m) => console.error(`[${new Date().toISOString().slice(11, 19)}]`, ...m);
const pct = (xs, p) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] : null);

async function api(method, p, key, body, timeoutMs = 60_000) {
  const t0 = performance.now();
  try {
    const res = await fetch(`${BASE}${p}`, { method, headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, body: json, ms: performance.now() - t0 };
  } catch (e) {
    return { status: 0, body: { error: e.name === 'TimeoutError' ? `CLIENT_TIMEOUT_${timeoutMs / 1000}s` : `FETCH_FAILED` }, ms: performance.now() - t0 };
  }
}

async function pool(n, concurrency, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, concurrency) }, async () => {
    while (next < n) await fn(next++);
  }));
}

// 1. Tasks, in chunks (request bodies are capped at 64 KB).
const ids = Array.from({ length: TASKS }, (_, i) => `L${i}`);
for (let i = 0; i < TASKS; i += 1000) {
  const r = await api('POST', `/api/repos/${REPO}/init`, GF_ADMIN_KEY, { tasks: ids.slice(i, i + 1000).map((id) => ({ id, title: id })), shards: SHARDS });
  if (r.status !== 200) throw new Error(`init: ${JSON.stringify(r.body)}`);
}
log(`init: ${TASKS} tasks on ${SHARDS} shards`);

// 2. Agents and their forks (once per agent).
const keys = [];
for (let i = 0; i < AGENTS; i++) {
  const r = await api('POST', '/api/agents', GF_ADMIN_KEY, { agentId: `load-${run}-${i}`, role: 'worker', modelFamily: 'claude' });
  keys.push(r.body.apiKey);
}
const tJoin = performance.now();
const joinErrors = {};
await pool(AGENTS, 10, async (i) => {
  const r = await api('POST', `/api/repos/${REPO}/join`, keys[i]);
  if (r.status !== 200) joinErrors[r.body.error ?? r.status] = (joinErrors[r.body.error ?? r.status] ?? 0) + 1;
});
const joinMs = performance.now() - tJoin;
log(`join: ${AGENTS} agents in ${Math.round(joinMs)} ms`, joinErrors);

// 3. Claims: every task once, agents round-robin, CONC in flight.
const lat = [];
const prov = [];
const errors = {};
const readTokens = new Set();
let ok = 0;
const t0 = performance.now();
await pool(TASKS, CONC, async (i) => {
  const r = await api('POST', `/api/repos/${REPO}/claim`, keys[i % AGENTS], { taskId: ids[i], leaseMs: 600_000 });
  if (r.status === 200) {
    ok++;
    lat.push(r.ms);
    prov.push(r.body.timingMs.provisioning);
    readTokens.add(r.body.main.readToken);
  } else errors[r.body.error ?? r.status] = (errors[r.body.error ?? r.status] ?? 0) + 1;
});
const wallMs = performance.now() - t0;
lat.sort((a, b) => a - b);
prov.sort((a, b) => a - b);
const report = {
  date: new Date().toISOString(),
  base: BASE,
  repo: REPO,
  tasks: TASKS,
  shards: SHARDS,
  agents: AGENTS,
  concurrency: CONC,
  join: { ms: Math.round(joinMs), errors: joinErrors },
  claims: {
    attempted: TASKS,
    granted: ok,
    errors,
    wallMs: Math.round(wallMs),
    perSec: Math.round((ok / wallMs) * 1000),
    clientLatencyMs: { p50: Math.round(pct(lat, 50)), p95: Math.round(pct(lat, 95)), p99: Math.round(pct(lat, 99)) },
    serverProvisioningMs: { p50: pct(prov, 50), p95: pct(prov, 95), p99: pct(prov, 99), max: prov.at(-1) ?? null },
    distinctMainReadTokens: readTokens.size,
  },
};
log(JSON.stringify(report.claims));
const text = JSON.stringify(report, null, 2);
if (OUT) fs.writeFileSync(OUT, text + '\n');
else console.log(text);
