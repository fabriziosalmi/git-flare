// node --test scripts/sim.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { empiricalSampler, footprintsOf, g1Decision, lognormalMs, quantile, rng, summarizeRun, uniqueName, zipfSampler } from './lib/sim.mjs';

test('rng: the same seed gives the same sequence, another seed another, all in [0, 1)', () => {
  const a = rng(7);
  const b = rng(7);
  const xs = Array.from({ length: 50 }, () => a());
  assert.deepEqual(xs, Array.from({ length: 50 }, () => b()));
  assert.notDeepEqual(xs, Array.from({ length: 50 }, ((c) => () => c())(rng(8))));
  assert.ok(xs.every((x) => x >= 0 && x < 1));
  assert.ok(new Set(xs).size > 45); // not stuck
});

test('lognormalMs: the mean and the spread asked for, constant at cv 0, zero without a mean', () => {
  const r = rng(1);
  assert.equal(lognormalMs(r, 1000, 0), 1000);
  assert.equal(lognormalMs(r, 0, 0.5), 0);
  assert.equal(lognormalMs(r, -5, 0.5), 0);
  const xs = Array.from({ length: 40000 }, () => lognormalMs(r, 1000, 0.5));
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
  assert.ok(Math.abs(mean - 1000) < 25, `mean ${mean}`);
  assert.ok(Math.abs(sd / mean - 0.5) < 0.03, `cv ${sd / mean}`);
  assert.ok(xs.every((x) => x >= 1));
});

test('quantile: linear interpolation, order-independent, null without data', () => {
  assert.equal(quantile([], 0.5), null);
  assert.equal(quantile([5], 0.9), 5);
  assert.equal(quantile([4, 1, 3, 2], 0.5), 2.5);
  assert.equal(quantile([1, 2, 3, 4, 5], 0), 1);
  assert.equal(quantile([1, 2, 3, 4, 5], 1), 5);
  assert.equal(quantile([0, 0, 1, 1], 0.9), 1);
});

test('empiricalSampler: draws real footprints, returns copies, ignores empty ones, refuses no data', () => {
  const fps = [['a.py'], ['b.py', 'c.py'], []];
  const s = empiricalSampler(rng(3), fps);
  const seen = new Set(Array.from({ length: 200 }, () => JSON.stringify(s())));
  assert.deepEqual([...seen].sort(), ['["a.py"]', '["b.py","c.py"]']);
  const x = s();
  x.push('mutated');
  assert.ok(!fps.flat().includes('mutated'));
  assert.throws(() => empiricalSampler(rng(1), [[], []]), /no footprint/);
});

test('zipfSampler: popularity falls with rank, sizes are respected, files in a patch are distinct', () => {
  const skew = zipfSampler(rng(5), { files: 20, s: 1.5, sizes: [1] });
  const counts = {};
  for (let i = 0; i < 5000; i++) for (const f of skew()) counts[f] = (counts[f] ?? 0) + 1;
  assert.ok(counts['src/f001.py'] > counts['src/f002.py'] && counts['src/f002.py'] > (counts['src/f010.py'] ?? 0));
  assert.ok(counts['src/f001.py'] > 8 * (counts['src/f010.py'] ?? 1), 'rank 1 is far more popular than rank 10 (expected ratio about 31)');
  const flat = zipfSampler(rng(5), { files: 20, s: 0, sizes: [1] });
  const fc = {};
  for (let i = 0; i < 20000; i++) for (const f of flat()) fc[f] = (fc[f] ?? 0) + 1;
  const vals = Object.values(fc);
  assert.ok(Math.max(...vals) / Math.min(...vals) < 1.3, 'uniform when s = 0');
  const sized = zipfSampler(rng(9), { files: 10, s: 1, sizes: [2, 4] });
  for (let i = 0; i < 300; i++) {
    const f = sized();
    assert.ok(f.length === 2 || f.length === 4);
    assert.equal(new Set(f).size, f.length);
  }
  assert.equal(zipfSampler(rng(1), { files: 3, s: 1, sizes: [10] })().length, 3); // capped at the number of files
});

const P = (patchId, taskId, attempt, status, claimedAt, submittedAt, queuedAt, closedAt) => ({ patchId, taskId, attempt, status, claimedAt, submittedAt, queuedAt, closedAt });

