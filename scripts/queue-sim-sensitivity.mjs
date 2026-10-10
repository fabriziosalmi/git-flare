#!/usr/bin/env node
// The sensitivities of G1 (docs/spikes/hunk-merge-2026-10-04.md sections 9 and 13), run after G1 and fixed here BEFORE any of
// them runs. Every condition is the G1 reference cell (10 agents, tests of 30 s, scale 0.25, 3 reps, the times file of
// phase 2) with ONE change, on the repositories listed:
//
//   human-nohot     footprints without changelog, version and dependency files        all eight
//   agent           footprints of the Workers AI agent (1 file per patch)              click, hono
//   work-x0.5/x2/x6 the agent's work time times 0.5, 2, 6 (6: an agent that works for minutes)   click, svelte
//   wave-replace    ONE wave: 1 task per agent (10 tasks), footprints drawn WITH replacement      click, hono, axios, vite, svelte
//   wave-noreplace  the same wave, footprints drawn WITHOUT replacement (no repeated footprint)  click, hono, axios, vite, svelte
//   distinct60            the reference cell (6 waves, 60 tasks) with 60 DISTINCT footprints per repository (all merged pull requests, scripts/collect-footprints.mjs), WITHOUT replacement   all eight
//   distinct60-replace    the same population drawn WITH replacement: the control that separates the population from the replacement   click, hono, svelte
//
// wave-replace is the control of wave-noreplace: the difference between the two isolates the effect of repeating
// footprints from the effect of running a single wave instead of six.
//
// What it answers, stated now: G1 said "proceed" (median >= 20%). The decision is ROBUST to a condition when the median of
// that condition's repositories stays >= 20%; if one drops below, the decision depends on that assumption and that is the
// finding. The conditions with two repositories are indicative, not a median of eight. Nothing here changes the G1 result.
//
//   GF_ADMIN_KEY=... node scripts/queue-sim-sensitivity.mjs --times <phase2-times.json> --footprints-dir <dir> \
//        --agent-manifests "click=a.json,b.json;hono=c.json" --g1 <g1.json> --out-dir <dir> [--only <condition>[,<condition>]] [--distinct-dir <dir>] [--dry-run]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { g1Decision } from './lib/sim.mjs';

const ALL = ['click', 'hono', 'axios', 'prettier', 'eslint', 'vite', 'svelte', 'cli'];
const WAVE = ['click', 'hono', 'axios', 'vite', 'svelte'];
export const CONDITIONS = [
  { name: 'human-nohot', repos: ALL, kind: 'human-nohot' },
  { name: 'agent', repos: ['click', 'hono'], kind: 'agent' },
  { name: 'work-x0.5', repos: ['click', 'svelte'], kind: 'human', workFactor: 0.5 },
  { name: 'work-x2', repos: ['click', 'svelte'], kind: 'human', workFactor: 2 },
  { name: 'work-x6', repos: ['click', 'svelte'], kind: 'human', workFactor: 6 },
  { name: 'wave-replace', repos: WAVE, kind: 'human', tasksPerAgent: 1 },
  { name: 'wave-noreplace', repos: WAVE, kind: 'human', tasksPerAgent: 1, noReplacement: true },
  { name: 'distinct60', repos: ALL, kind: 'human', noReplacement: true, distinct: true },
  { name: 'distinct60-replace', repos: ['click', 'hono', 'svelte'], kind: 'human', distinct: true },
];

const argv = process.argv.slice(2);
const arg = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const DRY = argv.includes('--dry-run');
const here = path.dirname(new URL(import.meta.url).pathname);
const fail = (m) => {
  console.error(m);
  process.exit(2);
};

