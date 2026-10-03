#!/usr/bin/env node
// End-to-end run driven ONLY through the gf CLI against a native deployment (real git, real Artifacts).
//   GF_ADMIN_KEY=... node scripts/e2e-cli.mjs --base https://<staging> --repo <seeded tiny-lib repo>
// Uses a throwaway XDG_CONFIG_HOME so the operator's ~/.config/gf is never touched.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const arg = (n) => args[args.indexOf(`--${n}`) + 1];
const BASE = arg('base');
const REPO = arg('repo');
if (!BASE || !REPO || !process.env.GF_ADMIN_KEY) {
  console.error('usage: GF_ADMIN_KEY=... node scripts/e2e-cli.mjs --base <url> --repo <repo>');
  process.exit(2);
}
const GF = new URL('../cli/gf.mjs', import.meta.url).pathname;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-cli-e2e-'));
const run = Date.now().toString(36);
const checks = [];
const steps = [];

function gf(argv, { key, admin = false, cwd = work, json = true } = {}) {
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(work, 'config'), GF_BASE: BASE };
  if (!admin) delete env.GF_ADMIN_KEY;
  if (key) env.GF_KEY = key;
  const t0 = performance.now();
  const outText = execFileSync('node', [GF, ...argv, ...(json ? ['--json'] : [])], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  steps.push({ cmd: `gf ${argv.join(' ')}`.replace(REPO, '<repo>'), ms: Math.round(performance.now() - t0) });
  return json ? JSON.parse(outText) : outText;
}
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok) });
  if (!ok) {
    console.error(`FAIL: ${name} ${detail ? JSON.stringify(detail).slice(0, 600) : ''}`);
    process.exit(1);
  }
}

try {
  const tasks = path.join(work, 'tasks.json');
  fs.writeFileSync(tasks, JSON.stringify([{ id: 'C1', title: 'Add a slugify helper with tests' }]));
  const init = gf(['admin', 'repo', 'init', REPO, '--tasks', tasks, '--shards', '2'], { admin: true });
  check('admin repo init', init.tasks === 1, init);
  const worker = gf(['admin', 'agent', 'add', `cli-worker-${run}`, '--role', 'worker', '--family', 'claude'], { admin: true }).apiKey;
  const revA = gf(['admin', 'agent', 'add', `cli-rev-a-${run}`, '--role', 'reviewer', '--family', 'gpt-4o'], { admin: true }).apiKey;
  const revB = gf(['admin', 'agent', 'add', `cli-rev-b-${run}`, '--role', 'reviewer', '--family', 'gemini'], { admin: true }).apiKey;
  check('whoami', gf(['whoami'], { key: worker }).agentId === `cli-worker-${run}`);
  check('join', gf(['join', REPO], { key: worker }).fork.name.startsWith(REPO));
  check('tasks lists C1 as available', gf(['tasks', REPO]).some((t) => t.id === 'C1'));

  const claim = gf(['claim', REPO, 'C1', '--dir', 'c1'], { key: worker });
  const clone = path.join(work, 'c1');
  check('claim cloned main on the task branch', fs.existsSync(path.join(clone, 'src', 'math.mjs')) && execFileSync('git', ['branch', '--show-current'], { cwd: clone, encoding: 'utf8' }).trim() === claim.branch);
  check('no token in the clone config', !fs.readFileSync(path.join(clone, '.git', 'config'), 'utf8').includes('art_v'));
  check('token file is private', (fs.statSync(path.join(clone, '.git', 'gf', 'fork-token')).mode & 0o077) === 0);
  fs.writeFileSync(path.join(clone, 'src', 'slug.mjs'), "export const slugify = (s) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');\n");
  fs.writeFileSync(path.join(clone, 'test', 'slug.test.mjs'), "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { slugify } from '../src/slug.mjs';\ntest('slugify', () => assert.equal(slugify(' Hello, World! '), 'hello-world'));\n");
  check('heartbeat', gf(['heartbeat'], { key: worker, cwd: clone }).leaseExpiresAt > Date.now());
  const sub = gf(['submit', '-m', 'add slugify'], { key: worker, cwd: clone });
  check('submit: server-side diff, gates passed', sub.status === 'evaluating' && sub.changedFiles === 2, sub);

  const diff = gf(['diff', REPO, sub.patchId], { key: revA });
  check('diff shows the two new files', diff.patch.changes.map((c) => c.path).sort().join(',') === 'src/slug.mjs,test/slug.test.mjs', diff.patch.changes.map((c) => c.path));
  check('first review keeps it evaluating', gf(['review', REPO, sub.patchId, '95', '--reason', 'small and tested'], { key: revA }).status === 'evaluating');
  check('second family queues it', gf(['review', REPO, sub.patchId, '95'], { key: revB }).status === 'queued');

  const t0 = Date.now();
  let s;
  for (;;) {
    s = gf(['status', REPO]);
    const p = s.patches.find((x) => x.patchId === sub.patchId);
    if (p && p.status !== 'queued') break;
    if (Date.now() - t0 > 180_000) check('merge queue settles', false, s.queue);
    await new Promise((r) => setTimeout(r, 1000));
  }
  const p = s.patches.find((x) => x.patchId === sub.patchId);
  check('merged after the container tests passed', p.status === 'merged' && s.queue.testRuns >= 1, { status: p.status, mergeError: p.mergeError, queue: s.queue });
  const human = gf(['status', REPO], { json: false });
  check('human status renders', human.includes('merge queue:') && human.includes('C1'));
  console.log(JSON.stringify({ ok: true, repo: REPO, checks: checks.length, passed: checks.filter((c) => c.ok).length, mergedVia: p.mergedVia, testRuns: s.queue.testRuns, steps }, null, 2));
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
