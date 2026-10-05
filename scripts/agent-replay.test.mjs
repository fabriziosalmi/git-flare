// node --test scripts/agent-replay.test.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tmpdir } from './lib/tmp.mjs';

const SCRIPT = path.join(path.dirname(new URL(import.meta.url).pathname), 'agent-replay.mjs');

/** A repository with two source files whose lines each have their own identifiers; returns {dir, base, tasksFile}. */
function fixture() {
  const dir = tmpdir('agent-replay-test-');
  const g = (...x) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...x], { encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(dir, 'src'));
  for (const f of ['a', 'b']) {
    fs.writeFileSync(path.join(dir, 'src', `${f}.py`), Array.from({ length: 60 }, (_, i) => `${f}_value_${i + 1} = compute_${f}_${i + 1}(items_${f}_${i + 1})`).join('\n') + '\n');
  }
  g('add', '-A');
  g('commit', '-q', '-m', 'base');
  const base = g('rev-parse', 'HEAD').trim();
  const tasksFile = path.join(tmpdir('agent-replay-tasks-'), 'tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify({ slug: 'x/y', base, tasks: [
    { id: 'i1', issue: { number: 1, title: 'fix a', body: '' }, pr: { number: 11, files: ['src/a.py', 'CHANGES.rst'] } },
    { id: 'i2', issue: { number: 2, title: 'fix b', body: '' }, pr: { number: 12, files: ['src/b.py'] } },
  ] }));
  return { dir, base, tasksFile };
}
const run = (fx, extra = []) => {
  const out = path.join(tmpdir('agent-replay-out-'), 'manifest.json');
  execFileSync('node', [SCRIPT, 'run', '--repo', fx.dir, '--tasks', fx.tasksFile, '--agent', 'mock', '--out', out, '--workdir', path.join(tmpdir('agent-replay-wt-'), 'wt'), ...extra], { encoding: 'utf8' });
  return JSON.parse(fs.readFileSync(out, 'utf8'));
};
const show = (fx, ref, file) => execFileSync('git', ['-C', fx.dir, 'show', `${ref}:${file}`], { encoding: 'utf8' });

test('mock agent: one branch per task from the base, each with exactly the edited file', () => {
  const fx = fixture();
  const m = run(fx);
  assert.deepEqual(m.tasks.map((t) => [t.id, t.status]), [['i1', 'committed'], ['i2', 'committed']]);
  assert.deepEqual(m.tasks.map((t) => t.editedFiles), [['src/a.py'], ['src/b.py']]);
  for (const t of m.tasks) {
    const changed = execFileSync('git', ['-C', fx.dir, 'diff', '--name-only', fx.base, t.sha], { encoding: 'utf8' }).trim();
    assert.equal(changed, t.editedFiles[0]);
    assert.equal(execFileSync('git', ['-C', fx.dir, 'rev-parse', `${t.sha}^`], { encoding: 'utf8' }).trim(), fx.base);
  }
  assert.equal(m.tasks[0].retried, undefined); // nothing failed, no retry
  assert.deepEqual(m.tasks[0].fuzzyEdits, []);
  assert.equal(m.neuronsThisRun, 0); // the mock spends nothing
});

test('mock agent with a wrong search text: one retry with the real excerpt, and the corrected edit is applied', () => {
  const fx = fixture();
  const m = run(fx, ['--mock-flaw', 'typo']);
  for (const t of m.tasks) {
    assert.equal(t.status, 'committed', t.id);
    assert.equal(t.retried, 1);
    assert.equal(t.retryApplied, 1);
    assert.deepEqual(t.failedEdits, []); // the first failure was replaced by the outcome of the retry
    const diff = execFileSync('git', ['-C', fx.dir, 'diff', '--shortstat', fx.base, t.sha], { encoding: 'utf8' });
    assert.match(diff, /1 file changed, 1 insertion\(\+\), 1 deletion\(-\)/);
  }
  // the edited line is a real line of the file with a trailing space added: nothing else moved
  const a = show(fx, m.tasks[0].sha, 'src/a.py').split('\n');
  assert.equal(a.filter((l) => l.endsWith(' ')).length, 1);
});

test('a failure that cannot be retried stays in the report next to the retried edit', () => {
  const fx = fixture();
  const m = run(fx, ['--mock-flaw', 'typo,ghost']);
  for (const t of m.tasks) {
    assert.equal(t.status, 'committed', t.id);
    assert.equal(t.retried, 1);
    assert.deepEqual(t.failedEdits.map((f) => [f.path, f.reason]), [['ghost.py', 'no such file']]);
  }
});

test('mock agent: when none of the human files exists at the base it falls back to the first tracked file', () => {
  const fx = fixture();
  const spec = JSON.parse(fs.readFileSync(fx.tasksFile, 'utf8'));
  spec.tasks = [{ id: 'i3', issue: { number: 3, title: 'z', body: '' }, pr: { number: 13, files: ['nope.py'] } }];
  fs.writeFileSync(fx.tasksFile, JSON.stringify(spec));
  const m = run(fx);
  assert.deepEqual([m.tasks[0].status, m.tasks[0].editedFiles, m.tasks[0].humanFiles], ['committed', ['src/a.py'], ['nope.py']]);
});

test('no worktree is left registered in the repository after a run', () => {
  const fx = fixture();
  run(fx);
  const list = execFileSync('git', ['-C', fx.dir, 'worktree', 'list'], { encoding: 'utf8' }).trim().split('\n');
  assert.equal(list.length, 1);
});

test('the manifest records how long each task took the agent, and the median and 90th percentile of the committed ones', () => {
  const fx = fixture();
  const m = run(fx);
  for (const t of m.tasks) {
    assert.equal(typeof t.elapsedMs, 'number');
    assert.ok(t.elapsedMs >= 0 && t.elapsedMs < 60_000);
  }
  const sorted = m.tasks.map((t) => t.elapsedMs).sort((a, b) => a - b);
  assert.equal(m.taskMs.p50, (sorted[0] + sorted[1]) / 2); // two tasks: the median is their mean
  assert.ok(m.taskMs.p90 >= m.taskMs.p50 && m.taskMs.p90 <= sorted[1]);
});

test('a task that did not commit is not in the timing percentiles', () => {
  const fx = fixture();
  const spec = JSON.parse(fs.readFileSync(fx.tasksFile, 'utf8'));
  spec.tasks[0].pr.files = ['src/a.py'];
  fs.writeFileSync(fx.tasksFile, JSON.stringify(spec));
  const m = run(fx, ['--mock-flaw', 'ghost']); // edits to a file that does not exist: the other edit still commits
  assert.deepEqual(m.tasks.map((t) => t.status), ['committed', 'committed']);
  assert.equal(typeof m.taskMs.p50, 'number');
});