const timesFile = arg('times');
const footprintsDir = arg('footprints-dir');
const outDir = arg('out-dir');
const g1File = arg('g1');
if (!timesFile || !footprintsDir || !outDir) fail('usage: node scripts/queue-sim-sensitivity.mjs --times <phase2-times.json> --footprints-dir <dir> --agent-manifests "click=a.json,b.json;hono=c.json" --g1 <g1.json> --out-dir <dir> [--only <condition>] [--dry-run]');
const times = JSON.parse(fs.readFileSync(timesFile, 'utf8'));
for (const k of ['workMs', 'reviewMs', 'rebaseMs']) if (!(Number(times[k]) > 0)) fail(`${timesFile}: ${k} must be a positive number`);
const agentManifests = Object.fromEntries((arg('agent-manifests', '') || '').split(';').filter(Boolean).map((kv) => [kv.split('=')[0], kv.split('=')[1].split(',')]));
const g1 = g1File && fs.existsSync(g1File) ? JSON.parse(fs.readFileSync(g1File, 'utf8')) : null;
const distinctDir = arg('distinct-dir');
const only = arg('only');
const wanted = only ? only.split(',') : null;
const chosen = CONDITIONS.filter((c) => !wanted || wanted.includes(c.name));
if (chosen.length === 0 || (wanted && chosen.length !== wanted.length)) fail(`no such condition in ${only}: ${CONDITIONS.map((c) => c.name).join(', ')}`);
if (chosen.some((c) => c.distinct) && !distinctDir) fail('--distinct-dir is required for the distinct60 conditions');

function command(c, repo) {
  const from = c.kind === 'agent' ? (agentManifests[repo] ?? fail(`--agent-manifests has nothing for ${repo}`)) : [path.join(c.distinct ? distinctDir : footprintsDir, `${repo}-tasks.json`)];
  for (const f of from) if (!fs.existsSync(f)) fail(`missing ${f}`);
  return [
    path.join(here, 'queue-sim.mjs'), '--grid', '--agents-list', '10', '--test-list', '30000', '--reps', '3', '--parallel', '3', '--scale', '0.25',
    '--work-ms', String(times.workMs * (c.workFactor ?? 1)), '--work-cv', String(times.workCv), '--review-ms', String(times.reviewMs), '--rebase-ms', String(times.rebaseMs),
    '--footprints-from', from.join(','), '--footprint-kind', c.kind, ...(c.tasksPerAgent ? ['--tasks-per-agent', String(c.tasksPerAgent)] : []), ...(c.noReplacement ? ['--no-replacement'] : []),
    '--out-dir', path.join(outDir, c.name, repo),
  ];
}

if (DRY) {
  for (const c of chosen) for (const repo of c.repos) console.log(`${c.name.padEnd(15)} node ${command(c, repo).join(' ')}`);
  process.exit(0);
}

const results = [];
for (const c of chosen) {
  const perRepo = [];
  for (const repo of c.repos) {
    const r = spawnSync('node', command(c, repo), { stdio: 'inherit', env: process.env });
    if (r.status !== 0) fail(`${c.name}/${repo}: the simulation failed (exit ${r.status})`);
    const cells = JSON.parse(fs.readFileSync(path.join(outDir, c.name, repo, 'grid.json'), 'utf8'));
    const mean = (f) => Math.round((cells.reduce((a, x) => a + x.summary[f], 0) / cells.length) * 10) / 10;
    const sum = (f) => cells.reduce((a, x) => a + (x.summary[f] ?? 0), 0);
    const ref = g1?.perRepo.find((x) => x.repo === repo);
    perRepo.push({ repo, cells: cells.length, rejectionPerSubmissionPct: mean('rejectionPerSubmissionPct'), firstAttemptRejectionPct: mean('firstAttemptRejectionPct'), tasksGivenUp: sum('tasksGivenUp'), tasksClosedAtSubmit: sum('tasksClosedAtSubmit'), g1ReferencePct: ref?.rejectionPerSubmissionPct ?? null });
  }
  results.push({ condition: c.name, change: { kind: c.kind, workFactor: c.workFactor ?? 1, tasksPerAgent: c.tasksPerAgent ?? 6, noReplacement: Boolean(c.noReplacement), distinctFootprints: Boolean(c.distinct) }, perRepo, decision: g1Decision(perRepo.map((x) => x.rejectionPerSubmissionPct)) });
}
const out = { date: new Date().toISOString().slice(0, 10), what: 'G1 sensitivities: the reference cell with one change at a time', times, results };
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, only ? `sensitivity-${only.replace(/,/g, '+')}.json` : 'sensitivity.json'), `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify(results.map((r) => ({ condition: r.condition, perRepo: r.perRepo.map((x) => `${x.repo} ${x.rejectionPerSubmissionPct}% (G1 ${x.g1ReferencePct}%)`), median: r.decision.median, branch: r.decision.branch })), null, 2));
