// node --test scripts/review-latency.test.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tmpdir } from './lib/tmp.mjs';

const SCRIPT = path.join(path.dirname(new URL(import.meta.url).pathname), 'review-latency.mjs');

/** A repository with three committed branches (two small changes, one too long for a reviewer) and one task without a patch. */
function fixture() {
  const dir = tmpdir('rl-repo-');
  const g = (...x) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...x], { encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.py'), Array.from({ length: 30 }, (_, i) => `a_${i + 1} = ${i + 1}`).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'b.py'), 'b = 1\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'base');
  const base = g('rev-parse', 'HEAD').trim();
  const tip = (name, file, content) => {
    g('checkout', '-q', '-b', name, base);
    fs.writeFileSync(path.join(dir, file), content);
    g('commit', '-q', '-am', name);
    return g('rev-parse', 'HEAD').trim();
  };
  const t1 = tip('t1', 'a.py', fs.readFileSync(path.join(dir, 'a.py'), 'utf8').replace('a_5 = 5', 'a_5 = 50'));
  const t2 = tip('t2', 'b.py', 'b = 2\n');
  const t3 = tip('t3', 'b.py', Array.from({ length: 2000 }, (_, i) => `line_${i}_${'x'.repeat(20)} = ${i}`).join('\n') + '\n'); // far past 14,000 characters
  const tasks = path.join(tmpdir('rl-t-'), 'tasks.json');
  fs.writeFileSync(tasks, JSON.stringify({ base, tasks: ['t1', 't2', 't3', 't4'].map((id, i) => ({ id, issue: { number: i + 1, title: `fix ${id}` } })) }));
  const manifest = path.join(tmpdir('rl-m-'), 'manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({ base, tasks: [{ id: 't1', status: 'committed', sha: t1 }, { id: 't2', status: 'committed', sha: t2 }, { id: 't3', status: 'committed', sha: t3 }, { id: 't4', status: 'no-patch' }] }));
  return { dir, tasks, manifest };
}
const run = (fx, extra = []) => {
  const out = path.join(tmpdir('rl-o-'), 'latency.json');
  const stdout = execFileSync('node', [SCRIPT, '--repo', fx.dir, '--manifest', fx.manifest, '--tasks', fx.tasks, '--out', out, '--mock', ...extra], { encoding: 'utf8' });
  return { result: JSON.parse(fs.readFileSync(out, 'utf8')), stdout };
};

test('mock run: the three families are timed on each committed patch, the quorum is the second smallest latency, a too long change is skipped', () => {
  const { result, stdout } = run(fixture());
  assert.deepEqual(result.patches.map((p) => p.taskId), ['t1', 't2', 't3']); // t4 has no patch
  assert.match(result.patches[2].skipped, /14,000/);
  const [p1, p2] = result.patches;
  for (const p of [p1, p2]) {
    assert.deepEqual(Object.keys(p.latenciesMs), ['meta-llama', 'openai', 'mistral']);
    assert.equal(p.quorumMs, Object.values(p.latenciesMs).sort((a, b) => a - b)[1]);
    assert.ok(p.chars > 200 && p.chars < 14000);
  }
  assert.deepEqual(result.quorumMs, [p1.quorumMs, p2.quorumMs]);
  assert.equal(result.medianQuorumMs, (p1.quorumMs + p2.quorumMs) / 2);
  assert.match(result.measuredVia, /mock/);
  assert.deepEqual(result.models.map((m) => m.style), ['messages-json', 'responses', 'messages-guided']);
  assert.match(stdout, /2 patch\(es\) sampled/);
});

test('--max-patches limits how many patches are sampled', () => {
  const { result } = run(fixture(), ['--max-patches', '1']);
  assert.deepEqual(result.patches.map((p) => p.taskId), ['t1']);
  assert.equal(result.quorumMs.length, 1);
});

test('the diff the reviewers read is the change of the patch from the base commit: only its file, with the hunk', () => {
  const fx = fixture();
  // the script renders the change itself; check through a patch whose diff we know: t2 changes b.py from "b = 1" to "b = 2"
  const { result } = run(fx);
  const p2 = result.patches[1];
  assert.ok(p2.chars < 1500, `${p2.chars} characters for a one-line change`); // the prompt frame and one hunk, not the whole repository
});
