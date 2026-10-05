#!/usr/bin/env node
// Replay concurrent work and compare the merge queue's conflict rule with a 3-way merge.
//
// For each pair of concurrent changes this script asks: do the two sides touch a common path (the rule of
// docs/SPEC.md §8, step 3: the patch becomes `stale`), and if so, does `git merge-tree` still merge them without
// conflict (what a hunk-level rule would accept)? Only SHAs and counts are written: the code stays in the public
// repositories, and the script regenerates everything from them.
//
// Two sources of pairs:
//   history  every two-parent merge commit of a clone joins two branches developed concurrently from their
//            merge-base (default);
//   manifest the branches an agent-replay run produced from one base commit: every pair of committed tasks.
//
// Caveats: merge commits miss squash and rebase workflows (the conflict was resolved before the merge), so
// conflicts are under-counted; a clean textual merge can still be semantically wrong (the composed-tree test
// run is the guard for that).
//
//   node scripts/conflict-replay.mjs --repo <clone> [--repo <clone> ...] [--big 200] [--out file.json] [--pairs file.jsonl]
//   node scripts/conflict-replay.mjs --repo <clone> --manifest <agent-replay manifest.json> [--out file.json] [--pairs file.jsonl]
//   node scripts/conflict-replay.mjs --human-only --manifest <manifest or tasks.json> [--out file.json]   (no repository)
//
// --big N: also report the figures without pairs where either side changes more than N paths (release
// syncs and vendoring merges are not what an agent patch looks like).
import fs from 'node:fs';
import path from 'node:path';
import { DIVERGENCE_BUCKETS, HOT, divergenceBucket, footprintSummary, git, lines, pairVerdict, sharedPathPairs } from './lib/replay.mjs';

const args = process.argv.slice(2);
const all = (n) => args.flatMap((a, i) => (a === `--${n}` ? [args[i + 1]] : []));
const flag = (n) => args.includes(`--${n}`);
const arg = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const REPOS = all('repo');
const BIG = Number(arg('big', '200'));
const OUT = arg('out');
const PAIRS = arg('pairs');
const MANIFESTS = all('manifest'); // one or more agent-replay manifests of the same base (a run split over several days by the neuron budget)
const MANIFEST = MANIFESTS.length > 0;
const HUMAN_ONLY = flag('human-only'); // only the footprint of the human pull requests of a manifest or a tasks file: no repository, no branches
if ((REPOS.length === 0 && !HUMAN_ONLY) || (HUMAN_ONLY && !MANIFEST) || (MANIFEST && REPOS.length > 1)) {
  console.error('usage: node scripts/conflict-replay.mjs --repo <clone> [--repo ...] [--big N] [--out f.json] [--pairs f.jsonl]\n       node scripts/conflict-replay.mjs --repo <clone> --manifest <manifest.json> [--out f.json] [--pairs f.jsonl]');
  process.exit(2);
}

const emptyCounts = () => ({ pairs: 0, disjoint: 0, overlap: 0, overlapClean: 0, overlapConflict: 0, conflictOnlyHotFiles: 0 });
const pct = (a, b) => (b === 0 ? null : Math.round((1000 * a) / b) / 10);
const summarize = (c) => ({
  ...c,
  fileLevelRejectPct: pct(c.overlap, c.pairs),
  hunkLevelRejectPct: pct(c.overlapConflict, c.pairs),
  overlapMergingCleanPct: pct(c.overlapClean, c.overlap),
  hunkLevelRejectExcludingHotFilesPct: pct(c.overlapConflict - c.conflictOnlyHotFiles, c.pairs),
});

/** The tasks of every manifest, which must share one base commit. */
function loadManifests() {
  const ms = MANIFESTS.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
  const bases = new Set(ms.map((m) => m.base));
  if (bases.size !== 1) {
    console.error(`the manifests do not share one base commit: ${[...bases].join(', ')}`);
    process.exit(2);
  }
  // A task may appear in several manifests (stopped by the budget in one, done in the next): the committed one wins.
  const byId = new Map();
  for (const t of ms.flatMap((m) => m.tasks)) {
    const prev = byId.get(t.id);
    if (!prev || (prev.status !== 'committed' && t.status === 'committed')) byId.set(t.id, t);
  }
  const tasks = [...byId.values()];
  return { base: ms[0].base, tasks };
}

