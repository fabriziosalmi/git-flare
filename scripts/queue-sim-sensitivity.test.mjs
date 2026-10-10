// The sensitivity driver: the commands it would run, and the refusals.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const script = path.join(path.dirname(new URL(import.meta.url).pathname), 'queue-sim-sensitivity.mjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-sens-'));
const times = path.join(dir, 'times.json');
fs.writeFileSync(times, JSON.stringify({ workMs: 10000, workCv: 0.4, reviewMs: 2000, rebaseMs: 7000, source: 'a test of the driver, not data' }));
const fp = path.join(dir, 'fp');
fs.mkdirSync(fp);
for (const r of ['click', 'hono', 'axios', 'prettier', 'eslint', 'vite', 'svelte', 'cli']) fs.writeFileSync(path.join(fp, `${r}-tasks.json`), '{"tasks":[]}');
const dist = path.join(dir, 'dist');
fs.mkdirSync(dist);
for (const r of ['click', 'hono', 'axios', 'prettier', 'eslint', 'vite', 'svelte', 'cli']) fs.writeFileSync(path.join(dist, `${r}-tasks.json`), '{"tasks":[]}');
const agentFile = path.join(dir, 'agent.json');
fs.writeFileSync(agentFile, '{"tasks":[]}');
const run = (...extra) => spawnSync('node', [script, '--times', times, '--footprints-dir', fp, '--out-dir', path.join(dir, 'out'), '--agent-manifests', `click=${agentFile};hono=${agentFile}`, '--distinct-dir', dist, '--dry-run', ...extra], { encoding: 'utf8' });

test('dry run: one command per condition and repository, each with its one change', () => {
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 8 + 2 + 2 * 3 + 5 * 2 + 8 + 3);
  const by = (c) => lines.filter((l) => l.startsWith(c.padEnd(15)));
  assert.ok(by('human-nohot').every((l) => l.includes('--footprint-kind human-nohot') && !l.includes('--no-replacement')));
  assert.ok(by('work-x6').every((l) => l.includes('--work-ms 60000')), 'work x6 of 10000 ms');
  assert.ok(by('work-x0.5').every((l) => l.includes('--work-ms 5000')));
  assert.ok(by('wave-noreplace').every((l) => l.includes('--no-replacement') && l.includes('--tasks-per-agent 1')));
  assert.ok(by('wave-replace').every((l) => !l.includes('--no-replacement') && l.includes('--tasks-per-agent 1')), 'the control differs only by the replacement');
  assert.ok(by('agent').every((l) => l.includes('--footprint-kind agent') && l.includes(agentFile)));
  const d60 = by('distinct60').filter((l) => !l.startsWith('distinct60-'));
  assert.ok(d60.length === 8 && d60.every((l) => l.includes('--no-replacement') && l.includes(dist) && !l.includes('--tasks-per-agent')), 'distinct60: the distinct population, no replacement, the six waves of G1');
  assert.ok(by('distinct60-replace').length === 3 && by('distinct60-replace').every((l) => !l.includes('--no-replacement') && l.includes(dist)), 'the control: same population, with replacement');
  assert.ok(lines.every((l) => l.includes('--scale 0.25') && l.includes('--reps 3') && l.includes('--test-list 30000') && l.includes('--agents-list 10')));
});

test('--only picks one condition; an unknown one, a missing manifest and a bad times file are refused', () => {
  assert.equal(run('--only', 'agent').stdout.trim().split('\n').length, 2);
  assert.equal(run('--only', 'agent,work-x2').stdout.trim().split('\n').length, 4, 'a list of conditions');
  assert.notEqual(run('--only', 'agent,nope').status, 0);
  assert.notEqual(run('--only', 'nope').status, 0);
  const noAgents = spawnSync('node', [script, '--times', times, '--footprints-dir', fp, '--out-dir', dir, '--only', 'agent', '--dry-run'], { encoding: 'utf8' });
  assert.notEqual(noAgents.status, 0);
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, '{"workMs":0,"reviewMs":1,"rebaseMs":1,"workCv":0}');
  assert.notEqual(spawnSync('node', [script, '--times', bad, '--footprints-dir', fp, '--out-dir', dir, '--dry-run'], { encoding: 'utf8' }).status, 0);
});
