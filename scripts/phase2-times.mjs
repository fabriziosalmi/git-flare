#!/usr/bin/env node
// Builds the phase-2 times file that scripts/queue-sim-g1.mjs reads, by the formulas fixed in
// docs/spikes/hunk-merge-2026-10-04.md section 13 (buildPhase2Times in scripts/lib/sim.mjs):
//   workMs   the median time the agent took for a committed task (and workCv, the lognormal fit of its median and 90th percentile)
//   rebaseMs the median latency of the agent's edit call
//   reviewMs the median over the sampled patches of the quorum latency of the reviewers (scripts/review-latency.mjs)
//
//   node scripts/phase2-times.mjs --pilot <agent-replay manifest> [--pilot <another>] --reviews <review-latency.json> --out phase2-times.json
import fs from 'node:fs';
import { buildPhase2Times, quantile } from './lib/sim.mjs';

const argv = process.argv.slice(2);
const all = (n) => argv.flatMap((a, i) => (a === `--${n}` ? [argv[i + 1]] : []));
const arg = (n) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : undefined);
const pilots = all('pilot');
const reviewsFile = arg('reviews');
const out = arg('out');
if (pilots.length === 0 || !reviewsFile || !out) {
  console.error('usage: node scripts/phase2-times.mjs --pilot <manifest> [--pilot ...] --reviews <review-latency.json> --out <file>');
  process.exit(2);
}

const manifests = pilots.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
const byId = new Map(); // a task may appear in several manifests (stopped by the budget in one): the committed one wins
for (const t of manifests.flatMap((m) => m.tasks)) {
  const prev = byId.get(t.id);
  if (!prev || (prev.status !== 'committed' && t.status === 'committed')) byId.set(t.id, t);
}
const tasks = [...byId.values()];
const committed = tasks.filter((t) => t.status === 'committed' && typeof t.elapsedMs === 'number');
const elapsed = committed.map((t) => t.elapsedMs);
const editMs = committed.flatMap((t) => (t.calls ?? []).filter((c) => c.step === 'edit' && typeof c.ms === 'number').map((c) => c.ms));
const reviews = JSON.parse(fs.readFileSync(reviewsFile, 'utf8'));

let times;
try {
  times = buildPhase2Times({ taskMs: { p50: quantile(elapsed, 0.5), p90: quantile(elapsed, 0.9) }, editMs, quorumMs: reviews.quorumMs ?? [] });
} catch (e) {
  console.error(`cannot build the times: ${e.message}`);
  process.exit(1);
}
const slug = manifests[0].slug ?? 'unknown repository';
const result = {
  workMs: times.workMs,
  workCv: times.workCv,
  reviewMs: times.reviewMs,
  rebaseMs: times.rebaseMs,
  source: `agent pilot on ${slug} (${committed.length} committed of ${tasks.length} tasks, run ${manifests.map((m) => m.runId).join('+')}, ${manifests[0].date}); reviewer latency of ${reviews.quorumMs.length} patches ${reviews.measuredVia}, ${reviews.date}`,
  derived: times.derived,
  inputs: { pilots, reviews: reviewsFile, coder: manifests[0].coder, selector: manifests[0].selector, reviewers: reviews.models?.map((m) => m.model) },
};
fs.writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
console.log(`workMs ${result.workMs} (cv ${result.workCv}), reviewMs ${result.reviewMs}, rebaseMs ${result.rebaseMs} → ${out}`);
