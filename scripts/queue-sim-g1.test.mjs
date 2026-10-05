// node --test scripts/queue-sim-g1.test.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tmpdir } from './lib/tmp.mjs';

const SCRIPT = path.join(path.dirname(new URL(import.meta.url).pathname), 'queue-sim-g1.mjs');
const REPOS = ['click', 'hono', 'axios', 'prettier', 'eslint', 'vite', 'svelte', 'cli'];

function setup(times = { workMs: 90000, workCv: 0.5, reviewMs: 20000, rebaseMs: 40000, source: 'phase 2, medians of the agent and reviewers on staging' }) {
  const fp = tmpdir('g1-fp-');
  for (const r of REPOS) fs.writeFileSync(path.join(fp, `${r}-tasks.json`), '{"tasks":[]}');
  const tf = path.join(tmpdir('g1-t-'), 'times.json');
  fs.writeFileSync(tf, JSON.stringify(times));
  return { fp, tf, out: tmpdir('g1-out-') };
}
const run = (args) => execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8', stdio: 'pipe' });

test('dry run: one grid per repository of the fixed sample, with the reference cell and the times of the file', () => {
  const { fp, tf, out } = setup();
  const lines = run(['--times', tf, '--footprints-dir', fp, '--out-dir', out, '--dry-run']).trim().split('\n');
  assert.equal(lines.length, 8);
  REPOS.forEach((r, i) => {
    assert.match(lines[i], new RegExp(`--footprints-from \\S*${r}-tasks.json`));
    assert.match(lines[i], /--agents-list 10 --test-list 30000 --reps 3 --parallel 3 --scale 0.25 --work-ms 90000 --work-cv 0.5 --review-ms 20000 --rebase-ms 40000/);
    assert.match(lines[i], /--footprint-kind human/);
  });
});

test('the times cannot be tuned from the command line, and a times file without a source or with bad numbers is refused', () => {
  const { fp, tf, out } = setup();
  assert.throws(() => run(['--footprints-dir', fp, '--out-dir', out, '--work-ms', '1000', '--dry-run']), /usage/); // no --times file
  const noSource = setup({ workMs: 1, workCv: 0, reviewMs: 1, rebaseMs: 1 });
  assert.throws(() => run(['--times', noSource.tf, '--footprints-dir', noSource.fp, '--out-dir', noSource.out, '--dry-run']), /source/);
  const bad = setup({ workMs: 0, workCv: 0, reviewMs: 1, rebaseMs: 1, source: 'a long enough source text' });
  assert.throws(() => run(['--times', bad.tf, '--footprints-dir', bad.fp, '--out-dir', bad.out, '--dry-run']), /workMs/);
  // the command-line work time is ignored: the line carries the file's
  const lines = run(['--times', tf, '--footprints-dir', fp, '--out-dir', out, '--work-ms', '1', '--dry-run']);
  assert.match(lines, /--work-ms 90000/);
  assert.doesNotMatch(lines, /--work-ms 1 /);
});

test('a missing footprints file for a repository of the sample is refused', () => {
  const { fp, tf, out } = setup();
  fs.rmSync(path.join(fp, 'vite-tasks.json'));
  assert.throws(() => run(['--times', tf, '--footprints-dir', fp, '--out-dir', out, '--dry-run']), /missing .*vite-tasks.json/);
});
