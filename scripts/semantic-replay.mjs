#!/usr/bin/env node
// Do textually clean merges of real concurrent work pass the repository's tests? (the risk of a hunk-level merge:
// issue #2). Every two-parent merge commit joins two branches developed concurrently. For the pairs that share a
// path but that `git merge-tree` merges without conflict ("clean": the file-level rule of docs/SPEC.md §8 rejects
// them, a hunk-level rule would accept them), this script builds the merged tree, runs the repository's test
// command on it, and classifies the outcome:
//
//   ok           the merged tree passes
//   semantic     it fails, both parents pass alone, and it fails again on a rerun: a semantic conflict
//   preexisting  it fails and a parent fails alone too (environment, old dependencies, a broken commit)
//   flaky        it failed once and passed on the rerun
//   timeout      the merged tree timed out
//
// A control group of disjoint pairs (no common path: both rules accept them) goes through the same steps, so the
// semantic rate of clean-but-overlapping merges can be read against the baseline of merges any rule accepts.
//
//   node scripts/semantic-replay.mjs --repo <clone> --test "PYTHONPATH=src python -m pytest -q" --path-prepend <venv/bin>
//       [--since 2024-01-01] [--max 200] [--control 200] [--timeout 300] [--workdir dir] [--min-free-gib 1.5] [--cache f.json] [--out f.json]
//
// The test command runs with `sh -c` in a detached worktree of each commit, with a minimal environment (HOME,
// PATH = --path-prepend + /usr/bin:/bin, LANG): no credentials of the caller reach the repository's code. It
// executes code of the repository under test: use it on repositories you trust. It stops when less than
// --min-free-gib (default 1.5) of disk is free.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git, lines, pairVerdict, wilson } from './lib/replay.mjs';

const args = process.argv.slice(2);
const arg = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const REPO = arg('repo');
const TEST = arg('test');
if (!REPO || !TEST) {
  console.error('usage: node scripts/semantic-replay.mjs --repo <clone> --test "<command>" [--path-prepend dir] [--since date] [--max N] [--control N] [--timeout s] [--workdir dir] [--min-free-gib G] [--cache f.json] [--out f.json]');
  process.exit(2);
}
const SINCE = arg('since'); // a date; without it every merge of the history (git reads `--since=1970-01-01` as no commits at all)
if (SINCE !== undefined && !(/^\d{4}-\d{2}-\d{2}$/.test(SINCE) && Number(SINCE.slice(0, 4)) >= 1971 && Number(SINCE.slice(0, 4)) <= 2100)) {
  console.error('--since must be a date as YYYY-MM-DD, from 1971 to 2100 (git ignores or empties --since outside that range)');
  process.exit(2);
}
const MAX = Number(arg('max', '200'));
const CONTROL = Number(arg('control', '200'));
const TIMEOUT_MS = Number(arg('timeout', '300')) * 1000;
const PATH_PREPEND = arg('path-prepend');
const OUT = arg('out');
const CACHE = arg('cache');
const AUTO_WORKDIR = arg('workdir') === undefined;
const WORKDIR = arg('workdir', fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-replay-')));
fs.mkdirSync(WORKDIR, { recursive: true });
if (AUTO_WORKDIR) process.on('exit', () => fs.rmSync(WORKDIR, { recursive: true, force: true })); // a directory this run made itself
const MIN_FREE = Number(arg('min-free-gib', '1.5')) * 2 ** 30;

const cache = CACHE && fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : {};
let testRuns = 0;

const freeBytes = () => {
  const s = fs.statfsSync(WORKDIR);
  return s.bavail * s.bsize;
};

/** Run the test command in a worktree of `sha`. Resolves {status: pass|fail|timeout, ms, tail}. Cached by sha. */
async function testAt(sha) {
  if (cache[sha]) return cache[sha];
  if (freeBytes() < MIN_FREE) throw new Error(`less than ${MIN_FREE / 2 ** 30} GiB of disk free: stopping`);
  const dir = path.join(WORKDIR, sha.slice(0, 12));
  git(REPO, ['worktree', 'add', '--detach', '--force', dir, sha]);
  try {
    const env = { HOME: os.tmpdir(), PATH: `${PATH_PREPEND ? `${PATH_PREPEND}:` : ''}/usr/bin:/bin`, LANG: 'en_US.UTF-8', PYTHONDONTWRITEBYTECODE: '1' };
    const t0 = Date.now();
    const result = await new Promise((resolve) => {
      const child = spawn('sh', ['-c', TEST], { cwd: dir, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      const keep = (b) => (out = (out + b).slice(-1500));
      child.stdout.on('data', keep);
      child.stderr.on('data', keep);
      const timer = setTimeout(() => {
        try {
          process.kill(-child.pid, 'SIGKILL'); // the whole process group: the test command spawns children
        } catch {
          /* already gone */
        }
        resolve({ status: 'timeout', ms: Date.now() - t0, tail: out.slice(-400) });
      }, TIMEOUT_MS);
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ status: code === 0 ? 'pass' : 'fail', ms: Date.now() - t0, tail: code === 0 ? '' : out.slice(-400) });
      });
    });
    testRuns++;
    cache[sha] = result;
    if (CACHE) fs.writeFileSync(CACHE, JSON.stringify(cache));
    return result;
  } finally {
    git(REPO, ['worktree', 'remove', '--force', dir], [0, 128]);
  }
}

