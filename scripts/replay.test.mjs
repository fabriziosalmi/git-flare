// node --test scripts/replay.test.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { applyEdits, cleanRanges, diagnoseMiss, extractJson, git, ledgerAdd, ledgerRead, neuronsFor, NEURON_RATES, outlineOf, pairVerdict, safeRelPath, sharedPathPairs } from './lib/replay.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'replay-test-'));

/** A repository with one commit holding `files`; returns {dir, base} and a helper that commits a branch change. */
function repoWith(files) {
  const dir = tmp();
  const g = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  for (const [p, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), c);
  }
  g('add', '-A');
  g('commit', '-q', '-m', 'base');
  const base = g('rev-parse', 'HEAD').trim();
  const branch = (name, change) => {
    g('checkout', '-q', '-b', name, base);
    for (const [p, c] of Object.entries(change)) {
      fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
      fs.writeFileSync(path.join(dir, p), c);
    }
    g('add', '-A');
    g('commit', '-q', '-m', name);
    return g('rev-parse', 'HEAD').trim();
  };
  return { dir, base, branch };
}

const BODY = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
const edited = (n, text) => BODY.replace(`line ${n}\n`, `${text}\n`);

test('pairVerdict: disjoint paths are accepted by both rules', () => {
  const { dir, base, branch } = repoWith({ 'a.txt': BODY, 'b.txt': BODY });
  const a = branch('a', { 'a.txt': edited(3, 'A') });
  const b = branch('b', { 'b.txt': edited(3, 'B') });
  const v = pairVerdict(dir, a, b, base);
  assert.equal(v.verdict, 'disjoint');
  assert.deepEqual(v.common, []);
});

test('pairVerdict: same file, distant hunks: only the file-level rule rejects (clean)', () => {
  const { dir, base, branch } = repoWith({ 'a.txt': BODY });
  const a = branch('a', { 'a.txt': edited(3, 'A') });
  const b = branch('b', { 'a.txt': edited(25, 'B') });
  const v = pairVerdict(dir, a, b, base);
  assert.equal(v.verdict, 'clean');
  assert.deepEqual(v.common, ['a.txt']);
});

test('pairVerdict: same lines changed differently is a conflict, with the conflicted path', () => {
  const { dir, base, branch } = repoWith({ 'a.txt': BODY, 'b.txt': BODY });
  const a = branch('a', { 'a.txt': edited(3, 'A'), 'b.txt': edited(9, 'x') });
  const b = branch('b', { 'a.txt': edited(3, 'B') });
  const v = pairVerdict(dir, a, b, base);
  assert.equal(v.verdict, 'conflict');
  assert.deepEqual(v.conflicted, ['a.txt']);
});

test('pairVerdict: a side with no change is empty; the default base is the merge-base', () => {
  const { dir, base, branch } = repoWith({ 'a.txt': BODY });
  const a = branch('a', { 'a.txt': edited(3, 'A') });
  assert.equal(pairVerdict(dir, a, base, base).verdict, 'empty');
  const b = branch('b', { 'a.txt': edited(25, 'B') });
  const v = pairVerdict(dir, a, b);
  assert.equal(v.base, base);
  assert.equal(v.verdict, 'clean');
});

test('applyEdits: unique search applies, missing and non-unique are reported and skipped', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'f.txt'), 'one\ntwo\ntwo\nthree\n');
  const r = applyEdits(dir, [
    { path: 'f.txt', search: 'three', replace: '3' },
    { path: 'f.txt', search: 'two', replace: '2' },
    { path: 'f.txt', search: 'absent', replace: 'x' },
    { path: 'nope.txt', search: 'a', replace: 'b' },
  ]);
  assert.deepEqual(r.applied, ['f.txt']);
  assert.deepEqual(r.failed.map((f) => f.reason), ['search text not unique', 'search text not found', 'no such file']);
  assert.equal(fs.readFileSync(path.join(dir, 'f.txt'), 'utf8'), 'one\ntwo\ntwo\n3\n');
});

test('applyEdits: empty search creates a new file but never overwrites; unsafe paths are refused', () => {
  const parent = tmp(); // private parent: a path that escapes `dir` lands here, not in a shared directory
  const dir = path.join(parent, 'work');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'old.txt'), 'x');
  const r = applyEdits(dir, [
    { path: 'sub/new.txt', search: '', replace: 'hello' },
    { path: 'old.txt', search: '', replace: 'overwrite' },
    { path: '../escape.txt', search: '', replace: 'x' },
    { path: '.git/config', search: '', replace: 'x' },
    { path: '/abs.txt', search: '', replace: 'x' },
    { path: 'ok.txt', search: 1, replace: 'x' },
  ]);
  assert.deepEqual(r.applied, ['sub/new.txt']);
  assert.equal(r.failed.length, 5);
  assert.equal(fs.readFileSync(path.join(dir, 'old.txt'), 'utf8'), 'x');
  assert.equal(fs.existsSync(path.join(parent, 'escape.txt')), false);
});

test('safeRelPath', () => {
  for (const p of ['a.js', 'src/a/b.py', 'tests/test_x.py']) assert.equal(safeRelPath(p), true, p);
  for (const p of ['', '/a', '../a', 'a/../b', '.git/x', 'a//b', '.gitflare/gates.json', 'a b', 5, undefined]) assert.equal(safeRelPath(p), false, String(p));
});

test('extractJson: object, fenced, with prose around, broken', () => {
  assert.deepEqual(extractJson({ a: 1 }), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a": {"b": "}"}}\n```'), { a: { b: '}' } });
  assert.deepEqual(extractJson('here you go {"files": ["x"]} done'), { files: ['x'] });
  assert.equal(extractJson('{"a": '), null);
  assert.equal(extractJson('no json'), null);
  assert.equal(extractJson([1]), null);
});

