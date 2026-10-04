#!/usr/bin/env node
// Replay concurrent work from real history and compare the merge queue's conflict rule with a 3-way merge.
//
// Every two-parent merge commit joins two branches that were developed concurrently from their merge-base.
// For each such pair this script asks: do the two sides touch a common path (the rule of docs/SPEC.md §8,
// step 3: the patch becomes `stale`), and if so, does `git merge-tree` still merge them without conflict
// (what a hunk-level rule would accept)? Only SHAs and counts are written: the code stays in the public
// repositories, and the script regenerates everything from them.
//
// Caveats: merge commits miss squash and rebase workflows (the conflict was resolved before the merge), so
// conflicts are under-counted; the patches are human, not agent, patches; a clean textual merge can still be
// semantically wrong (the composed-tree test run is the guard for that).
//
//   node scripts/conflict-replay.mjs --repo <clone> [--repo <clone> ...] [--big 200] [--out file.json] [--pairs file.jsonl]
//
// --big N: also report the figures without pairs where either side changes more than N paths (release
// syncs and vendoring merges are not what an agent patch looks like).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const all = (n) => args.flatMap((a, i) => (a === `--${n}` ? [args[i + 1]] : []));
const arg = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const REPOS = all('repo');
const BIG = Number(arg('big', '200'));
const OUT = arg('out');
const PAIRS = arg('pairs');
if (REPOS.length === 0) {
  console.error('usage: node scripts/conflict-replay.mjs --repo <clone> [--repo ...] [--big N] [--out f.json] [--pairs f.jsonl]');
  process.exit(2);
}

const run = (repo, argv, ok = [0]) => {
  try {
    return { code: 0, out: execFileSync('git', ['-C', repo, ...argv], { encoding: 'utf8', maxBuffer: 256 << 20, stdio: ['ignore', 'pipe', 'ignore'] }) };
  } catch (e) {
    if (typeof e.status === 'number' && ok.includes(e.status)) return { code: e.status, out: String(e.stdout ?? '') };
    throw e;
  }
};
const lines = (s) => s.split('\n').filter(Boolean);

// Files that every concurrent change tends to touch (dependency lists, version bumps, changelogs): a conflict
// confined to them is a different problem from a conflict in source or tests.
const HOT = /(^|\/)(package(-lock)?\.json|yarn\.lock|history\.md|changes(\.rst)?|changelog[^/]*|news[^/]*|authors[^/]*|__init__\.py|setup\.py|pyproject\.toml|version[^/]*)$/i;

const emptyCounts = () => ({ pairs: 0, disjoint: 0, overlap: 0, overlapClean: 0, overlapConflict: 0, conflictOnlyHotFiles: 0 });
const pct = (a, b) => (b === 0 ? null : Math.round((1000 * a) / b) / 10);
const summarize = (c) => ({
  ...c,
  fileLevelRejectPct: pct(c.overlap, c.pairs),
  hunkLevelRejectPct: pct(c.overlapConflict, c.pairs),
  overlapMergingCleanPct: pct(c.overlapClean, c.overlap),
  hunkLevelRejectExcludingHotFilesPct: pct(c.overlapConflict - c.conflictOnlyHotFiles, c.pairs),
});

const pairsOut = PAIRS ? fs.createWriteStream(PAIRS) : null;
const perRepo = {};
const conflictPaths = new Map();
const total = { all: emptyCounts(), excludingBig: emptyCounts() };

for (const repo of REPOS) {
  const name = path.basename(path.resolve(repo));
  const remote = run(repo, ['config', '--get', 'remote.origin.url'], [0, 1]).out.trim();
  const counts = { all: emptyCounts(), excludingBig: emptyCounts() };
  for (const line of lines(run(repo, ['rev-list', '--merges', '--parents', 'HEAD']).out)) {
    const [merge, a, b, ...rest] = line.split(' ');
    if (!a || !b || rest.length > 0) continue; // two-parent merges only
    const base = run(repo, ['merge-base', a, b], [0, 1]).out.trim();
    if (!base) continue;
    const fa = new Set(lines(run(repo, ['diff', '--name-only', '--no-renames', base, a]).out));
    const fb = new Set(lines(run(repo, ['diff', '--name-only', '--no-renames', base, b]).out));
    if (fa.size === 0 || fb.size === 0) continue;
    const common = [...fa].filter((p) => fb.has(p));
    let verdict = 'disjoint';
    let conflicted = [];
    if (common.length > 0) {
      const r = run(repo, ['merge-tree', '--write-tree', '--name-only', '--no-messages', a, b], [0, 1]);
      verdict = r.code === 0 ? 'clean' : 'conflict';
      if (r.code !== 0) conflicted = lines(r.out.split('\n\n')[0]).slice(1); // first line is the tree id
    }
    const onlyHot = conflicted.length > 0 && conflicted.every((f) => HOT.test(f));
    const big = fa.size > BIG || fb.size > BIG;
    for (const [k, on] of [['all', true], ['excludingBig', !big]]) {
      if (!on) continue;
      const c = counts[k];
      c.pairs++;
      if (verdict === 'disjoint') c.disjoint++;
      else {
        c.overlap++;
        if (verdict === 'clean') c.overlapClean++;
        else {
          c.overlapConflict++;
          if (onlyHot) c.conflictOnlyHotFiles++;
        }
      }
    }
    for (const f of conflicted) conflictPaths.set(f, (conflictPaths.get(f) ?? 0) + 1);
    pairsOut?.write(`${JSON.stringify({ repo: name, merge, a, b, base, sidePaths: [fa.size, fb.size], commonPaths: common.length, verdict, conflicted, big })}\n`);
  }
  perRepo[name] = { remote, all: summarize(counts.all), excludingBig: summarize(counts.excludingBig) };
  for (const k of ['all', 'excludingBig']) for (const f of Object.keys(emptyCounts())) total[k][f] += counts[k][f];
}
pairsOut?.end();

const result = {
  date: new Date().toISOString().slice(0, 10),
  what: 'File-level conflict rule (current merge queue) vs hunk-level (git merge-tree) on concurrent branches taken from two-parent merge commits',
  git: run(REPOS[0], ['--version']).out.trim(),
  bigThreshold: BIG,
  total: { all: summarize(total.all), excludingBig: summarize(total.excludingBig) },
  topConflictPaths: [...conflictPaths].sort((x, y) => y[1] - x[1]).slice(0, 15).map(([file, pairs]) => ({ file, pairs })),
  repos: perRepo,
};
if (OUT) fs.writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`);
for (const [n, r] of Object.entries(perRepo)) {
  const c = r.all;
  console.log(`${n.padEnd(14)} pairs=${String(c.pairs).padStart(5)} overlap=${String(c.overlap).padStart(4)} clean@hunk=${String(c.overlapClean).padStart(4)} conflict@hunk=${String(c.overlapConflict).padStart(4)}`);
}
for (const k of ['all', 'excludingBig']) {
  const c = result.total[k];
  console.log(`${`TOTAL ${k}`.padEnd(22)} pairs=${c.pairs} file-level rejects ${c.fileLevelRejectPct}% | hunk-level rejects ${c.hunkLevelRejectPct}% (${c.hunkLevelRejectExcludingHotFilesPct}% if conflicts confined to hot files are set aside) | overlap merging clean ${c.overlapMergingCleanPct}%`);
}
console.log('most conflicted paths:', result.topConflictPaths.slice(0, 6).map((t) => `${t.file} (${t.pairs})`).join(', '));