/** The tree `git merge-tree` produces for a and b, as a commit with both as parents. */
function mergedCommit(a, b) {
  const r = git(REPO, ['merge-tree', '--write-tree', a, b], [0, 1]);
  if (r.code !== 0) return null;
  const tree = r.out.split('\n')[0].trim();
  const env = { ...process.env, GIT_AUTHOR_NAME: 'semantic-replay', GIT_AUTHOR_EMAIL: 'semantic-replay@invalid', GIT_COMMITTER_NAME: 'semantic-replay', GIT_COMMITTER_EMAIL: 'semantic-replay@invalid', GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' };
  return git(REPO, ['commit-tree', tree, '-p', a, '-p', b, '-m', 'semantic-replay merge'], [0], { env }).out.trim();
}

/** ok | semantic | preexisting | flaky | timeout for one pair. */
async function classify(a, b) {
  const key = `pair:${a}:${b}`;
  if (cache[key]) return cache[key]; // the final outcome of a pair is cached too: a rerun (or a resume after a crash) costs no test
  const r = await classifyUncached(a, b);
  cache[key] = r;
  if (CACHE) fs.writeFileSync(CACHE, JSON.stringify(cache));
  return r;
}

async function classifyUncached(a, b) {
  const m = mergedCommit(a, b);
  if (!m) return { outcome: 'skipped' };
  const first = await testAt(m);
  if (first.status === 'pass') return { outcome: 'ok', merged: m };
  if (first.status === 'timeout') return { outcome: 'timeout', merged: m };
  const [ra, rb] = [await testAt(a), await testAt(b)];
  if (ra.status !== 'pass' || rb.status !== 'pass') return { outcome: 'preexisting', merged: m, parents: [ra.status, rb.status] };
  delete cache[m]; // rerun the merged tree once: a flaky failure is not a semantic conflict
  const again = await testAt(m);
  if (again.status === 'pass') return { outcome: 'flaky', merged: m };
  return { outcome: 'semantic', merged: m, tail: first.tail };
}

// ─── pairs ──────────────────────────────────────────────────────────────────

const candidates = [];
const controls = [];
for (const line of lines(git(REPO, ['log', '--merges', '--parents', ...(SINCE ? [`--since=${SINCE}`] : []), '--format=%H %P']).out)) {
  const [merge, a, b, ...rest] = line.split(' ');
  if (!a || !b || rest.length > 0) continue;
  const v = pairVerdict(REPO, a, b);
  if (v.verdict === 'clean') candidates.push({ merge, a, b });
  else if (v.verdict === 'disjoint') controls.push({ merge, a, b });
}
const evenly = (xs, n) => (xs.length <= n ? xs : Array.from({ length: n }, (_, i) => xs[Math.floor((i * xs.length) / n)]));
const groups = { clean: evenly(candidates, MAX), disjoint: evenly(controls, CONTROL) };
console.log(`pairs${SINCE ? ` since ${SINCE}` : ''}: ${candidates.length} clean-but-overlapping (testing ${groups.clean.length}), ${controls.length} disjoint (control, testing ${groups.disjoint.length})`);

const result = { date: new Date().toISOString().slice(0, 10), what: 'Tests on the merged tree of concurrent pairs from two-parent merge commits: clean-but-overlapping pairs vs disjoint control', since: SINCE ?? null, testCommand: TEST, timeoutSec: TIMEOUT_MS / 1000, groups: {} };
for (const [name, pairs] of Object.entries(groups)) {
  const counts = { pairs: 0, ok: 0, semantic: 0, preexisting: 0, flaky: 0, timeout: 0, skipped: 0 };
  const semantic = [];
  for (const p of pairs) {
    const r = await classify(p.a, p.b);
    counts.pairs++;
    counts[r.outcome]++;
    if (r.outcome === 'semantic') semantic.push({ merge: p.merge, a: p.a, b: p.b, failureTail: r.tail });
    if (counts.pairs % 10 === 0) console.log(`  ${name}: ${counts.pairs}/${pairs.length} ${JSON.stringify(counts)}`);
  }
  const judged = counts.ok + counts.semantic; // pairs whose parents pass and whose merged result was decided
  const [lo, hi] = wilson(counts.semantic, judged);
  result.groups[name] = { ...counts, judged, semanticRatePct: judged ? Math.round((1000 * counts.semantic) / judged) / 10 : null, semanticRate95CiPct: judged ? [Math.round(lo * 1000) / 10, Math.round(hi * 1000) / 10] : null, semanticCases: semantic };
}
result.testRuns = testRuns;
if (OUT) fs.writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`);
for (const [name, g] of Object.entries(result.groups)) console.log(`${name.padEnd(9)} pairs=${g.pairs} ok=${g.ok} semantic=${g.semantic} preexisting=${g.preexisting} flaky=${g.flaky} timeout=${g.timeout} → semantic rate ${g.semanticRatePct ?? 'n/a'}% of ${g.judged} judged (95% CI ${g.semanticRate95CiPct ? `${g.semanticRate95CiPct.join('–')}%` : 'n/a'})`);
