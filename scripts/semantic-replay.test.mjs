// node --test scripts/semantic-replay.test.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { wilson } from './lib/replay.mjs';
import { tmpdir } from './lib/tmp.mjs';

const SCRIPT = path.join(path.dirname(new URL(import.meta.url).pathname), 'semantic-replay.mjs');
const tmp = () => tmpdir('semantic-test-');
const lines = (n, prefix = 'l') => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);

/**
 * A repository whose test is "A.txt has at most `limit` lines". Two branches from the base change files with the
 * given edits (path → content, or a function of the base content); they are merged into main with a merge commit.
 */
function scenario({ limit = 13, a, b, base = { 'A.txt': lines(12).join('\n') + '\n', 'B.txt': 'b\n', 'C.txt': 'c\n' } }) {
  const dir = tmp();
  const g = (...x) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...x], { encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  const write = (files) => {
    for (const [p, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, p), c);
  };
  write({ ...base, 'limit.txt': `${limit}\n` });
  g('add', '-A');
  g('commit', '-q', '-m', 'base');
  for (const [name, files] of [['a', a], ['b', b]]) {
    g('checkout', '-q', '-b', name, 'main');
    write(files);
    g('add', '-A');
    g('commit', '-q', '-m', name);
  }
  g('checkout', '-q', 'main');
  g('merge', '-q', '--no-ff', '-m', 'merge a', 'a');
  g('merge', '-q', '--no-ff', '-m', 'merge b', 'b');
  return dir;
}
const TEST_CMD = '[ "$(wc -l < A.txt)" -le "$(cat limit.txt)" ]';
const run = (repo, extra = []) => {
  const out = path.join(tmp(), 'out.json');
  const stdout = execFileSync('node', [SCRIPT, '--min-free-gib', '0.01', '--repo', repo, '--test', TEST_CMD, '--timeout', '20', '--out', out, ...extra], { encoding: 'utf8' });
  return { result: JSON.parse(fs.readFileSync(out, 'utf8')), stdout };
};
const top = (n) => lines(n, 'x').join('\n') + '\n'; // n new lines
const A12 = lines(12).join('\n') + '\n';

test('semantic conflict: each side passes alone, the textually clean merge breaks the test', () => {
  // a adds a line at the top, b at the bottom of A.txt: 13 lines each (limit 13), 14 once merged
  const repo = scenario({ a: { 'A.txt': 'top\n' + A12 }, b: { 'A.txt': A12 + 'bottom\n' } });
  const g = run(repo).result.groups.clean;
  assert.deepEqual([g.pairs, g.ok, g.semantic, g.preexisting], [1, 0, 1, 0]);
  assert.equal(g.semanticCases.length, 1);
  assert.match(g.semanticCases[0].failureTail ?? '', /^$|./); // the tail of the failing test output is kept
  assert.equal(g.semanticRatePct, 100);
});

test('ok: a clean merge of two changes in the same file that still passes', () => {
  const repo = scenario({ limit: 20, a: { 'A.txt': 'top\n' + A12 }, b: { 'A.txt': A12 + 'bottom\n' } });
  const g = run(repo).result.groups.clean;
  assert.deepEqual([g.pairs, g.ok, g.semantic], [1, 1, 0]);
});

test('preexisting: a parent fails alone, so the failure of the merge is not attributed to the merge', () => {
  // a adds two lines (14 > 13): fails alone
  const repo = scenario({ a: { 'A.txt': 'top1\ntop2\n' + A12 }, b: { 'A.txt': A12 + 'bottom\n' } });
  const g = run(repo).result.groups.clean;
  assert.deepEqual([g.pairs, g.preexisting, g.semantic, g.ok], [1, 1, 0, 0]);
  assert.equal(g.judged, 0);
  assert.equal(g.semanticRatePct, null);
});