/** Yield {meta, verdict} for every concurrent pair of a repository. */
function* pairsOf(repo) {
  if (MANIFEST) {
    const m = loadManifests();
    const done = m.tasks.filter((t) => t.status === 'committed' && t.sha);
    for (let i = 0; i < done.length; i++) {
      for (let j = i + 1; j < done.length; j++) {
        yield { meta: { tasks: [done[i].id, done[j].id], a: done[i].sha, b: done[j].sha }, v: pairVerdict(repo, done[i].sha, done[j].sha, m.base) };
      }
    }
    return;
  }
  for (const line of lines(git(repo, ['rev-list', '--merges', '--parents', 'HEAD']).out)) {
    const [merge, a, b, ...rest] = line.split(' ');
    if (!a || !b || rest.length > 0) continue; // two-parent merges only
    yield { meta: { merge, a, b }, v: pairVerdict(repo, a, b) };
  }
}

/** The human pull requests that closed the same tasks: how often do their pairs share a file? (the footprint the agents are compared with) */
function humanBaseline() {
  const m = loadManifests();
  const humanOf = (t) => t.humanFiles ?? t.pr?.files; // a manifest, or the tasks file of agent-replay
  const withHuman = (ts) => ts.filter((t) => Array.isArray(humanOf(t))).map(humanOf);
  const row = (sets) => {
    const [all, pairs] = sharedPathPairs(sets);
    const [noHot] = sharedPathPairs(sets, HOT);
    return { patches: sets.length, pairs, pairsSharingFile: all, pairsSharingFileExcludingHotFiles: noHot, medianFilesPerPatch: sets.length ? [...sets].map((x) => x.length).sort((x, y) => x - y)[Math.floor(sets.length / 2)] : null };
  };
  return { agentFootprint: footprintSummary(m.tasks), allTasks: row(withHuman(m.tasks)), sameTasksAsCommittedAgentPatches: row(withHuman(m.tasks.filter((t) => t.status === 'committed'))) };
}

if (HUMAN_ONLY) {
  const h = humanBaseline();
  const result = { date: new Date().toISOString().slice(0, 10), what: 'Footprint of the pull requests that closed the tasks: how often do two of them share a file', humanBaseline: { allTasks: h.allTasks } };
  if (arg('out')) fs.writeFileSync(arg('out'), `${JSON.stringify(result, null, 2)}\n`);
  const a = h.allTasks;
  console.log(`human PRs: ${a.pairsSharingFile}/${a.pairs} pairs share a file (${a.pairsSharingFileExcludingHotFiles} without hot files), median ${a.medianFilesPerPatch} files per PR, ${a.patches} PRs`);
  process.exit(0);
}

const pairsOut = PAIRS ? fs.createWriteStream(PAIRS) : null;
const perRepo = {};
const conflictPaths = new Map();
// Rejections by how far the two sides had diverged: a patch of an agent lives minutes, a human branch days.
const byDivergence = Object.fromEntries(DIVERGENCE_BUCKETS.map((b) => [b, { pairs: 0, overlap: 0, overlapConflict: 0 }]));
const total = { all: emptyCounts(), excludingBig: emptyCounts() };

