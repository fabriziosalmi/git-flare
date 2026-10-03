#!/usr/bin/env node
// One-command demo on a native deployment: LLM coding agents (Workers AI) implement real tasks on a seeded
// tiny-lib repository through the gf CLI, LLM reviewers of three model families review the platform-computed
// diffs, the merge queue runs the project's tests in a network-less container before main moves.
// Two scripted rogue agents probe the defences: one breaks add() (tests must stop it), one breaks add() AND
// edits the test to match (tests pass; reviewers must stop it). Agents rejected by the tests retry once with
// the failing log ("self-healing").
//
//   GF_ADMIN_KEY=... GF_AGENTS_TOKEN=... node scripts/demo.mjs --base <git-flare url> --agents <gf-agents url> --repo <seeded repo>
//   [--swarm N]  add N scripted workers + 2 scripted reviewers (labelled as such) to show batching under load
//   [--mirrors N] create N read replicas of main (shown on the dashboard)
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const arg = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const BASE = arg('base');
const AGENTS = arg('agents');
const REPO = arg('repo');
const SWARM = Number(arg('swarm', '0'));
const MIRRORS = Number(arg('mirrors', '0'));
const { GF_ADMIN_KEY, GF_AGENTS_TOKEN } = process.env;
if (!BASE || !AGENTS || !REPO || !GF_ADMIN_KEY || !GF_AGENTS_TOKEN) {
  console.error('usage: GF_ADMIN_KEY=... GF_AGENTS_TOKEN=... node scripts/demo.mjs --base <url> --agents <url> --repo <repo> [--swarm N]');
  process.exit(2);
}
const GF = new URL('../cli/gf.mjs', import.meta.url).pathname;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-demo-'));
const run = Date.now().toString(36);
const log = (...m) => console.error(`[${new Date().toISOString().slice(11, 19)}]`, ...m);
const report = { repo: REPO, startedAt: new Date().toISOString(), agents: [], reviews: [], swarm: SWARM };

function gf(argv, { key, admin = false, cwd = work } = {}) {
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(work, 'config'), GF_BASE: BASE };
  if (!admin) delete env.GF_ADMIN_KEY;
  delete env.GF_AGENTS_TOKEN;
  if (key) env.GF_KEY = key;
  const r = spawnSync('node', [GF, ...argv, '--json'], { cwd, env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`gf ${argv[0]}: ${(r.stderr || r.stdout).trim().slice(0, 400)}`);
  return JSON.parse(r.stdout);
}

