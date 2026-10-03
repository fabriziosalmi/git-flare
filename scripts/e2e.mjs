#!/usr/bin/env node
// End-to-end run of the full agent workflow over HTTP. Exits non-zero on the first broken expectation.
//
//   mock (local):   npm run dev  &&  GF_ADMIN_KEY=... node scripts/e2e.mjs --base http://localhost:8787
//   native (real):  GF_ADMIN_KEY=... node scripts/e2e.mjs --base https://<staging-url> --native --repo <seeded-repo>
//
// In native mode the agent work is a real `git push` to its Artifacts fork, using the short-lived
// credentials returned by /claim (passed to git through environment variables, never argv or URLs), and
// main's final content is verified with `git clone`. Prints a JSON report (client timings and, where the
// API returns them, timings measured inside Cloudflare).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const BASE = arg('base', 'http://localhost:8787').replace(/\/$/, '');
const NATIVE = args.includes('--native');
const RACERS = Number(arg('racers', NATIVE ? '8' : '30'));
const QUEUE_K = Number(arg('queue', NATIVE ? '6' : '8'));
const SHARDS = Number(arg('shards', '4'));
const MIRRORS = Number(arg('mirrors', '0')); // read replicas of main
const PHASE = arg('phase', 'all'); // 'all' | 'tests' (project tests on the composed tree; needs a repo declaring them)
const ADMIN = process.env.GF_ADMIN_KEY;
if (!ADMIN) {
  console.error('GF_ADMIN_KEY is required');
  process.exit(2);
}
const run = Date.now().toString(36);
const REPO = arg('repo', `e2e-${run}`);
const report = { base: BASE, mode: NATIVE ? 'native' : 'mock', repo: REPO, shards: SHARDS, steps: [], checks: [] };

function check(name, cond, detail) {
  report.checks.push({ name, ok: Boolean(cond), ...(cond ? {} : { detail }) });
  if (!cond) {
    console.error(JSON.stringify(report, null, 2));
    console.error(`FAIL: ${name}${detail ? ` — ${JSON.stringify(detail).slice(0, 800)}` : ''}`);
    process.exit(1);
  }
}

async function api(method, p, key, body) {
  const t0 = performance.now();
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  const ms = Math.round(performance.now() - t0);
  report.steps.push({
    call: `${method} ${p.replace(REPO, '<repo>')}`,
    status: res.status,
    ms,
    ...(json.timingMs ? { serverMs: json.timingMs } : {}),
    ...(res.status >= 400 ? { error: json.error, detail: typeof json.detail === 'string' ? json.detail.replace(/[0-9a-f]{32}/g, '<acct>').slice(0, 300) : undefined } : {}),
  });
  return { status: res.status, body: json };
}

const agent = async (agentId, role, modelFamily) => {
  const r = await api('POST', '/api/agents', ADMIN, { agentId: `${agentId}-${run}`, role, modelFamily });
  check(`register ${agentId}`, r.status === 201, r.body);
  return r.body.apiKey;
};