test('summarizeRun: rejection, attempts, window, its parts and landings, by hand-counted data', () => {
  const patches = [
    P('p1', 'A', 1, 'merged', 0, 10, 20, 30),
    P('p2', 'B', 1, 'stale', 5, 12, 22, 32), // conflict: p1 landed at 30 inside its window
    P('p3', 'B', 2, 'merged', 33, 40, 45, 60), // the retry of task B
    P('p4', 'C', 1, 'merged', 1, 2, 3, 31),
  ];
  const s = summarizeRun({ patches, wallMs: 60000 });
  assert.deepEqual([s.submissions, s.merged, s.stale, s.other], [4, 3, 1, 0]);
  assert.equal(s.rejectionPerSubmissionPct, 25); // 1 of 4
  assert.equal(s.firstAttemptRejectionPct, 33.3); // p1, p2, p4 are first attempts: 1 of 3
  assert.deepEqual([s.tasks, s.maxAttempts, s.attemptsPerTask], [3, 2, { 1: 2, 2: 1 }]);
  // windows closedAt - claimedAt: 30, 27, 27, 30
  assert.equal(s.windowMs.p50, 28.5);
  // merged patches only: work 10, 7, 1 -> 7; review 10, 5, 1 -> 5; queue and tests 10, 15, 28 -> 15
  assert.deepEqual(s.partsMs, { work: 7, review: 5, queueAndTests: 15 });
  // landings in each window, not counting the patch itself: p1 (0,30] 0, p2 (5,32] 2 (p1@30 and p4@31), p3 (33,60] 0,
  // p4 (1,31] 1 (p1@30): [0, 2, 0, 1], mean 0.75, median 0.5, 90th percentile 1.7
  assert.deepEqual(s.landingsPerWindow, { mean: 0.8, p50: 0.5, p90: 1.7 });
  assert.equal(s.throughputPerMin, 3);
});

test('summarizeRun: patches that closed in the same millisecond count as landings for each other, not for themselves', () => {
  const patches = [P('a', 'A', 1, 'merged', 0, 1, 2, 10), P('b', 'B', 1, 'merged', 0, 1, 2, 10), P('c', 'C', 1, 'merged', 0, 1, 2, 10)];
  const s = summarizeRun({ patches, wallMs: 1000 });
  assert.deepEqual(s.landingsPerWindow, { mean: 2, p50: 2, p90: 2 }); // each of three saw the two others land
});

test('summarizeRun: other outcomes are counted apart, patches without times are kept out of the timing, empty run is null', () => {
  const patches = [P('a', 'A', 1, 'merged', 0, 1, 2, 10), { patchId: 'r', taskId: 'R', attempt: 1, status: 'rejected' }, { patchId: 'u', taskId: 'U', attempt: 1, status: 'merged' }, { patchId: 's', taskId: 'S', attempt: 1, status: 'stale' }];
  const s = summarizeRun({ patches, wallMs: 60000 });
  assert.deepEqual([s.submissions, s.merged, s.stale, s.other], [4, 2, 1, 1]);
  assert.equal(s.rejectionPerSubmissionPct, 33.3); // 1 stale of the 3 decided submissions: the 'rejected' one is not decided here
  assert.equal(s.windowMs.p50, 10); // only 'a' has times
  const e = summarizeRun({ patches: [], wallMs: 0 });
  assert.deepEqual([e.rejectionPerSubmissionPct, e.firstAttemptRejectionPct, e.windowMs.p50, e.landingsPerWindow.mean, e.throughputPerMin, e.maxAttempts], [null, null, null, null, null, 0]);
});

test('summarizeRun: a conflict on a retry counts as a rejection per submission but not as a first-attempt rejection; attempts are the maximum, in any order', () => {
  const patches = [
    P('a3', 'A', 3, 'merged'), // arrives first, the later attempt
    P('a1', 'A', 1, 'stale'),
    P('a2', 'A', 2, 'stale'),
    P('b1', 'B', 1, 'merged'),
    P('c1', 'C', 1, 'merged'),
  ];
  const s = summarizeRun({ patches, wallMs: 1000 });
  assert.equal(s.rejectionPerSubmissionPct, 40); // 2 of 5
  assert.equal(s.firstAttemptRejectionPct, 33.3); // first attempts: a1 (stale), b1, c1: 1 of 3
  assert.deepEqual([s.tasks, s.maxAttempts, s.attemptsPerTask], [3, 3, { 1: 2, 3: 1 }]);
});

