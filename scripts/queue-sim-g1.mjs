#!/usr/bin/env node
// The G1 measurement of docs/spikes/hunk-merge-2026-10-04.md section 13: the reference cell (10 agents, tests of 30 s,
// `human` footprints) for each of the eight repositories of the sample, three repetitions each, and the decision
// computed by g1Decision from the median of the per-repository rejection per submission.
//
// The work, review and rebase times come from a file (the medians measured in phase 2) that has to be committed before
// this runs: they are not arguments, so that they cannot be tuned after the rates are seen.
//
//   GF_ADMIN_KEY=... node scripts/queue-sim-g1.mjs --times <phase2-times.json> --footprints-dir benchmarks/results/2026-10-05/footprints \
//        --out-dir <dir> [--scale 0.25] [--reps 3] [--parallel 3] [--dry-run]
//
// phase2-times.json: {"workMs": n, "workCv": n, "reviewMs": n, "rebaseMs": n, "source": "where the numbers come from"}
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { g1Decision } from './lib/sim.mjs';

export const SAMPLE = ['click', 'hono', 'axios', 'prettier', 'eslint', 'vite', 'svelte', 'cli'];

const argv = process.argv.slice(2);
const arg = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const DRY = argv.includes('--dry-run');
const here = path.dirname(new URL(import.meta.url).pathname);

function fail(msg) {
  console.error(msg);
  process.exit(2);
}

const timesFile = arg('times');
const footprintsDir = arg('footprints-dir');
const outDir = arg('out-dir');
if (!timesFile || !footprintsDir || !outDir) fail('usage: node scripts/queue-sim-g1.mjs --times <phase2-times.json> --footprints-dir <dir> --out-dir <dir> [--scale 0.25] [--reps 3] [--parallel 3] [--dry-run]');
const times = JSON.parse(fs.readFileSync(timesFile, 'utf8'));
for (const k of ['workMs', 'reviewMs', 'rebaseMs']) if (!(Number(times[k]) > 0)) fail(`${timesFile}: ${k} must be a positive number`);
if (!(Number(times.workCv) >= 0)) fail(`${timesFile}: workCv must be a number, 0 or more`);
if (typeof times.source !== 'string' || times.source.length < 10) fail(`${timesFile}: say in "source" where the times come from`);
const scale = arg('scale', '0.25');
const reps = arg('reps', '3');
const parallel = arg('parallel', '3');

const commands = SAMPLE.map((repo) => {
  const fp = path.join(footprintsDir, `${repo}-tasks.json`);
  if (!fs.existsSync(fp)) fail(`missing ${fp}`);
  return {
    repo,
    args: [path.join(here, 'queue-sim.mjs'), '--grid', '--agents-list', '10', '--test-list', '30000', '--reps', reps, '--parallel', parallel, '--scale', scale, '--work-ms', String(times.workMs), '--work-cv', String(times.workCv), '--review-ms', String(times.reviewMs), '--rebase-ms', String(times.rebaseMs), '--footprints-from', fp, '--footprint-kind', 'human', '--out-dir', path.join(outDir, repo)],
  };
});

if (DRY) {
  for (const c of commands) console.log(`node ${c.args.join(' ')}`);
  process.exit(0);
}

const perRepo = [];
for (const c of commands) {
  const r = spawnSync('node', c.args, { stdio: 'inherit', env: process.env });
  if (r.status !== 0) fail(`${c.repo}: the simulation failed (exit ${r.status})`);
  const cells = JSON.parse(fs.readFileSync(path.join(outDir, c.repo, 'grid.json'), 'utf8'));
  const mean = (f) => cells.reduce((a, x) => a + x.summary[f], 0) / cells.length;
  perRepo.push({ repo: c.repo, cells: cells.length, rejectionPerSubmissionPct: Math.round(mean('rejectionPerSubmissionPct') * 10) / 10, firstAttemptRejectionPct: Math.round(mean('firstAttemptRejectionPct') * 10) / 10 });
}
const decision = g1Decision(perRepo.map((x) => x.rejectionPerSubmissionPct));
const result = { date: new Date().toISOString().slice(0, 10), what: 'G1: reference cell (10 agents, tests of 30 s, human footprints) for the eight repositories', scale: Number(scale), reps: Number(reps), times, perRepo, decision };
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'g1.json'), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ perRepo, decision }, null, 2));