function git(argv, opts = {}) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  if (opts.token) Object.assign(env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Bearer ${opts.token}` });
  return execFileSync('git', argv, { cwd: opts.cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function produceCommit(claim, key, taskId, files, message) {
  if (!NATIVE) {
    const r = await api('POST', `/api/repos/${REPO}/dev-commit`, key, { taskId, leaseEpoch: claim.leaseEpoch, files, message });
    check(`dev-commit ${taskId}`, r.status === 200, r.body);
    return r.body.commitSha;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-e2e-'));
  try {
    const t0 = performance.now();
    git(['clone', '--quiet', '--no-checkout', claim.main.remote, dir], { token: claim.main.readToken });
    git(['checkout', '--quiet', '-b', claim.branch, claim.baseCommit], { cwd: dir });
    for (const [p, c] of Object.entries(files)) {
      const abs = path.join(dir, p);
      if (c === null) fs.rmSync(abs, { force: true });
      else {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, c);
      }
    }
    git(['add', '-A'], { cwd: dir });
    git(['-c', 'user.name=gf-e2e-agent', '-c', 'user.email=agent@gf.invalid', 'commit', '--quiet', '-m', message], { cwd: dir });
    const sha = git(['rev-parse', 'HEAD'], { cwd: dir });
    git(['push', '--quiet', claim.fork.remote, `HEAD:refs/heads/${claim.branch}`], { cwd: dir, token: forkTokens.get(key) });
    report.steps.push({ call: `git clone(main) + commit + push(fork) ${taskId}`, ms: Math.round(performance.now() - t0) });
    if (taskId === 'T1') {
      let mainWriteDenied = false;
      try {
        git(['push', '--quiet', claim.main.remote, `HEAD:refs/heads/e2e-should-fail-${run}`], { cwd: dir, token: forkTokens.get(key) });
      } catch {
        mainWriteDenied = true;
      }
      check('fork token cannot push to main', mainWriteDenied);
    }
    return sha;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// /join returns the agent's write token for its own fork; claims carry only the shared read token for main.
const forkTokens = new Map();

async function worker(name, family) {
  const key = await agent(name, 'worker', family);
  const j = await api('POST', `/api/repos/${REPO}/join`, key);
  check(`join ${name} (fork + write token)`, j.status === 200 && typeof j.body.fork?.token === 'string', j.body);
  forkTokens.set(key, j.body.fork.token);
  return key;
}

async function work(key, taskId, files) {
  const c = await api('POST', `/api/repos/${REPO}/claim`, key, { taskId });
  check(`claim ${taskId}`, c.status === 200, c.body);
  const sha = await produceCommit(c.body, key, taskId, files, `work on ${taskId}`);
  const s = await api('POST', `/api/repos/${REPO}/submit`, key, { taskId, leaseEpoch: c.body.leaseEpoch, commitSha: sha });
  check(`submit ${taskId} (server-side diff, gates passed)`, s.status === 200 && s.body.status === 'evaluating', s.body);
  return { claim: c.body, sha, patchId: s.body.patchId, submit: s.body };
}

async function waitQueueEmpty(timeoutMs = 90_000) {
  const t0 = Date.now();
  for (;;) {
    const s = (await api('GET', `/api/repos/${REPO}/status`)).body;
    const queued = s.patches.filter((p) => p.status === 'queued').length;
    if (queued === 0 && s.queue.length === 0) return s;
    if (Date.now() - t0 > timeoutMs) check('merge queue drains in time', false, { queued, queue: s.queue });
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function mainFiles() {
  if (!NATIVE) {
    const r = await api('GET', `/api/repos/${REPO}/dev-main-files`, ADMIN);
    return r.body.files;
  }
  // Read main with a read token from a throwaway claim on the VERIFY task.
  const v = await api('POST', `/api/repos/${REPO}/claim`, globalThis.verifier, { taskId: 'VERIFY' });
  check('verification claim', v.status === 200, v.body);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-e2e-main-'));
  try {
    git(['clone', '--quiet', v.body.main.remote, dir], { token: v.body.main.readToken });
    const out = {};
    for (const f of git(['ls-files'], { cwd: dir }).split('\n').filter(Boolean)) out[f] = fs.readFileSync(path.join(dir, f), 'utf8');
    out.__head = git(['rev-parse', 'HEAD'], { cwd: dir });
    return out;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await api('POST', `/api/repos/${REPO}/release`, globalThis.verifier, { taskId: 'VERIFY', leaseEpoch: v.body.leaseEpoch });
  }
}

// ── phase "tests": project tests run on the composed tree before main moves ───────────────────────────
// Repo content: fixtures/tiny-lib (seeded by the caller in native mode, via dev-advance-main in mock mode).
if (PHASE === 'tests') {
  const fixture = new URL('../fixtures/tiny-lib/', import.meta.url).pathname;
  const health = await api('GET', '/api/health');
  check('health', health.status === 200 && health.body.mode === (NATIVE ? 'native' : 'mock'), health.body);
  const init = await api('POST', `/api/repos/${REPO}/init`, ADMIN, { tasks: ['S1', 'S2', 'S3', 'S4', 'VERIFY'].map((id) => ({ id, title: `task ${id}` })), shards: 2 });
  check('init', init.status === 200, init.body);
  if (!NATIVE) {
    const files = {};
    for (const f of ['src/math.mjs', 'test/math.test.mjs', '.gitflare/gates.json', 'README.md']) files[f] = fs.readFileSync(path.join(fixture, f), 'utf8');
    const seeded = await api('POST', `/api/repos/${REPO}/dev-advance-main`, ADMIN, { files, message: 'seed tiny-lib' });
    check('seed tiny-lib (mock)', seeded.status === 200, seeded.body);
  }
  const rA = await agent('t-reviewer-gpt', 'reviewer', 'gpt-4o');
  const rB = await agent('t-reviewer-gemini', 'reviewer', 'gemini');
  globalThis.verifier = await worker('t-verifier', 'claude');
  const changes = {
    S1: { 'src/str.mjs': 'export const shout = (s) => s.toUpperCase() + "!";\n', 'test/str.test.mjs': "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { shout } from '../src/str.mjs';\ntest('shout', () => assert.equal(shout('hi'), 'HI!'));\n" },
    S2: { 'src/clamp.mjs': 'export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));\n', 'test/clamp.test.mjs': "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { clamp } from '../src/clamp.mjs';\ntest('clamp', () => assert.equal(clamp(9, 0, 5), 5));\n" },
    // Breaks add() in a file no other patch touches: file-level conflict detection cannot see it, the tests can.
    // In mock mode the runner cannot execute JavaScript: the marker makes it fail the same patch.
    S3: { 'src/math.mjs': `export const add = (a, b) => a - b; // "optimized"${NATIVE ? '' : ' @gf-test-fail'}\nexport const mul = (a, b) => a * b;\n` },
    S4: { 'docs/NOTES.md': '# Notes\n\nMerged by the git-flare queue after tests passed.\n' },
  };
  const ws = {};
  for (const t of Object.keys(changes)) ws[t] = await worker(`t-worker-${t}`, t === 'S3' ? 'gemini' : 'claude');
  const subs = {};
  for (const t of Object.keys(changes)) subs[t] = await work(ws[t], t, changes[t]);
  await Promise.all(Object.values(subs).map((q) => api('POST', `/api/repos/${REPO}/attest`, rA, { patchId: q.patchId, confidencePercent: 95 })));
  const t0 = performance.now();
  const second = await Promise.all(Object.values(subs).map((q) => api('POST', `/api/repos/${REPO}/attest`, rB, { patchId: q.patchId, confidencePercent: 95 })));
  check('all four queued', second.every((r) => r.body.status === 'queued'), second.map((r) => r.body.status ?? r.body.error));
  const s = await waitQueueEmpty(300_000);
  report.steps.push({ call: 'approvals → queue settled (tests in container, bisection)', ms: Math.round(performance.now() - t0) });
  const by = Object.fromEntries(s.patches.map((p) => [p.taskId, p]));
  check('S1, S2, S4 merged', ['S1', 'S2', 'S4'].every((t) => by[t]?.status === 'merged'), ['S1', 'S2', 'S3', 'S4'].map((t) => `${t}:${by[t]?.status}`));
  check('S3 rejected by the project tests', by.S3?.status === 'rejected' && /^TESTS_FAILED/.test(by.S3.mergeError ?? ''), by.S3);
  if (NATIVE) check('real test log names the failing test', /add/.test(by.S3?.mergeError ?? '') && /not ok|fail/i.test(by.S3?.mergeError ?? ''), (by.S3?.mergeError ?? '').slice(-400));
  const files = await mainFiles();
  check('main has the merged files and the original add()', files['src/str.mjs'] && files['src/clamp.mjs'] && files['docs/NOTES.md'] && files['src/math.mjs'] === 'export const add = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\n', Object.keys(files));
  report.summary = {
    checks: report.checks.length,
    passed: report.checks.filter((c) => c.ok).length,
    testRunner: s.queue.testRunner,
    testRuns: s.queue.testRuns,
    testFailures: s.queue.testFailures,
    testRejections: s.queue.testRejections,
    testMsTotal: s.queue.testMs,
    pushes: s.queue.pushes,
    rounds: (s.queue.recent ?? []).slice().reverse().map((r) => ({ via: r.via, patches: r.patches.length, testPassed: r.test?.passed, testMs: r.test?.ms, roundMs: r.ms })),
    s3LogTail: (by.S3?.mergeError ?? '').slice(-600),
  };
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

