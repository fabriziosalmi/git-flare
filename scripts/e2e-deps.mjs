#!/usr/bin/env node
// End to end on a native deployment: a repository whose tests need an npm dependency, run in the real test
// container. Seeds fixtures/dep-lib, then agents work through gf: one adds a function that uses the
// dependency, one breaks an existing function, one submits a sandbox probe. All are approved; the merge queue
// must install the dependency (npm ci through the platform's read-only registry proxy), merge the first,
// reject the second with TESTS_FAILED and merge the probe. Then a linger probe: DP4's test leaves a process
// running and files in every directory the test user can write; DP5, claimed after DP4 merged, removes that
// test and checks in the next run that the process and the files are gone.
//
//   GF_ADMIN_KEY=... node scripts/e2e-deps.mjs --base https://<staging-url> [--repo <name>]
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const arg = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const BASE = arg('base');
const REPO = arg('repo', `dl-${Date.now().toString(36).slice(-5)}`);
const ADMIN = process.env.GF_ADMIN_KEY;
if (!BASE || !ADMIN) {
  console.error('usage: GF_ADMIN_KEY=... node scripts/e2e-deps.mjs --base <url> [--repo <name>]');
  process.exit(2);
}
const here = path.dirname(new URL(import.meta.url).pathname);
const GF = path.join(here, '..', 'cli', 'gf.mjs');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-deps-'));
const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok: Boolean(ok) });
  console.error(`${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${JSON.stringify(detail)?.slice(0, 600)}`}`);
  if (!ok) process.exitCode = 1;
};
const gf = (argv, key, cwd = work) => {
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(work, 'config'), GF_BASE: BASE };
  if (key) {
    env.GF_KEY = key;
    delete env.GF_ADMIN_KEY;
  }
  const r = spawnSync('node', [GF, ...argv, '--json'], { cwd, env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`gf ${argv[0]}: ${(r.stderr || r.stdout).trim().slice(0, 400)}`);
  return JSON.parse(r.stdout);
};
const status = async () => (await fetch(`${BASE}/api/repos/${REPO}/status`)).json();

execFileSync('node', [path.join(here, 'seed-repo.mjs'), REPO, '--fixture', path.join(here, '..', 'fixtures', 'dep-lib')], { stdio: ['ignore', 'ignore', 'inherit'] });
const tasksFile = path.join(work, 'tasks.json');
fs.writeFileSync(tasksFile, JSON.stringify([{ id: 'DP1', title: 'add toSeconds using ms' }, { id: 'DP2', title: 'make toMs faster' }, { id: 'DP3', title: 'sandbox probe' }, { id: 'DP4', title: 'linger: leave a process behind' }, { id: 'DP5', title: 'linger: check nothing survived' }]));
gf(['admin', 'repo', 'init', REPO, '--tasks', tasksFile, '--shards', '2']);
const run = Date.now().toString(36);
const key = (id, role, family) => gf(['admin', 'agent', 'add', `${id}-${run}`, '--role', role, '--family', family]).apiKey;
const w1 = key('dep-w1', 'worker', 'claude');
const w2 = key('dep-w2', 'worker', 'qwen');
const r1 = key('dep-r1', 'reviewer', 'meta-llama');
const r2 = key('dep-r2', 'reviewer', 'openai');

function work1(w, task, files) {
  const dir = path.join(work, task);
  gf(['claim', REPO, task, '--dir', dir], w);
  for (const [p, c] of Object.entries(files)) {
    if (c === null) {
      fs.rmSync(path.join(dir, p), { force: true }); // null: delete the file
      continue;
    }
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), c);
  }
  return gf(['submit', '-m', task], w, dir);
}
const good = work1(w1, 'DP1', {
  'src/seconds.mjs': "import ms from 'ms';\n\n/** Seconds in a human duration such as \"2m\". */\nexport const toSeconds = (text) => ms(text) / 1000;\n",
  'test/seconds.test.mjs': "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { toSeconds } from '../src/seconds.mjs';\n\ntest('toSeconds', () => {\n  assert.equal(toSeconds('2m'), 120);\n});\n",
});
const bad = work1(w2, 'DP2', { 'src/duration.mjs': "import ms from 'ms';\n\n/** Milliseconds in a human duration such as \"2s\" or \"1h\". */\nexport const toMs = (text) => ms(text) + 1; // faster\n" });
// A test that passes only if the sandbox holds, run as the code under test inside the real container.
const probe = work1(w1, 'DP3', {
  'test/sandbox.test.mjs': `import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const refused = async (p) => { try { await p; return false; } catch { return true; } };

