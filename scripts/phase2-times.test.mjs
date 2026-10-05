// node --test scripts/phase2-times.test.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tmpdir } from './lib/tmp.mjs';

const SCRIPT = path.join(path.dirname(new URL(import.meta.url).pathname), 'phase2-times.mjs');
const write = (obj) => {
  const f = path.join(tmpdir('p2-'), 'x.json');
  fs.writeFileSync(f, JSON.stringify(obj));
  return f;
};
const task = (id, status, elapsedMs, editMs) => ({ id, status, ...(elapsedMs === undefined ? {} : { elapsedMs }), calls: editMs === undefined ? [] : [{ step: 'select', ms: 999 }, { step: 'edit', ms: editMs }, { step: 'retry', ms: 12345 }] });
const run = (pilots, reviews) => {
  const out = path.join(tmpdir('p2-o-'), 'times.json');
  const args = pilots.flatMap((p) => ['--pilot', p]);
  execFileSync('node', [SCRIPT, ...args, '--reviews', reviews, '--out', out], { encoding: 'utf8', stdio: 'pipe' });
  return JSON.parse(fs.readFileSync(out, 'utf8'));
};
const REVIEWS = { date: '2026-10-06', measuredVia: 'the account REST API from a local machine', quorumMs: [6000, 8000, 7000, 9000, 10000], models: [{ model: 'm1' }] };

test('the times by the fixed formulas, from committed tasks only; a retry call is not an edit call', () => {
  const pilot = write({ slug: 'honojs/hono', runId: 'p1', date: '2026-10-06', coder: 'qwen', selector: 'llama', tasks: [
    task('a', 'committed', 10000, 3000), task('b', 'committed', 20000, 4000), task('c', 'committed', 30000, 5000), task('d', 'committed', 40000, 6000),
    task('e', 'no-patch', 99999, 99999), // not committed: ignored
  ] });
  const t = run([pilot], write(REVIEWS));
  // elapsed [10, 20, 30, 40] s: median 25 s, 90th percentile 37 s; edit calls 3, 4, 5, 6 s: median 4.5 s; quorum median 8 s
  assert.deepEqual([t.workMs, t.workCv, t.rebaseMs, t.reviewMs], [25000, 0.31, 4500, 8000]);
  assert.deepEqual(t.derived, { taskP50Ms: 25000, taskP90Ms: 37000, editCalls: 4, reviewSamples: 5 });
  assert.match(t.source, /honojs\/hono \(4 committed of 5 tasks, run p1, 2026-10-06\); reviewer latency of 5 patches the account REST API/);
});

test('two manifests of one run (stopped by the budget, then completed): the committed task counts once', () => {
  const a = write({ slug: 's', runId: 'p1', date: 'd', tasks: [task('a', 'committed', 10000, 3000), task('b', 'budget-stop')] });
  const b = write({ slug: 's', runId: 'p1b', date: 'd', tasks: [task('b', 'committed', 30000, 5000)] });
  const t = run([a, b], write(REVIEWS));
  assert.deepEqual([t.derived.editCalls, t.workMs, t.rebaseMs], [2, 20000, 4000]);
  assert.match(t.source, /2 committed of 2 tasks, run p1\+p1b/);
});

test('it refuses, with a message, when the pilot has no timing or the reviewer sample is too thin', () => {
  const noTiming = write({ slug: 's', runId: 'p', date: 'd', tasks: [task('a', 'committed')] });
  assert.throws(() => run([noTiming], write(REVIEWS)), (e) => e.status === 1 && /taskMs.p50/.test(String(e.stderr)));
  const ok = write({ slug: 's', runId: 'p', date: 'd', tasks: [task('a', 'committed', 10000, 3000), task('b', 'committed', 20000, 4000)] });
  assert.throws(() => run([ok], write({ ...REVIEWS, quorumMs: [1, 2, 3, 4] })), (e) => e.status === 1 && /at least 5 patches, got 4/.test(String(e.stderr)));
  assert.throws(() => run([ok], write({ ...REVIEWS, quorumMs: undefined })), (e) => e.status === 1 && /at least 5 patches, got 0/.test(String(e.stderr))); // a reviews file without samples says so, it does not crash
});