test('control group: pairs with no common path are tested too, and kept apart from the clean-but-overlapping group', () => {
  const repo = scenario({ limit: 20, a: { 'B.txt': 'b2\n' }, b: { 'C.txt': 'c2\n' } });
  const { result } = run(repo);
  assert.equal(result.groups.clean.pairs, 0);
  assert.deepEqual([result.groups.disjoint.pairs, result.groups.disjoint.ok], [1, 1]);
});

test('a real textual conflict is neither group', () => {
  const repoDir = tmp();
  const g = (...x) => execFileSync('git', ['-C', repoDir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...x], { encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repoDir, 'A.txt'), A12);
  fs.writeFileSync(path.join(repoDir, 'limit.txt'), '20\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'base');
  for (const [n, t] of [['a', 'AAA'], ['b', 'BBB']]) {
    g('checkout', '-q', '-b', n, 'main');
    fs.writeFileSync(path.join(repoDir, 'A.txt'), A12.replace('l3\n', `${t}\n`));
    g('commit', '-q', '-am', n);
  }
  g('checkout', '-q', 'main');
  g('merge', '-q', '--no-ff', '-m', 'm', 'a');
  try {
    g('merge', '-m', 'm2', 'b');
  } catch {
    /* conflict */
  }
  fs.writeFileSync(path.join(repoDir, 'A.txt'), A12.replace('l3\n', 'AAA\nBBB\n'));
  g('add', '-A');
  g('commit', '-q', '-m', 'resolved');
  const { result } = run(repoDir);
  assert.equal(result.groups.clean.pairs + result.groups.disjoint.pairs, 0);
});

test('a test that never ends is a timeout, and its process group is killed', () => {
  const repo = scenario({ limit: 20, a: { 'A.txt': 'top\n' + A12 }, b: { 'A.txt': A12 + 'bottom\n' } });
  const out = path.join(tmp(), 'out.json');
  execFileSync('node', [SCRIPT, '--min-free-gib', '0.01', '--repo', repo, '--test', 'sleep 30', '--timeout', '1', '--out', out], { encoding: 'utf8' });
  const g = JSON.parse(fs.readFileSync(out, 'utf8')).groups.clean;
  assert.deepEqual([g.pairs, g.timeout], [1, 1]);
});

test('--cache: a second run runs no test again, and --since filters the pairs', () => {
  const repo = scenario({ a: { 'A.txt': 'top\n' + A12 }, b: { 'A.txt': A12 + 'bottom\n' } });
  const cache = path.join(tmp(), 'cache.json');
  const first = run(repo, ['--cache', cache]).result;
  assert.ok(first.testRuns >= 3);
  const second = run(repo, ['--cache', cache]).result;
  assert.equal(second.testRuns, 0);
  assert.equal(second.groups.clean.semanticCases.length, 1);
  assert.equal(second.groups.clean.semantic, 1);
  assert.equal(run(repo, ['--since', '2030-01-01']).result.groups.clean.pairs, 0);
  for (const bad of ['1970-01-01', '2999-01-01', 'yesterday', '2024-1-1']) {
    assert.throws(() => execFileSync('node', [SCRIPT, '--min-free-gib', '0.01', '--repo', repo, '--test', 'true', '--since', bad], { encoding: 'utf8', stdio: 'pipe' }), /--since must be a date/, bad);
  }
});

test('the test runs with a minimal environment: no variable of the caller reaches it', () => {
  const repo = scenario({ limit: 20, a: { 'A.txt': 'top\n' + A12 }, b: { 'A.txt': A12 + 'bottom\n' } });
  const out = path.join(tmp(), 'out.json');
  execFileSync('node', [SCRIPT, '--min-free-gib', '0.01', '--repo', repo, '--test', '[ -z "$SEMANTIC_TEST_SECRET" ]', '--out', out], { encoding: 'utf8', env: { ...process.env, SEMANTIC_TEST_SECRET: 'leak' } });
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).groups.clean.ok, 1);
});

