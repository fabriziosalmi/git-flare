import assert from 'node:assert/strict';
import { test } from 'node:test';
import { distinctFootprints } from './collect-footprints.mjs';

const pr = (number, mergedAt, files, author = { login: 'dev', is_bot: false }) => ({ number, mergedAt, author, files: files.map((path) => ({ path })) });

test('distinctFootprints: newest first, no bots, 1 to maxFiles files, distinct file sets, at most keep', () => {
  const prs = [
    pr(1, '2026-03-01', ['a.js']),
    pr(2, '2026-03-05', ['b.js', 'c.js']),
    pr(3, '2026-03-04', ['c.js', 'b.js']), // the same file set as 2, in another order: skipped, the newer 2 is kept
    pr(4, '2026-03-06', ['x.js'], { login: 'dependabot[bot]', is_bot: true }),
    pr(5, '2026-03-07', ['y.js'], { login: 'renovate', is_bot: false }), // a bot by its name
    pr(6, '2026-03-08', []), // no file
    pr(7, '2026-03-09', Array.from({ length: 31 }, (_, i) => `f${i}.js`)), // too many
    pr(8, '2026-03-10', ['d.js']),
  ];
  const out = distinctFootprints(prs, { keep: 60, maxFiles: 30 });
  assert.deepEqual(out.map((x) => x.number), [8, 2, 1]);
  assert.deepEqual(out[1].files, ['b.js', 'c.js'], 'files sorted');
  assert.deepEqual(distinctFootprints(prs, { keep: 2 }).map((x) => x.number), [8, 2], 'keep caps the list, newest first');
  assert.equal(distinctFootprints(prs, { maxFiles: 31 }).some((x) => x.number === 7), true, 'maxFiles is the cap');
});