test('footprintsOf: human or agent files, with or without changelog/version/dependency files, invalid paths and empty footprints dropped', () => {
  const m = {
    tasks: [
      { id: 't1', status: 'committed', humanFiles: ['a.py', 'CHANGES.rst'], editedFiles: ['a.py'] },
      { id: 't2', status: 'no-patch', humanFiles: ['package.json'] },
      { id: 't3', status: 'committed', humanFiles: ['b.py'], editedFiles: ['b.py', 'x y.py'] },
      { id: 't4', status: 'budget-stop', humanFiles: ['c.py'], editedFiles: ['c.py'] },
    ],
  };
  assert.deepEqual(footprintsOf([m], 'human'), [['a.py', 'CHANGES.rst'], ['package.json'], ['b.py'], ['c.py']]);
  assert.deepEqual(footprintsOf([m], 'human-nohot'), [['a.py'], ['b.py'], ['c.py']]); // t2 is only a dependency file: gone
  assert.deepEqual(footprintsOf([m], 'agent'), [['a.py'], ['b.py']]); // committed patches only, 'x y.py' refused
  assert.deepEqual(footprintsOf([m], 'agent-nohot'), [['a.py'], ['b.py']]);
  assert.deepEqual(footprintsOf([m, m], 'agent').length, 4); // several manifests are concatenated
  // the tasks file of agent-replay (before any run) holds the human files under pr.files
  assert.deepEqual(footprintsOf([{ tasks: [{ id: 'i1', pr: { files: ['x.ts', 'y.ts'] } }, { id: 'i2', humanFiles: ['z.ts'], pr: { files: ['ignored.ts'] } }] }], 'human'), [['x.ts', 'y.ts'], ['z.ts']]);
  assert.throws(() => footprintsOf([m], 'humans'), /unknown footprint kind/);
  assert.throws(() => footprintsOf([m], 'human-hot'), /unknown footprint kind/);
});

test('uniqueName: two cells started in the same millisecond differ by process or by chance, and the name is valid for a repository', () => {
  const r = rng(1);
  assert.notEqual(uniqueName(1000, 11, r), uniqueName(1000, 12, r)); // same millisecond, other process
  assert.notEqual(uniqueName(1000, 11, () => 0.1), uniqueName(1000, 11, () => 0.2)); // same process, other random part
  const names = new Set(Array.from({ length: 5000 }, () => uniqueName(1000, 11, r)));
  assert.ok(names.size > 4900, `${names.size} distinct in 5000 draws`); // 36^4 draws collide rarely, not never
  for (const n of names) assert.match(`sim-${n}`, /^[a-z0-9][a-z0-9-]{0,47}$/);
  assert.equal(uniqueName(0, 0, () => 0).length, 6); // '0' + '0' + '0000'
});

test('g1Decision: the thresholds of the note, exactly at their edges, and the median of an even number is the mean of the middle two', () => {
  const d = (rates) => g1Decision(rates).branch;
  // eight repositories: the median is the mean of the 4th and 5th values
  assert.equal(g1Decision([1, 2, 3, 4, 6, 7, 8, 9]).median, 5);
  assert.equal(g1Decision([9, 1, 8, 2, 7, 3, 6, 4]).median, 5); // order does not matter
  assert.equal(g1Decision([5, 6, 7]).median, 6); // odd: the middle one
  assert.equal(d([20, 20, 20, 20, 20, 20, 20, 20]), 'proceed'); // 20% exactly goes on
  assert.equal(d([19.9, 19.9, 19.9, 19.9, 19.9, 19.9, 19.9, 19.9]), 'cheap-levers');
  assert.equal(d([10, 10, 10, 10, 10, 10, 10, 10]), 'cheap-levers'); // 10% exactly is the middle branch
  assert.equal(d([9.9, 9.9, 9.9, 9.9, 9.9, 9.9, 9.9, 9.9]), 'stop');
  assert.equal(d([30, 5]), 'cheap-levers'); // the median of two is 17.5
  assert.equal(d([12]), 'cheap-levers');
});

test('g1Decision: the clause keeps the project open when a median under 10% hides at least 3 repositories at 20% or more', () => {
  // median (4th and 5th of 8) is 4.5: under 10%
  assert.equal(g1Decision([60, 40, 20, 4, 5, 2, 1, 1]).branch, 'cheap-levers'); // three at 20% or more
  assert.match(g1Decision([60, 40, 20, 4, 5, 2, 1, 1]).reason, /stays open/);
  assert.equal(g1Decision([60, 40, 19.9, 4, 5, 2, 1, 1]).branch, 'stop'); // only two: the project closes
  // four at 60% and four at 1%: sorted [1, 1, 1, 1, 60, 60, 60, 60], the median is the mean of 1 and 60, 30.5: proceed (the rule as written)
  assert.equal(g1Decision([60, 60, 60, 60, 1, 1, 1, 1]).branch, 'proceed');
});

test('g1Decision: it reports how many repositories there were and how many were at 20% or more, and refuses no data', () => {
  const g = g1Decision([25, 15, 5, 5, 5, 5, 5, 5]);
  assert.deepEqual([g.repositories, g.atLeast20, g.median], [8, 1, 5]);
  assert.throws(() => g1Decision([]), /at least one repository/);
});
