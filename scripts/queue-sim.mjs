#!/usr/bin/env node
// Queue-level simulation (issue #13): how often does the merge queue send a patch back as a conflict, as a function of
// the number of agents, the time an agent takes, the time reviewers take and how long the tests of a round last?
//
// It drives the real queue code (the registry Durable Object, claims, reviews, rounds, composed-tree test runs) of a
// local `npm run dev` (mock Artifacts, mock test runner) over HTTP; only Artifacts and the test runner are stand-ins.
// Agents are scripted: they claim a task, "work" (sleep), commit the files of the task's footprint through the
// mock-only dev-commit route, submit, wait for the two scripted reviewers (sleep, then two attestations), and wait for
// the queue's outcome. A patch sent back as a conflict is made again after a shorter "rebase" time, as the SPEC says
// (the agent re-claims and rebases), until it merges or --max-attempts is reached. The metrics come from the times the
// server records on every patch (claimedAt, submittedAt, queuedAt, closedAt: /status), not from the client's clock.
//
//   GF_ADMIN_KEY=... node scripts/queue-sim.mjs --agents 10 --tasks-per-agent 6 --work-ms 60000 --review-ms 15000 \
//        --rebase-ms 30000 --test-ms 30000 --footprints-from manifest.json [--footprint-kind human|agent] --out cell.json
//   GF_ADMIN_KEY=... node scripts/queue-sim.mjs --grid --agents-list 2,5,10 --test-list none,5000,30000 --reps 3 \
//        --parallel 4 --footprints-from manifest.json --out-dir results/   (resumable: finished cells are skipped)
//   GF_ADMIN_KEY=... node scripts/queue-sim.mjs --selftest        (a positive and a negative control; exits 1 if wrong)
//
// Times are in ms of simulated time; --scale multiplies the agent, review, rebase and test times (0.1 = ten times
// faster), while the queue's own latencies (a 150 ms batching window, merge round trips) do not scale: say which scale a
// result was run at. --test-ms none declares no tests; a number declares tests that last that long per round.
// Footprints: --footprints-from takes agent-replay manifests, --footprint-kind human (the files of the pull requests that
// closed the tasks), agent (the files the agent edited), or either with -nohot (without changelog, version and
// dependency files); or --zipf files=40,s=1,sizes=1,2,4 for synthetic ones.
import fs from 'node:fs';
import path from 'node:path';
import { empiricalSampler, footprintsOf, lognormalMs, rng, summarizeRun, zipfSampler } from './lib/sim.mjs';

