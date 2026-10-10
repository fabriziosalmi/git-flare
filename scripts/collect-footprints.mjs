#!/usr/bin/env node
// A population of DISTINCT human footprints for the no-replacement check of G1 (docs/spikes/hunk-merge-2026-10-04.md §13): the
// reference cell draws 60 tasks from the 7-12 footprints of the issue-linked pull requests, so every footprint recurs 5-8 times.
// Here the footprints are those of ALL merged pull requests of the same window, by a rule fixed before any count was seen:
//
//   merged in [since, until] of the repository's tasks file; author not a bot; between 1 and 30 files (more is not a task);
//   a file set already taken is skipped (distinct); the 60 most recently merged are kept.
//
// A repository with fewer than 60 left is written with what it has and flagged `short` (it cannot feed a 60-task cell without repeats).
//
//   node scripts/collect-footprints.mjs --tasks-dir benchmarks/results/2026-10-05/footprints --out-dir <dir> [--keep 60] [--max-files 30] [--only click]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const SAMPLE = ['click', 'hono', 'axios', 'prettier', 'eslint', 'vite', 'svelte', 'cli'];

/** prs: [{number, title, mergedAt, author: {is_bot, login}, files: [{path}]}] -> [{number, mergedAt, files: [path]}], newest first, distinct, at most `keep`. */
export function distinctFootprints(prs, { keep = 60, maxFiles = 30 } = {}) {
  const seen = new Set();
  const out = [];
  for (const pr of [...prs].sort((a, b) => String(b.mergedAt).localeCompare(String(a.mergedAt)))) {
    if (pr.author?.is_bot || /\[bot\]$|^(dependabot|renovate)/i.test(pr.author?.login ?? '')) continue;
    const files = [...new Set((pr.files ?? []).map((f) => f.path ?? f))].sort();
    if (files.length < 1 || files.length > maxFiles) continue;
    const key = files.join('\n');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ number: pr.number, mergedAt: pr.mergedAt, files });
    if (out.length >= keep) break;
  }
  return out;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const argv = process.argv.slice(2);
  const arg = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
  const tasksDir = arg('tasks-dir');
  const outDir = arg('out-dir');
  if (!tasksDir || !outDir) {
    console.error('usage: node scripts/collect-footprints.mjs --tasks-dir <dir> --out-dir <dir> [--keep 60] [--max-files 30] [--only repo]');
    process.exit(2);
  }
  const keep = Number(arg('keep', '60'));
  const maxFiles = Number(arg('max-files', '30'));
  fs.mkdirSync(outDir, { recursive: true });
  for (const repo of SAMPLE.filter((r) => !arg('only') || r === arg('only'))) {
    const t = JSON.parse(fs.readFileSync(path.join(tasksDir, `${repo}-tasks.json`), 'utf8'));
    const raw = execFileSync('gh', ['pr', 'list', '--repo', t.slug, '--state', 'merged', '--search', `merged:${t.since}..${t.until}`, '--limit', '300', '--json', 'number,title,mergedAt,files,author'], { encoding: 'utf8', maxBuffer: 1 << 28 });
    const prs = JSON.parse(raw);
    const fps = distinctFootprints(prs, { keep, maxFiles });
    const res = { slug: t.slug, since: t.since, until: t.until, rule: { keep, maxFiles, bots: 'excluded', distinct: true }, mergedInWindow: prs.length, short: fps.length < keep, tasks: fps.map((f) => ({ id: `pr${f.number}`, pr: { number: f.number, mergedAt: f.mergedAt, files: f.files } })) };
    fs.writeFileSync(path.join(outDir, `${repo}-tasks.json`), `${JSON.stringify(res, null, 2)}\n`);
    console.log(`${repo.padEnd(9)} merged in window ${String(prs.length).padStart(3)}  distinct footprints ${String(fps.length).padStart(3)}${res.short ? '  SHORT' : ''}`);
  }
}