test('neuronsFor: rates from the pricing page, unknown models refused', () => {
  const m = '@cf/qwen/qwen2.5-coder-32b-instruct';
  assert.equal(NEURON_RATES[m].in, 60000);
  assert.ok(Math.abs(neuronsFor(m, 6000, 1000) - (6000 * 0.06 + 1000 * 0.090909)) < 1e-6); // ≈ 451 neurons
  assert.throws(() => neuronsFor('@cf/unknown/model', 1, 1), /no neuron rate/);
});

test('ledger: per UTC day, shared by runs', () => {
  const file = path.join(tmp(), 'ledger.json');
  const d1 = new Date('2026-10-04T23:59:00Z');
  const d2 = new Date('2026-10-05T00:01:00Z');
  assert.equal(ledgerRead(file, d1).spent, 0);
  assert.equal(ledgerAdd(100, file, d1), 100);
  assert.equal(ledgerAdd(50.5, file, d1), 150.5);
  assert.equal(ledgerRead(file, d1).spent, 150.5);
  assert.equal(ledgerRead(file, d2).spent, 0); // a new day starts from zero
  assert.equal(ledgerAdd(7, file, d2), 7);
  assert.equal(ledgerRead(file, d1).spent, 150.5);
});

test('git helper: exit codes listed as ok are answers, others throw', () => {
  const { dir } = repoWith({ 'a.txt': 'x' });
  assert.equal(git(dir, ['merge-base', 'HEAD', 'HEAD']).code, 0);
  assert.equal(git(dir, ['cat-file', '-t', 'deadbeef'], [128]).code, 128);
  assert.throws(() => git(dir, ['cat-file', '-t', 'deadbeef']));
});

test('outlineOf: definitions with 1-based line numbers, capped', () => {
  const text = ['import x', 'class A:', '    def f(self):', '        pass', 'async def g():', 'export const h = 1', 'plain text'].join('\n');
  assert.deepEqual(outlineOf(text).map((o) => o.line), [2, 3, 5, 6]);
  assert.equal(outlineOf(text, 2).length, 2);
  assert.deepEqual(outlineOf('no definitions here\njust text'), []);
});

test('cleanRanges: clamps, sorts, merges, caps at 3 and falls back to the head of the file', () => {
  assert.deepEqual(cleanRanges([{ start: 10, end: 20 }], 100), [{ start: 10, end: 20 }]);
  assert.deepEqual(cleanRanges([{ start: 50, end: 900 }], 1000, 160), [{ start: 50, end: 209 }]); // at most 160 lines
  assert.deepEqual(cleanRanges([{ start: 90, end: 500 }], 100), [{ start: 90, end: 100 }]); // not past the end
  assert.deepEqual(cleanRanges([{ start: 30, end: 40 }, { start: 10, end: 35 }], 100), [{ start: 10, end: 40 }]); // sorted, merged
  assert.equal(cleanRanges([1, 2, 3, 4, 5].map((i) => ({ start: i * 50, end: i * 50 + 5 })), 1000).length, 3);
  for (const bad of [undefined, [], [{ start: 'a', end: 2 }], [{ start: 5, end: 2 }], [{ start: 0, end: 4 }], [{ start: 500, end: 600 }]]) {
    assert.deepEqual(cleanRanges(bad, 100, 160), [{ start: 1, end: 100 }], JSON.stringify(bad));
  }
});

test('diagnoseMiss: whitespace, lines-not-contiguous, partial and absent, with the nearest line', () => {
  const text = 'def f(x):\n    y = x + 1\n    return y\n\ndef g():\n    pass\n';
  assert.equal(diagnoseMiss(text, 'def f(x):\n  y = x + 1\n  return y').kind, 'whitespace'); // indentation differs
  assert.equal(diagnoseMiss(text, 'return y\ny = x + 1').kind, 'lines-not-contiguous'); // reordered
  assert.equal(diagnoseMiss(text, 'def g():\n    return 42').kind, 'partial'); // first line exists, the rest invented
  const a = diagnoseMiss(text, 'def compute(value):\n    return y');
  assert.equal(a.kind, 'absent');
  assert.equal(a.searchHead, 'def compute(value):');
  assert.equal(diagnoseMiss(text, 'def h(x):').nearest, 'def f(x):'); // nearest = first line sharing an identifier of 3+ characters (here `def`)
});

test('applyEdits: a search that is not found carries its diagnosis', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'f.py'), 'def f(x):\n    return x\n');
  const r = applyEdits(dir, [{ path: 'f.py', search: 'def f(x):\n  return x', replace: 'z' }]);
  assert.equal(r.failed[0].reason, 'search text not found');
  assert.equal(r.failed[0].kind, 'whitespace');
});

test('sharedPathPairs: pairs sharing a path, optionally ignoring some paths', () => {
  const sets = [['a', 'CHANGES.rst'], ['b', 'CHANGES.rst'], ['a'], []];
  assert.deepEqual(sharedPathPairs(sets), [2, 6]); // 0-1 share CHANGES.rst, 0-2 share `a`; the other four pairs share nothing
  assert.deepEqual(sharedPathPairs(sets, /CHANGES/), [1, 6]); // only 0-2 shares `a` once CHANGES.rst is ignored
  assert.deepEqual(sharedPathPairs([]), [0, 0]);
  assert.deepEqual(sharedPathPairs([['x']]), [0, 0]);
});