const TERMINAL = new Set(['merged', 'rejected', 'stale', 'duplicate', 'expired']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── arguments ──────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const arg = (n, d) => (flag(n) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const num = (n, d) => Number(arg(n, String(d)));
const list = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);

const BASE = arg('base', 'http://localhost:8787').replace(/\/$/, '');
const ADMIN = process.env.GF_ADMIN_KEY;

function baseParams() {
  const testArg = arg('test-ms', 'none');
  return {
    agents: num('agents', 10),
    tasksPerAgent: num('tasks-per-agent', 6),
    workMs: num('work-ms', 60000),
    workCv: num('work-cv', 0.5),
    reviewMs: num('review-ms', 15000),
    rebaseMs: num('rebase-ms', 30000),
    testMs: testArg === 'none' ? null : Number(testArg),
    scale: num('scale', 1),
    seed: num('seed', 1),
    maxAttempts: num('max-attempts', 10),
    shards: num('shards', 4),
    pollMs: num('poll-ms', 250),
    footprintsFrom: list(arg('footprints-from', '')),
    footprintKind: arg('footprint-kind', 'human'),
    zipf: arg('zipf', ''),
    timeoutMs: num('timeout-ms', 3_600_000),
  };
}

function samplerFor(p, rand) {
  if (p.zipf) {
    const o = Object.fromEntries(p.zipf.split(/,(?=[a-z]+=)/).map((kv) => kv.split('=')));
    return zipfSampler(rand, { files: Number(o.files ?? 40), s: Number(o.s ?? 1), sizes: (o.sizes ?? '1').split(',').map(Number) });
  }
  const fps = footprintsOf(p.footprintsFrom.map((f) => JSON.parse(fs.readFileSync(f, 'utf8'))), p.footprintKind);
  return empiricalSampler(rand, fps);
}

// ─── the server ─────────────────────────────────────────────────────────────

async function api(method, p, key, body) {
  const res = await fetch(`${BASE}${p}`, { method, headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}
const must = (r, what, ok = [200, 201]) => {
  if (!ok.includes(r.status)) throw new Error(`${what}: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
  return r.body;
};

const BODY = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

// ─── one cell ───────────────────────────────────────────────────────────────

/** Runs one simulated queue and returns {params, summary, queue, patches}. */
export async function runCell(p, name) {
  const rand = rng(p.seed);
  const sample = samplerFor(p, rand);
  const total = p.agents * p.tasksPerAgent;
  const tasks = Array.from({ length: total }, (_, i) => ({ id: `T${i + 1}`, files: sample() }));
  const repo = `sim-${name}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 48);
  const sc = (ms) => ms * p.scale;
  const t0 = performance.now();

  must(await api('POST', `/api/repos/${repo}/init`, ADMIN, { tasks: tasks.map((t) => ({ id: t.id, title: `task ${t.id}` })), shards: p.shards }), 'init');
  const seed = { ...(p.testMs === null ? {} : { '.gitflare/gates.json': JSON.stringify({ test: { commands: ['node --test'], timeoutSec: 600 } }) }) };
  for (const t of tasks) for (const f of t.files) seed[f] = BODY;
  must(await api('POST', `/api/repos/${repo}/dev-advance-main`, ADMIN, { files: seed, message: 'seed' }), 'seed');
  if (p.testMs !== null) must(await api('POST', `/api/repos/${repo}/dev-configure`, ADMIN, { testMs: Math.round(sc(p.testMs)) }), 'dev-configure');

  const register = async (id, role, family) => must(await api('POST', '/api/agents', ADMIN, { agentId: id, role, modelFamily: family }), `register ${id}`).apiKey;
  const reviewers = [await register(`${name}-rev-a`, 'reviewer', 'gpt-4o'), await register(`${name}-rev-b`, 'reviewer', 'gemini')];
  const families = ['claude', 'mistral', 'meta-llama', 'qwen'];
  const workers = [];
  for (let i = 0; i < p.agents; i++) {
    const key = await register(`${name}-w${i + 1}`, 'worker', families[i % families.length]);
    must(await api('POST', `/api/repos/${repo}/join`, key), `join w${i + 1}`);
    workers.push(key);
  }

  // One poller reads /status for everybody: it keeps the Durable Objects of the mock alive, collects every patch as it
  // closes (the status keeps only the latest 100) and wakes the agents waiting for an outcome.
  const seen = new Map();
  const waiters = new Map();
  let lastQueue = null;
  let polling = true;
  const poll = async () => {
    const s = await api('GET', `/api/repos/${repo}/status`);
    if (s.status !== 200) return;
    lastQueue = s.body.queue;
    for (const x of s.body.patches ?? []) {
      seen.set(x.patchId, x);
      if (TERMINAL.has(x.status) && waiters.has(x.patchId)) for (const r of waiters.get(x.patchId).splice(0)) r(x);
    }
  };
  const poller = (async () => {
    while (polling) {
      await poll();
      await sleep(p.pollMs);
    }
  })();
  const outcome = (patchId) => {
    const x = seen.get(patchId);
    if (x && TERMINAL.has(x.status)) return Promise.resolve(x);
    return new Promise((resolve) => waiters.set(patchId, [...(waiters.get(patchId) ?? []), resolve]));
  };

  const pool = [...tasks];
  const submissions = []; // {patchId, taskId, attempt}
  const gaveUp = [];
  const workRand = rng(p.seed + 1000);
  const agentLoop = async (key) => {
    for (;;) {
      const task = pool.shift();
      if (!task) return;
      for (let attempt = 1; ; attempt++) {
        const c = must(await api('POST', `/api/repos/${repo}/claim`, key, { taskId: task.id }), `claim ${task.id}`);
        await sleep(sc(lognormalMs(workRand, attempt === 1 ? p.workMs : p.rebaseMs, p.workCv)));
        const files = Object.fromEntries(task.files.map((f) => [f, `// ${task.id} attempt ${attempt}\n${BODY}`]));
        const commit = must(await api('POST', `/api/repos/${repo}/dev-commit`, key, { taskId: task.id, leaseEpoch: c.leaseEpoch, files, message: `${task.id} attempt ${attempt}`, rebase: attempt > 1 }), `dev-commit ${task.id}`);
        const sub = must(await api('POST', `/api/repos/${repo}/submit`, key, { taskId: task.id, leaseEpoch: c.leaseEpoch, commitSha: commit.commitSha }), `submit ${task.id}`);
        submissions.push({ patchId: sub.patchId, taskId: task.id, attempt });
        await sleep(sc(p.reviewMs));
        for (const r of reviewers) must(await api('POST', `/api/repos/${repo}/attest`, r, { patchId: sub.patchId, confidencePercent: 95 }), `attest ${sub.patchId}`);
        const out = await outcome(sub.patchId);
        if (out.status === 'merged') break;
        if (attempt >= p.maxAttempts) {
          gaveUp.push(task.id);
          break;
        }
      }
    }
  };

  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`cell ${name} did not finish within ${p.timeoutMs} ms`)), p.timeoutMs);
  });
  try {
    await Promise.race([Promise.all(workers.map(agentLoop)), deadline]);
    await poll();
  } finally {
    clearTimeout(timer); // otherwise the process would stay alive until the limit
    polling = false;
    await poller;
  }
  const wallMs = performance.now() - t0;
  const patches = submissions.map((s) => {
    const x = seen.get(s.patchId) ?? {};
    return { patchId: s.patchId, taskId: s.taskId, attempt: s.attempt, status: x.status ?? 'unknown', claimedAt: x.claimedAt, submittedAt: x.submittedAt, queuedAt: x.queuedAt, closedAt: x.closedAt, ...(x.mergeError ? { mergeError: String(x.mergeError).slice(0, 120) } : {}) };
  });
  // the mock keeps nothing after its Durable Objects are evicted, but delete the repository anyway (as `gf admin repo delete` does)
  for (let i = 0; i < 20; i++) {
    const d = await api('DELETE', `/api/repos/${repo}`, ADMIN);
    if (d.status !== 200 || d.body.done) break;
  }
  return { params: { ...p, footprintFiles: undefined }, name, summary: { ...summarizeRun({ patches, wallMs }), tasksGivenUp: gaveUp.length }, queue: lastQueue, patches };
}