// ── setup ───────────────────────────────────────────────────────────────────
const health = await api('GET', '/api/health');
check('health', health.status === 200 && health.body.mode === (NATIVE ? 'native' : 'mock'), health.body);
const queueTasks = Array.from({ length: QUEUE_K }, (_, i) => `Q${i + 1}`);
const tasks = ['T1', 'RACE', 'VERIFY', 'X1', 'X2', ...queueTasks].map((id) => ({ id, title: `task ${id}` }));
const init = await api('POST', `/api/repos/${REPO}/init`, ADMIN, { tasks, shards: SHARDS, ...(MIRRORS ? { mirrors: MIRRORS } : {}) });
check('init (sharded)', init.status === 200 && init.body.shards === SHARDS && init.body.tasks === tasks.length && (init.body.mirrors ?? 0) === MIRRORS, init.body);
const reviewerA = await agent('reviewer-gpt', 'reviewer', 'gpt-4o');
const reviewerB = await agent('reviewer-gemini', 'reviewer', 'gemini');
globalThis.verifier = await worker('verifier', 'claude');

// ── 1. single patch: claim → push → submit → 2 families → the queue lands its own commit of that tree ───
const w1 = await worker('worker-claude', 'claude');
const p1 = await work(w1, 'T1', { 'src/clamp.ts': 'export function clamp(x: number, lo: number, hi: number): number {\n  return Math.min(hi, Math.max(lo, x));\n}\n' });
const status1 = await api('GET', `/api/repos/${REPO}/status`);
check('claim carries no fork credential', p1.claim.fork.token === undefined, p1.claim.fork);
check('status carries no credential', !JSON.stringify(status1.body).includes(forkTokens.get(w1)) && !JSON.stringify(status1.body).includes(p1.claim.main.readToken));
const diff = await api('GET', `/api/repos/${REPO}/patches/${p1.patchId}/diff`, reviewerA);
check('reviewer reads the platform-computed diff', diff.status === 200 && diff.body.patch.changes[0].path === 'src/clamp.ts', diff.body);
const a1 = await api('POST', `/api/repos/${REPO}/attest`, reviewerA, { patchId: p1.patchId, confidencePercent: 95, reasoning: 'correct and minimal' });
check('one approval is not enough', a1.status === 200 && a1.body.status === 'evaluating', a1.body);
const a2 = await api('POST', `/api/repos/${REPO}/attest`, reviewerB, { patchId: p1.patchId, confidencePercent: 95 });
check('second family approval queues the patch', a2.status === 200 && a2.body.status === 'queued', a2.body);
const t0Merge = performance.now();
const s1 = await waitQueueEmpty();
report.steps.push({ call: 'approval → merged (client-observed, includes polling)', ms: Math.round(performance.now() - t0Merge) });
const t1 = s1.tasks.find((t) => t.id === 'T1');
const patch1 = s1.patches.find((p) => p.patchId === p1.patchId);
check("merged as the queue's own commit (the tested tree), never the agent's commit", t1.status === 'merged' && t1.mergedCommit !== p1.sha && patch1?.mergedVia === 'batch', { t1, mergedVia: patch1?.mergedVia });

