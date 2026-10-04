#!/usr/bin/env node
// How often would the merge queue's file-level rule reject a patch, as a function of how many other patches land
// while it is being made? A patch is rejected when a file it touches was touched by any of the k patches that
// landed before it (docs/SPEC.md §8: the files changed on main since its base), so the rate grows with k, which
// is roughly (number of agents) × (time from claim to merge round) / (time to make a patch).
//
// The stream is the non-merge commits of a repository in history order, each taken as one patch. Caveat: the
// commits of one pull request or one author's series follow each other and share files without being concurrent,
// so the low-k end overstates concurrency; the growth with k is what this shows. Commits that touch more than
// --big paths are not counted as patches (mass renames, vendoring); --hot-files variant sets aside dependency,
// version and changelog files.
//
//   node scripts/stream-replay.mjs --repo <clone> [--repo ...] [--commits 2500] [--window 1,2,4,8,16] [--big 50] [--out f.json]
import fs from 'node:fs';
import path from 'node:path';
import { HOT, git, streamRejects } from './lib/replay.mjs';

const args = process.argv.slice(2);
const all = (n) => args.flatMap((a, i) => (a === `--${n}` ? [args[i + 1]] : []));
const arg = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const REPOS = all('repo');
const COMMITS = Number(arg('commits', '2500'));
const WINDOWS = arg('window', '1,2,4,8,16').split(',').map(Number);
const BIG = Number(arg('big', '50'));
const OUT = arg('out');
if (REPOS.length === 0 || WINDOWS.some((k) => !Number.isInteger(k) || k < 1)) {
  console.error('usage: node scripts/stream-replay.mjs --repo <clone> [--repo ...] [--commits N] [--window 1,2,4,8,16] [--big N] [--out f.json]');
  process.exit(2);
}

/** Path sets of the last `n` non-merge commits, oldest first (commits that change no path are dropped). */
function stream(repo, n) {
  const sets = [];
  let cur = null;
  for (const l of git(repo, ['log', '--no-merges', '--reverse', '-n', String(n), '--format=@@%H', '--name-only']).out.split('\n')) {
    if (l.startsWith('@@')) {
      cur = [];
      sets.push(cur);
    } else if (l && cur) cur.push(l);
  }
  return sets.filter((s) => s.length > 0);
}

const pct = (a, b) => (b === 0 ? null : Math.round((1000 * a) / b) / 10);
const variants = { allFiles: undefined, withoutHotFiles: HOT };
const total = Object.fromEntries(Object.keys(variants).map((v) => [v, Object.fromEntries(WINDOWS.map((k) => [k, { rejected: 0, n: 0 }]))]));
const repos = {};
for (const repo of REPOS) {
  const name = path.basename(path.resolve(repo));
  const sets = stream(repo, COMMITS);
  repos[name] = { commits: sets.length };
  for (const [v, hot] of Object.entries(variants)) {
    repos[name][v] = {};
    for (const k of WINDOWS) {
      const r = streamRejects(sets, k, { hot, big: BIG });
      repos[name][v][k] = { ...r, rejectPct: pct(r.rejected, r.n) };
      total[v][k].rejected += r.rejected;
      total[v][k].n += r.n;
    }
  }
}
const result = {
  date: new Date().toISOString().slice(0, 10),
  what: 'File-level rejection of a patch vs the number k of patches that landed during its window, on the non-merge commits of each repository taken as a stream',
  commitsPerRepo: COMMITS,
  bigThreshold: BIG,
  windows: WINDOWS,
  total: Object.fromEntries(Object.entries(total).map(([v, byK]) => [v, Object.fromEntries(Object.entries(byK).map(([k, r]) => [k, { ...r, rejectPct: pct(r.rejected, r.n) }]))])),
  repos,
};
if (OUT) fs.writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`);
console.log(`landings during the patch window k:${WINDOWS.map((k) => String(k).padStart(8)).join('')}`);
for (const v of Object.keys(variants)) console.log(`${v.padEnd(34)}${WINDOWS.map((k) => `${result.total[v][k].rejectPct}%`.padStart(8)).join('')}   (${result.total[v][WINDOWS[0]].n} patches)`);
for (const [name, r] of Object.entries(repos)) console.log(`  ${name.padEnd(14)} without hot files:${WINDOWS.map((k) => `${r.withoutHotFiles[k].rejectPct}%`.padStart(8)).join('')}`);