// ─── grid and self-test ─────────────────────────────────────────────────────

async function pool(items, k, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(k, items.length) }, async () => {
    for (;;) {
      const my = i++;
      if (my >= items.length) return;
      out[my] = await fn(items[my], my);
    }
  }));
  return out;
}

async function gridMode() {
  const dir = arg('out-dir');
  if (!dir) throw new Error('--out-dir is required with --grid');
  fs.mkdirSync(dir, { recursive: true });
  const base = baseParams();
  const cells = [];
  for (const agents of list(arg('agents-list', String(base.agents))).map(Number)) {
    for (const t of list(arg('test-list', base.testMs === null ? 'none' : String(base.testMs)))) {
      for (let rep = 0; rep < num('reps', 3); rep++) cells.push({ ...base, agents, testMs: t === 'none' ? null : Number(t), seed: base.seed + rep, rep });
    }
  }
  const run = Date.now().toString(36);
  const rows = await pool(cells, num('parallel', 2), async (c, i) => {
    const id = `n${c.agents}-t${c.testMs ?? 'none'}-r${c.rep}`;
    const file = path.join(dir, `${id}.json`);
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
    const r = await runCell(c, `${run}-${i}`);
    fs.writeFileSync(file, `${JSON.stringify(r)}\n`);
    console.log(`${id.padEnd(22)} rejection ${r.summary.rejectionPerSubmissionPct}% (first attempts ${r.summary.firstAttemptRejectionPct}%), W p50 ${Math.round(r.summary.windowMs.p50 / 1000)} s, landings/window ${r.summary.landingsPerWindow.mean}`);
    return r;
  });
  fs.writeFileSync(path.join(dir, 'grid.json'), `${JSON.stringify(rows.map((r) => ({ params: r.params, summary: r.summary })), null, 2)}\n`);
}

/** A positive and a negative control: every task on one file must conflict, tasks on distinct files must not. */
async function selftest() {
  const common = { ...baseParams(), agents: 4, tasksPerAgent: 3, workMs: 200, workCv: 0, reviewMs: 100, rebaseMs: 100, testMs: null, scale: 1, maxAttempts: 100, timeoutMs: 120_000 }; // a task may lose many times in a row on one file: do not let the control depend on luck
  const same = await runCell({ ...common, footprintsFrom: [], zipf: 'files=1,s=0,sizes=1' }, `st-same-${Date.now().toString(36)}`);
  const apart = await runCell({ ...common, footprintsFrom: [], zipf: 'files=500,s=0,sizes=1' }, `st-apart-${Date.now().toString(36)}`);
  const timed = [same, apart].every((r) => r.summary.windowMs.p50 > 0 && r.summary.partsMs.work > 0 && r.summary.landingsPerWindow.mean !== null); // the server's times arrived
  const ok = same.summary.stale > 0 && same.summary.merged === 12 && apart.summary.stale === 0 && apart.summary.merged === 12 && timed && same.summary.maxAttempts > 1 && apart.summary.maxAttempts === 1;
  console.log(`positive control (12 tasks, one file): ${same.summary.merged} merged, ${same.summary.stale} stale, max attempts ${same.summary.maxAttempts}`);
  console.log(`negative control (12 tasks, 500 files): ${apart.summary.merged} merged, ${apart.summary.stale} stale`);
  console.log(`server times present: ${timed}`);
  console.log(ok ? 'selftest: ok' : 'selftest: WRONG');
  process.exit(ok ? 0 : 1);
}

// ─── main ───────────────────────────────────────────────────────────────────

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  if (!ADMIN) {
    console.error('GF_ADMIN_KEY is required (the ADMIN_KEY of the local server)');
    process.exit(2);
  }
  if (flag('selftest')) await selftest();
  else if (flag('grid')) await gridMode();
  else {
    const p = baseParams();
    if (!p.zipf && p.footprintsFrom.length === 0) {
      console.error('give --footprints-from <manifest.json> or --zipf files=40,s=1,sizes=1');
      process.exit(2);
    }
    const r = await runCell(p, Date.now().toString(36));
    if (arg('out')) fs.writeFileSync(arg('out'), `${JSON.stringify(r, null, 2)}\n`);
    console.log(JSON.stringify(r.summary, null, 2));
  }
}
