#!/usr/bin/env node
// How long do the reviewers take? For the committed patches of an agent-replay run, each of the three reviewer
// families of gf-agents (agents/src/index.ts: REVIEWERS) is called with the same system prompt, the same schema and
// the same rendering of the change (renderChange) as the platform's reviewers, and the latency of each call is
// recorded. A patch enters the merge queue when two families have attested, so the latency that matters for a patch is
// the second smallest of the three (quorumLatency); the review time of the queue simulation is the median of that over
// the sampled patches (phase 2 of docs/spikes/hunk-merge-2026-10-04.md, section 13).
//
// The calls go through the account REST API with the local `wrangler login` (as scripts/cf-api.mjs), so the latency
// includes the round trip from this machine, a few hundred ms on top of seconds of model time; the platform's own calls
// are Worker bindings inside Cloudflare. Every call is counted from the API's token usage into the per-day neuron
// ledger shared with agent-replay, and the run stops before a patch that could pass --max-neurons.
//
//   node scripts/review-latency.mjs --repo <clone> --manifest <agent-replay manifest> --tasks <tasks.json> \
//        [--max-patches 8] [--max-neurons 9800] --out latency.json [--mock]
//
// --mock needs no network: seeded latencies for the plumbing (its numbers measure nothing).
import fs from 'node:fs';
import { REVIEWERS, REVIEW_SCHEMA, REVIEW_SYSTEM, extractJson, renderChange, responseText } from '../agents/src/index.ts';
import { cfApi } from './cf-api.mjs';
import { git, ledgerAdd, ledgerRead, neuronsFor } from './lib/replay.mjs';
import { changesFromDiff, median, quorumLatency, reviewInput, rng } from './lib/sim.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const MOCK = argv.includes('--mock');
const need = (n) => {
  const v = arg(n);
  if (!v) {
    console.error(`missing --${n} (see the header of scripts/review-latency.mjs)`);
    process.exit(2);
  }
  return v;
};
const repo = need('repo');
const manifest = JSON.parse(fs.readFileSync(need('manifest'), 'utf8'));
const spec = JSON.parse(fs.readFileSync(need('tasks'), 'utf8'));
const out = need('out');
const MAX_PATCHES = Number(arg('max-patches', '8'));
const MAX_NEURONS = Number(arg('max-neurons', '9800'));

const mockRand = rng(7);
async function callReviewer(reviewer, text) {
  if (MOCK) {
    const ms = 1500 + Math.floor(mockRand() * 6000);
    return { ms, tin: Math.ceil(text.length / 4), tout: 120, verdict: 'approve' };
  }
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const t0 = performance.now();
    try {
      const r = await cfApi('POST', `/ai/run/${reviewer.model}`, reviewInput(reviewer.style, REVIEW_SYSTEM, REVIEW_SCHEMA, text));
      const ms = Math.round(performance.now() - t0);
      const tin = r.usage?.prompt_tokens ?? r.usage?.input_tokens ?? Math.ceil(text.length / 3);
      const tout = r.usage?.completion_tokens ?? r.usage?.output_tokens ?? 400;
      const parsed = extractJson(responseText(r));
      return { ms, tin, tout, verdict: parsed?.verdict ?? null };
    } catch (e) {
      lastError = String(e.message).slice(0, 160);
      if (/401|403|auth/i.test(lastError)) break;
    }
  }
  return { ms: null, error: lastError };
}

const committed = manifest.tasks.filter((t) => t.status === 'committed' && t.sha);
const patches = [];
let spent = 0;
let stoppedBy = null;
const worstOut = { 'responses': 1500 }; // a reasoning model's output is not bounded by max_tokens here

for (const t of committed) {
  if (patches.length >= MAX_PATCHES) break;
  const task = spec.tasks.find((x) => x.id === t.id);
  const diff = git(repo, ['diff', '--unified=3', manifest.base, t.sha]).out;
  const { text, truncated } = renderChange({ id: t.id, title: task?.issue?.title ?? t.id }, { changes: changesFromDiff(diff), gates: [{ gate: 'non-empty', passed: true }] });
  if (truncated) {
    patches.push({ taskId: t.id, skipped: 'the change is longer than what reviewers read (14,000 characters)' });
    continue;
  }
  // before the calls: could this patch pass the cap? (input chars/3 as tokens, the largest output each model may produce)
  const worst = REVIEWERS.reduce((a, r) => a + neuronsFor(r.model, Math.ceil(text.length / 3), worstOut[r.style] ?? 400), 0);
  if (!MOCK && ledgerRead().spent + worst > MAX_NEURONS) {
    stoppedBy = `next patch could cost ${Math.round(worst)} neurons; ${Math.round(ledgerRead().spent)} spent today, cap ${MAX_NEURONS}`;
    break;
  }
  const results = await Promise.all(REVIEWERS.map((r) => callReviewer(r, text))); // as reviewRepo does: all families at once
  let neurons = 0;
  for (const [i, r] of results.entries()) {
    if (r.ms === null) continue;
    neurons += neuronsFor(REVIEWERS[i].model, r.tin, r.tout);
  }
  if (!MOCK) ledgerAdd(neurons);
  spent += neurons;
  const latencies = results.map((r) => r.ms);
  patches.push({
    taskId: t.id,
    chars: text.length,
    latenciesMs: Object.fromEntries(REVIEWERS.map((r, i) => [r.family, latencies[i]])),
    verdicts: Object.fromEntries(REVIEWERS.map((r, i) => [r.family, results[i].verdict ?? null])),
    errors: Object.fromEntries(REVIEWERS.map((r, i) => [r.family, results[i].error ?? null]).filter(([, e]) => e)),
    quorumMs: quorumLatency(latencies),
    neurons: Math.round(neurons),
  });
}

const sampled = patches.filter((p) => typeof p.quorumMs === 'number');
const result = {
  date: new Date().toISOString().slice(0, 10),
  what: 'Latency of the three reviewer families of gf-agents on the committed patches of an agent-replay run; the queue is entered when two have attested (quorumMs)',
  measuredVia: MOCK ? 'mock (numbers measure nothing)' : 'the account REST API from a local machine',
  models: REVIEWERS.map((r) => ({ family: r.family, model: r.model, style: r.style })),
  patches,
  quorumMs: sampled.map((p) => p.quorumMs),
  medianQuorumMs: median(sampled.map((p) => p.quorumMs)),
  neurons: Math.round(spent),
  ...(stoppedBy ? { stoppedBy } : {}),
};
fs.writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
console.log(`${sampled.length} patch(es) sampled${stoppedBy ? ` (stopped: ${stoppedBy})` : ''}; median quorum latency ${result.medianQuorumMs} ms; ${result.neurons} neurons → ${out}`);