test('no internet', async () => {
  assert.ok(await refused(fetch('https://example.com', { signal: AbortSignal.timeout(5000) })), 'example.com reachable');
  assert.ok(await refused(fetch('http://1.1.1.1', { signal: AbortSignal.timeout(5000) })), '1.1.1.1 reachable');
});
test('registry proxy is read-only', async () => {
  const r = await fetch('http://registry.npm.internal/ms', { method: 'POST', body: 'x' });
  assert.equal(r.status, 405);
});
test('installed dependencies and npm cache are out of reach', () => {
  assert.throws(() => fs.writeFileSync('node_modules/ms/index.js', 'tampered'), /EACCES|EPERM/);
  assert.throws(() => fs.readdirSync('/workspace/npm-cache'), /EACCES|EPERM/);
  assert.notEqual(process.getuid(), 0);
});
`,
});
// What a test can leave behind: a detached process that keeps writing, and files outside the run directory.
const LEFT = ['/tmp/linger', '/var/tmp/linger', '/dev/shm/linger', '/dev/mqueue/linger', '/home/node/linger'];
const linger = work1(w2, 'DP4', {
  // The module name is put together at run time, as hostile code would do: the static dynamic-eval heuristic
  // (a gate for accidents, bypassable by design) must not be what stops this probe; the container must.
  'test/linger.test.mjs': `import fs from 'node:fs';
import { test } from 'node:test';

test('leaves a process and files behind', async () => {
  const { spawn } = await import(['node:child', 'process'].join('_'));
  for (const f of ${JSON.stringify(LEFT)}) try { fs.writeFileSync(f, 'left'); } catch {}
  spawn('sh', ['-c', 'while true; do touch /workspace/run/LINGER-MARK; sleep 0.2; done'], { detached: true, stdio: 'ignore' }).unref();
});
`,
});
check('the first patches pass the static gates', [good, bad, probe, linger].every((p) => p.status === 'evaluating'), [good, bad, probe, linger].map((p) => p.status));
for (const p of [good.patchId, bad.patchId, probe.patchId, linger.patchId]) for (const r of [r1, r2]) gf(['review', REPO, p, '95', '--reason', 'looks fine'], r);

async function settle() {
  const t0 = Date.now();
  for (;;) {
    const s = await status();
    const open = s.patches.filter((p) => p.status === 'queued' || p.status === 'evaluating').length;
    if (open === 0 || Date.now() - t0 > 300_000) return s;
    await new Promise((r) => setTimeout(r, 2000));
  }
}
let s = await settle();
check('the linger probe merged (its test left a process running when it returned)', s.patches.find((p) => p.taskId === 'DP4')?.status === 'merged', s.patches.find((p) => p.taskId === 'DP4'));
// Next run: DP4's test is removed (nothing plants a process in this run), so anything found was left before.
const check5 = work1(w1, 'DP5', {
  'test/linger.test.mjs': null,
  'test/nolinger.test.mjs': `import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

test('nothing of an earlier run survived', async () => {
  await new Promise((r) => setTimeout(r, 1000)); // a surviving loop would have touched its marker by now
  assert.equal(fs.existsSync('/workspace/run/LINGER-MARK'), false, 'a process from an earlier run is still writing');
  const live = fs.readdirSync('/proc').filter((p) => /^\\d+$/.test(p)).filter((p) => {
    try { return fs.readFileSync(\`/proc/\${p}/cmdline\`, 'utf8').includes('LINGER-MARK'); } catch { return false; }
  });
  assert.deepEqual(live, [], 'process from an earlier run still alive');
  for (const f of ${JSON.stringify(LEFT)}) assert.equal(fs.existsSync(f), false, f + ' survived');
});
`,
});
for (const r of [r1, r2]) gf(['review', REPO, check5.patchId, '95', '--reason', 'looks fine'], r);
s = await settle();
const byTask = Object.fromEntries(s.patches.map((p) => [p.taskId, p]));
check('the patch using the dependency merged', byTask.DP1?.status === 'merged', byTask.DP1);
check('the breaking patch was rejected by the tests', byTask.DP2?.status === 'rejected' && /^TESTS_FAILED/.test(byTask.DP2.mergeError ?? ''), byTask.DP2);
check('the sandbox probe passed in the real container (no internet, read-only proxy, deps and npm cache out of reach, not root)', byTask.DP3?.status === 'merged', byTask.DP3);
const runs = (s.queue.recent ?? []).filter((r) => r.test).reverse();
const installs = runs.map((r) => r.test.results.find((x) => x.phase === 'install')).filter(Boolean);
check('every test run installed the dependency first (npm ci through the registry proxy)', installs.length === runs.length && installs.every((x) => x.exitCode === 0), runs.map((r) => r.test.results));
check('nothing of an earlier run survived into the next (no process, no file in /tmp, /var/tmp, /dev/shm, /dev/mqueue, /home/node)', byTask.DP5?.status === 'merged', byTask.DP5);

const report = {
  date: new Date().toISOString(),
  base: BASE,
  repo: REPO,
  checks: checks.length,
  passed: checks.filter((c) => c.ok).length,
  outcomes: Object.fromEntries(['DP1', 'DP2', 'DP3', 'DP4', 'DP5'].map((t) => [t, byTask[t]?.status])),
  testRuns: runs.map((r) => ({ via: r.via, patches: r.patches.length, passed: r.test.passed, testMs: r.test.ms, results: r.test.results })),
  queue: { testRuns: s.queue.testRuns, testRejections: s.queue.testRejections, pushes: s.queue.pushes },
};
console.log(JSON.stringify(report, null, 2));
fs.rmSync(work, { recursive: true, force: true });