// ── 2. concurrency on one task (real Durable Object) ────────────────────────
const racers = [];
for (let i = 0; i < RACERS; i++) racers.push(await agent(`racer${i}`, 'worker', `fam${i % 3}`));
await Promise.all(racers.map((k) => api('POST', `/api/repos/${REPO}/join`, k)));
const results = await Promise.all(racers.map((k) => api('POST', `/api/repos/${REPO}/claim`, k, { taskId: 'RACE' })));
check(`${RACERS} concurrent claims grant exactly one lease`, results.filter((r) => r.status === 200).length === 1, results.map((r) => r.body.error ?? 'OK'));

// ── 3. merge queue: K disjoint patches + one conflicting pair, all built on the same old main ──────────
const qWorkers = await Promise.all(queueTasks.map((t, i) => worker(`qworker${i}`, i % 2 ? 'claude' : 'gemini')));
const xWorkers = await Promise.all(['X1', 'X2'].map((t) => worker(`xworker-${t}`, 'claude')));
const queued = await Promise.all([
  ...queueTasks.map((t, i) => work(qWorkers[i], t, { [`queue/${t}.ts`]: `export const ${t} = ${i};\n` })),
  work(xWorkers[0], 'X1', { 'queue/shared.ts': 'export const owner = "X1";\n' }),
  work(xWorkers[1], 'X2', { 'queue/shared.ts': 'export const owner = "X2";\n' }),
]);
await Promise.all(queued.map((q) => api('POST', `/api/repos/${REPO}/attest`, reviewerA, { patchId: q.patchId, confidencePercent: 95 })));
const t0Queue = performance.now();
const second = await Promise.all(queued.map((q) => api('POST', `/api/repos/${REPO}/attest`, reviewerB, { patchId: q.patchId, confidencePercent: 95 })));
check('all queue patches approved into the queue', second.every((r) => r.status === 200 && r.body.status === 'queued'), second.map((r) => r.body.status ?? r.body.error));
const s3 = await waitQueueEmpty();
report.steps.push({ call: `queue: ${queued.length} approvals → all settled (client-observed)`, ms: Math.round(performance.now() - t0Queue) });
const byTask = Object.fromEntries(s3.patches.map((p) => [p.taskId, p]));
check('every disjoint patch merged', queueTasks.every((t) => byTask[t]?.status === 'merged'), queueTasks.map((t) => `${t}:${byTask[t]?.status}`));
const xs = [byTask.X1, byTask.X2];
check('exactly one of the conflicting pair merged, the other is a CONFLICT', xs.filter((p) => p.status === 'merged').length === 1 && xs.some((p) => p.status === 'stale' && /^CONFLICT/.test(p.mergeError)), xs.map((p) => `${p.taskId}:${p.status}:${p.mergeError ?? ''}`));
const mergedCount = queueTasks.length + 1;
check('batching: fewer pushes than merged patches', s3.queue.pushes - 1 < mergedCount, { pushes: s3.queue.pushes, merged: mergedCount, largestBatch: s3.queue.largestBatch });