test('flaky: the merged tree fails once and passes on the rerun, so it is not a semantic conflict', () => {
  const repo = scenario({ limit: 20, a: { 'A.txt': 'top\n' + A12 }, b: { 'A.txt': A12 + 'bottom\n' } });
  const flag = path.join(tmp(), 'flag');
  const out = path.join(tmp(), 'out.json');
  // the first run (the merged tree) creates the flag and fails; every later run passes
  execFileSync('node', [SCRIPT, '--min-free-gib', '0.01', '--repo', repo, '--test', `[ -f ${flag} ] || { touch ${flag}; exit 1; }`, '--out', out], { encoding: 'utf8' });
  const g = JSON.parse(fs.readFileSync(out, 'utf8')).groups.clean;
  assert.deepEqual([g.pairs, g.flaky, g.semantic, g.ok], [1, 1, 0, 0]);
  assert.equal(g.judged, 0);
});

test('a timeout kills the whole process group: a background child does not outlive it', async () => {
  const repo = scenario({ limit: 20, a: { 'A.txt': 'top\n' + A12 }, b: { 'A.txt': A12 + 'bottom\n' } });
  const marker = path.join(tmp(), 'marker');
  const out = path.join(tmp(), 'out.json');
  execFileSync('node', [SCRIPT, '--min-free-gib', '0.01', '--repo', repo, '--test', `(sleep 3; touch ${marker}) & sleep 30`, '--timeout', '1', '--out', out], { encoding: 'utf8' });
  await new Promise((r) => setTimeout(r, 4000));
  assert.equal(fs.existsSync(marker), false);
});

test('--workdir may be a directory that does not exist yet', () => {
  const repo = scenario({ limit: 20, a: { 'A.txt': 'top\n' + A12 }, b: { 'A.txt': A12 + 'bottom\n' } });
  const workdir = path.join(tmp(), 'new', 'nested');
  assert.equal(run(repo, ['--workdir', workdir]).result.groups.clean.ok, 1);
  assert.deepEqual(fs.readdirSync(workdir), []); // the worktrees are removed after each test
});

test('--min-free-gib: the run stops, with a message, when less disk is free than required', () => {
  const repo = scenario({ limit: 20, a: { 'A.txt': 'top\n' + A12 }, b: { 'A.txt': A12 + 'bottom\n' } });
  assert.throws(() => execFileSync('node', [SCRIPT, '--repo', repo, '--test', 'true', '--min-free-gib', '100000'], { encoding: 'utf8', stdio: 'pipe' }), /of disk free: stopping/);
});

test('a work directory the run made itself is removed when it ends', () => {
  const repo = scenario({ limit: 20, a: { 'A.txt': 'top\n' + A12 }, b: { 'A.txt': A12 + 'bottom\n' } });
  const before = new Set(fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('semantic-replay-')));
  run(repo);
  const after = fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('semantic-replay-') && !before.has(d));
  assert.deepEqual(after, []);
});

test('the result records the repository head, git version, test command and the environment note', () => {
  const repo = scenario({ limit: 20, a: { 'A.txt': 'top\n' + A12 }, b: { 'A.txt': A12 + 'bottom\n' } });
  const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const { result } = run(repo, ['--env-note', 'python 3.12, pytest 9']);
  assert.equal(result.repo.head, head);
  assert.equal(result.repo.remote, null); // a repository without a remote
  assert.match(result.git, /^git version /);
  assert.equal(result.envNote, 'python 3.12, pytest 9');
  assert.equal(result.testCommand, TEST_CMD);
  assert.equal(run(repo).result.envNote, null);
});

test('wilson: interval around the observed rate, [0, 1] with no trials', () => {
  assert.deepEqual(wilson(0, 0), [0, 1]);
  const [lo, hi] = wilson(5, 100);
  assert.ok(lo > 0.02 && lo < 0.05 && hi > 0.05 && hi < 0.12, `${lo} ${hi}`);
  assert.equal(wilson(0, 50)[0], 0);
  assert.ok(wilson(50, 50)[1] <= 1);
});