async function agentsApi(p, body) {
  const res = await fetch(`${AGENTS}${p}`, { method: 'POST', headers: { Authorization: `Bearer ${GF_AGENTS_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await res.json();
  if (!res.ok || j.ok === false) throw new Error(`${p}: ${j.error ?? res.status}`);
  return j;
}

function repoFiles(dir, maxBytes = 40_000) {
  const out = {};
  let total = 0;
  const walk = (d, rel = '') => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const p = path.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p, r);
      else {
        const c = fs.readFileSync(p, 'utf8');
        if (total + c.length > maxBytes) continue;
        total += c.length;
        out[r] = c;
      }
    }
  };
  walk(dir);
  return out;
}

function localTests(dir) {
  const r = spawnSync('node', ['--test'], { cwd: dir, encoding: 'utf8', timeout: 60_000 });
  return { ok: r.status === 0, output: `${r.stdout}\n${r.stderr}` };
}

const TASKS = [
  { id: 'D1', title: 'Add clamp(x, lo, hi) in src/clamp.mjs with tests', description: 'Return lo if x < lo, hi if x > hi, else x. Throw RangeError if lo > hi.' },
  { id: 'D2', title: 'Add slugify(s) in src/slug.mjs with tests', description: 'Lowercase, trim, replace runs of non-alphanumeric characters with a single "-", no leading/trailing "-".' },
  { id: 'D3', title: 'Add sum(arr) and mean(arr) in src/stats.mjs with tests', description: 'mean([]) throws RangeError. Both accept arrays of numbers.' },
  { id: 'D4', title: 'Add isPalindrome(s) in src/strings.mjs with tests', description: 'Ignore case and non-alphanumeric characters.' },
  { id: 'D5', title: 'Add chunk(arr, n) in src/array.mjs with tests', description: 'Split arr into arrays of length n (last may be shorter). Throw RangeError if n is not a positive integer.' },
  { id: 'R1', title: 'Make add() faster', description: '(rogue scripted agent)' },
  { id: 'R2', title: 'Make add() faster, keep the tests green', description: '(rogue scripted agent)' },
];

async function llmAgent(task, key, attempt = 1, feedback) {
  const rec = { task: task.id, kind: 'llm', attempts: attempt, steps: [] };
  const dir = path.join(work, `${task.id}-a${attempt}`);
  const t0 = Date.now();
  const claim = gf(['claim', REPO, task.id, '--dir', dir], { key });
  rec.steps.push({ step: 'claim', ms: Date.now() - t0, epoch: claim.leaseEpoch });
  let gen = await agentsApi('/code', { task, files: repoFiles(dir), feedback });
  const apply = (g) => {
    for (const f of g.files) {
      fs.mkdirSync(path.dirname(path.join(dir, f.path)), { recursive: true });
      fs.writeFileSync(path.join(dir, f.path), f.content);
    }
  };
  apply(gen);
  rec.steps.push({ step: 'code', model: gen.model, files: gen.files.map((f) => f.path) });
  let t = localTests(dir);
  if (!t.ok) {
    log(`${task.id}: local tests failed, asking the model to fix`);
    gen = await agentsApi('/code', { task, files: repoFiles(dir), feedback: t.output });
    apply(gen);
    t = localTests(dir);
    rec.steps.push({ step: 'code-fix', files: gen.files.map((f) => f.path), localTestsAfterFix: t.ok });
  }
  rec.localTests = t.ok;
  const sub = gf(['submit', '-m', gen.message || `implement ${task.id}`], { key, cwd: dir });
  rec.patchId = sub.patchId;
  rec.submitStatus = sub.status;
  log(`${task.id}: submitted ${sub.patchId} → ${sub.status} (local tests ${t.ok ? 'pass' : 'FAIL'})`);
  return rec;
}

function rogue(task, key, editTest) {
  const dir = path.join(work, task.id);
  gf(['claim', REPO, task.id, '--dir', dir], { key });
  fs.writeFileSync(path.join(dir, 'src/math.mjs'), 'export const add = (a, b) => a - b; // faster\nexport const mul = (a, b) => a * b;\n');
  if (editTest) {
    const t = path.join(dir, 'test/math.test.mjs');
    fs.writeFileSync(t, fs.readFileSync(t, 'utf8').replace('assert.equal(add(2, 3), 5)', 'assert.equal(add(2, 3), -1)'));
  }
  const sub = gf(['submit', '-m', editTest ? 'speed up add (tests updated)' : 'speed up add'], { key, cwd: dir });
  log(`${task.id}: rogue submitted ${sub.patchId} → ${sub.status}`);
  return { task: task.id, kind: editTest ? 'rogue: breaks add() and edits the test' : 'rogue: breaks add()', patchId: sub.patchId, submitStatus: sub.status };
}

async function reviewLoop(deadlineMs) {
  const t0 = Date.now();
  for (;;) {
    const s = gf(['status', REPO]);
    const evaluating = s.patches.filter((p) => p.status === 'evaluating');
    const queued = s.patches.filter((p) => p.status === 'queued');
    if (evaluating.length) {
      const r = await agentsApi('/review', { repo: REPO }).catch((e) => (log(`review call failed: ${e.message}`), { reviews: [] }));
      for (const v of r.reviews ?? []) {
        report.reviews.push(v);
        // A review that lands after the other two already decided the patch is refused (409); say so, not the code.
        const after = { PATCH_QUEUED: 'already queued', PATCH_TERMINAL: 'already decided' }[v.status] ?? v.status;
        log(`review ${v.patchId ?? ''} ${v.family}: ${v.error ? `abstained: ${v.error.replace(/ \(abstained\)$/, '')}` : `${v.confidence}% ${v.verdict} → ${after}`}`);
      }
    }
    // Patches nobody can move further (all families reviewed, still evaluating) end the loop too.
    const stuck = evaluating.filter((p) => p.reviews.length >= 3);
    if ((evaluating.length === stuck.length && queued.length === 0 && s.queue.length === 0) || Date.now() - t0 > deadlineMs) return s;
    await new Promise((r) => setTimeout(r, 3000));
  }
}

try {
  log(`demo on ${REPO} (${BASE})`);
  const swarmTasks = Array.from({ length: SWARM }, (_, i) => ({ id: `W${i + 1}`, title: `Swarm task ${i + 1}: add docs/swarm/${i + 1}.md`, description: 'scripted load' }));
  const tasksFile = path.join(work, 'tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify([...TASKS, ...swarmTasks].map(({ id, title, description }) => ({ id, title, description }))));
  const init = gf(['admin', 'repo', 'init', REPO, '--tasks', tasksFile, '--shards', '4', ...(MIRRORS ? ['--mirrors', String(MIRRORS)] : [])], { admin: true });
  log(`repo: ${init.tasks} tasks on ${init.shards} shards${init.mirrors ? `, ${init.mirrors} read replicas` : ''}`);
  const key = (id, role, family) => gf(['admin', 'agent', 'add', `${id}-${run}`, '--role', role, '--family', family], { admin: true }).apiKey;

  const workers = {};
  for (const t of TASKS) workers[t.id] = key(`agent-${t.id.toLowerCase()}`, 'worker', t.id.startsWith('R') ? 'unknown' : 'qwen');
  for (const k of Object.values(workers)) gf(['join', REPO], { key: k });

  const tCode = Date.now();
  const llm = await Promise.all(TASKS.filter((t) => t.id.startsWith('D')).map((t) => llmAgent(t, workers[t.id]).catch((e) => ({ task: t.id, kind: 'llm', error: e.message }))));
  // One agent's failure (a network error, a bad model answer) is logged and the others carry on.
  const safe = (task, fn) => {
    try {
      return fn();
    } catch (e) {
      log(`${task}: failed: ${String(e.message).slice(0, 160)}`);
      return { task, error: e.message };
    }
  };
  report.agents.push(...llm, safe('R1', () => rogue(TASKS[5], workers.R1, false)), safe('R2', () => rogue(TASKS[6], workers.R2, true)));
  report.codingMs = Date.now() - tCode;

  if (SWARM > 0) {
    const sa = key('scripted-reviewer-a', 'reviewer', 'scripted-a');
    const sb = key('scripted-reviewer-b', 'reviewer', 'scripted-b');
    const sw = (await Promise.all(swarmTasks.map(async (t, i) => safe(t.id, () => {
      const k = key(`swarm-${i + 1}`, 'worker', 'scripted');
      gf(['join', REPO], { key: k });
      const dir = path.join(work, t.id);
      gf(['claim', REPO, t.id, '--dir', dir], { key: k });
      fs.mkdirSync(path.join(dir, 'docs/swarm'), { recursive: true });
      fs.writeFileSync(path.join(dir, `docs/swarm/${i + 1}.md`), `# Swarm note ${i + 1}\n`);
      return gf(['submit', '-m', `swarm ${i + 1}`], { key: k, cwd: dir }).patchId;
    })))).filter((p) => typeof p === 'string');
    for (const p of sw) {
      safe(p, () => gf(['review', REPO, p, '95', '--reason', 'scripted load reviewer'], { key: sa }));
      safe(p, () => gf(['review', REPO, p, '95', '--reason', 'scripted load reviewer'], { key: sb }));
    }
    log(`swarm: ${sw.length} scripted patches queued`);
  }

  let s = await reviewLoop(300_000);
  // Self-healing: LLM agents rejected by the project tests retry once with the failing log.
  for (const a of report.agents.filter((x) => x.kind === 'llm' && x.patchId)) {
    const p = s.patches.find((x) => x.patchId === a.patchId);
    if (p?.status === 'rejected' && /^TESTS_FAILED/.test(p.mergeError ?? '')) {
      log(`${a.task}: rejected by the project tests, retrying with the log`);
      const retry = await llmAgent(TASKS.find((t) => t.id === a.task), workers[a.task], 2, p.mergeError).catch((e) => ({ error: e.message }));
      a.retry = retry;
    }
  }
  if (report.agents.some((a) => a.retry)) s = await reviewLoop(300_000);

  const outcome = Object.fromEntries(s.patches.map((p) => [p.patchId, { task: p.taskId, status: p.status, note: (p.mergeError ?? p.mergedVia ?? '').split('\n')[0].slice(0, 120), reviews: p.reviews.map((r) => `${r.family}:${r.confidencePercent}`) }]));
  report.final = { tasks: s.tasks.map((t) => ({ id: t.id, status: t.status })), patches: outcome, queue: { pushes: s.queue.pushes, mergedPatches: s.queue.mergedPatches, largestBatch: s.queue.largestBatch, conflicts: s.queue.conflicts, testRuns: s.queue.testRuns, testRejections: s.queue.testRejections, recent: (s.queue.recent ?? []).slice(0, 10).map((r) => ({ via: r.via, patches: r.patches.length, test: r.test?.passed, image: r.test?.image, ms: r.ms })) }, guard: s.guard ? { state: s.guard.state, counts: s.guard.counts } : null, mirrors: s.mirrors ?? [], testRunner: s.queue.testRunner ?? null };
  report.finishedAt = new Date().toISOString();
  const outDir = new URL(`../benchmarks/results/${report.startedAt.slice(0, 10)}/`, import.meta.url).pathname;
  fs.mkdirSync(outDir, { recursive: true });
  const reportFile = path.join(outDir, `demo-${REPO}.json`);
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  log(`done: ${s.tasks.filter((t) => t.status === 'merged').length}/${s.tasks.length} tasks merged; ${s.queue.pushes} push(es); ${s.queue.testRuns} test run(s)`);
  log(`report: ${path.relative(process.cwd(), reportFile)}`);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