// ── 4. main's content is what the queue claims ──────────────────────────────
const files = await mainFiles();
check('main contains every merged file with the submitted content', queueTasks.every((t, i) => files[`queue/${t}.ts`] === `export const ${t} = ${i};\n`) && files['src/clamp.ts']?.includes('clamp'), Object.keys(files));
const winner = xs.find((p) => p.status === 'merged').taskId;
check('shared file holds the winner of the conflict', files['queue/shared.ts'] === `export const owner = "${winner}";\n`, files['queue/shared.ts']);
check('pre-existing files are untouched', NATIVE ? Boolean(files['README.md']) : Boolean(files['README.md']), Object.keys(files).slice(0, 10));

// ── 5. read replicas follow main ────────────────────────────────────────────
let replicas;
if (MIRRORS) {
  const t0r = Date.now();
  for (;;) {
    replicas = (await api('GET', `/api/repos/${REPO}/status`)).body;
    if (replicas.mirrors?.every((m) => m.current) || Date.now() - t0r > 30_000) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const want = NATIVE ? files.__head : replicas.guard.expectedHead;
  check(`all ${MIRRORS} read replicas at main's head`, replicas.mirrors.length === MIRRORS && replicas.mirrors.every((m) => m.head === want), replicas.mirrors);
  check('claims read from a replica', Boolean(p1.claim.main.replica), p1.claim.main);
}

report.summary = {
  checks: report.checks.length,
  passed: report.checks.filter((c) => c.ok).length,
  shards: SHARDS,
  racers: RACERS,
  queue: { patches: queued.length, merged: mergedCount, conflicts: 1, pushes: s3.queue.pushes, batchCommits: s3.queue.batchCommits, fastForwards: s3.queue.fastForwards, largestBatch: s3.queue.largestBatch, rounds: s3.queue.rounds, recent: s3.queue.recent?.slice(0, 5).map((r) => ({ via: r.via, patches: r.patches.length, conflicts: r.conflicts.length, ms: r.ms })) },
  ...(MIRRORS ? { mirrors: { count: MIRRORS, syncs: replicas.queue.mirrorSyncs, lastSyncMs: replicas.queue.lastMirrorSyncMs } } : {}),
  claimServerProvisioningMs: p1.claim.timingMs?.provisioning,
  submitServerDiffMs: p1.submit.timingMs?.diffAndGates,
};
console.log(JSON.stringify(report, null, 2));