for (const repo of REPOS) {
  const name = path.basename(path.resolve(repo));
  const remote = git(repo, ['config', '--get', 'remote.origin.url'], [0, 1]).out.trim();
  const counts = { all: emptyCounts(), excludingBig: emptyCounts() };
  for (const { meta, v } of pairsOf(repo)) {
    if (v.verdict === 'empty') continue;
    const onlyHot = v.conflicted.length > 0 && v.conflicted.every((f) => HOT.test(f));
    const big = v.sidePaths.some((n) => n > BIG);
    for (const [k, on] of [['all', true], ['excludingBig', !big]]) {
      if (!on) continue;
      const c = counts[k];
      c.pairs++;
      if (v.verdict === 'disjoint') c.disjoint++;
      else {
        c.overlap++;
        if (v.verdict === 'clean') c.overlapClean++;
        else {
          c.overlapConflict++;
          if (onlyHot) c.conflictOnlyHotFiles++;
        }
      }
    }
    const commitsOf = (x) => Number(git(repo, ['rev-list', '--count', `${v.base}..${x}`]).out.trim());
    const bucket = byDivergence[divergenceBucket(Math.max(commitsOf(meta.a), commitsOf(meta.b)))];
    bucket.pairs++;
    if (v.verdict !== 'disjoint') bucket.overlap++;
    if (v.verdict === 'conflict') bucket.overlapConflict++;
    for (const f of v.conflicted) conflictPaths.set(f, (conflictPaths.get(f) ?? 0) + 1);
    pairsOut?.write(`${JSON.stringify({ repo: name, ...meta, base: v.base, sidePaths: v.sidePaths, commonPaths: v.common.length, verdict: v.verdict, conflicted: v.conflicted, big })}\n`);
  }
  perRepo[name] = { remote, all: summarize(counts.all), excludingBig: summarize(counts.excludingBig) };
  for (const k of ['all', 'excludingBig']) for (const f of Object.keys(emptyCounts())) total[k][f] += counts[k][f];
}
pairsOut?.end();

const result = {
  date: new Date().toISOString().slice(0, 10),
  what: MANIFEST
    ? 'File-level conflict rule (current merge queue) vs hunk-level (git merge-tree) on the branches of an agent-replay run, all from one base commit'
    : 'File-level conflict rule (current merge queue) vs hunk-level (git merge-tree) on concurrent branches taken from two-parent merge commits',
  git: git(REPOS[0], ['--version']).out.trim(),
  bigThreshold: BIG,
  total: { all: summarize(total.all), excludingBig: summarize(total.excludingBig) },
  byDivergence: Object.fromEntries(Object.entries(byDivergence).map(([k, b]) => [k, { ...b, fileLevelRejectPct: pct(b.overlap, b.pairs), hunkLevelRejectPct: pct(b.overlapConflict, b.pairs) }])),
  ...(MANIFEST ? { humanBaseline: humanBaseline() } : {}),
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
if (result.humanBaseline) {
  const h = result.humanBaseline;
  const f = h.agentFootprint;
  console.log(`agent: ${f.committed}/${f.tasks} patches, median ${f.medianFilesPerAgentPatch} file(s) per patch (human PRs: ${f.medianFilesPerHumanPr}); read ${f.selection.readByAgent}/${f.selection.humanSourceFiles} of the human source files; edited files: ${Object.entries(f.editedFiles).slice(0, 4).map(([k, v]) => `${k} (${v})`).join(', ')}`);
  console.log(`human PRs, same tasks: ${h.allTasks.pairsSharingFile}/${h.allTasks.pairs} pairs share a file (${h.allTasks.pairsSharingFileExcludingHotFiles} without hot files), median ${h.allTasks.medianFilesPerPatch} files per PR | for the committed agent patches only: ${h.sameTasksAsCommittedAgentPatches.pairsSharingFile}/${h.sameTasksAsCommittedAgentPatches.pairs} (${h.sameTasksAsCommittedAgentPatches.pairsSharingFileExcludingHotFiles} without hot files)`);
}
console.log(`by commits on the longer side: ${Object.entries(result.byDivergence).map(([k, b]) => `${k}: ${b.pairs} pairs, file ${b.fileLevelRejectPct}% / hunk ${b.hunkLevelRejectPct}%`).join(' | ')}`);
console.log('most conflicted paths:', result.topConflictPaths.slice(0, 6).map((t) => `${t.file} (${t.pairs})`).join(', '));
