#!/usr/bin/env node
// Companion to calibrate-simhash.mjs: how far apart are independent solutions of the same task written by the
// coding model (gf-agents /code, Workers AI)? Informational only: these are different implementations of the
// same feature, which a textual near-duplicate detector is not expected to match.
//
//   GF_AGENTS_TOKEN=... node scripts/llm-solutions-simhash.mjs --agents <gf-agents url> [--runs 3] [--out file.json]
import fs from 'node:fs';
import path from 'node:path';
import { AimpEngine } from '../src/epistemic/aimp.ts';
import { canonicalChange, lineMultisetDiff } from '../src/epistemic/changeset.ts';

const args = process.argv.slice(2);
const arg = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const AGENTS = arg('agents');
const RUNS = Number(arg('runs', '3'));
const OUT = arg('out');
const { GF_AGENTS_TOKEN } = process.env;
if (!AGENTS || !GF_AGENTS_TOKEN) {
  console.error('usage: GF_AGENTS_TOKEN=... node scripts/llm-solutions-simhash.mjs --agents <url> [--runs N] [--out f.json]');
  process.exit(2);
}
const here = path.dirname(new URL(import.meta.url).pathname);
const engine = await AimpEngine.create(fs.readFileSync(path.join(here, '..', 'crates', 'aimp-wasm', 'pkg', 'aimp_wasm_bg.wasm')));
const fixture = path.join(here, '..', 'fixtures', 'tiny-lib');
const files = {};
const walk = (d, rel = '') => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walk(path.join(d, e.name), r);
    else files[r] = fs.readFileSync(path.join(d, e.name), 'utf8');
  }
};
walk(fixture);

const TASKS = [
  { id: 'D1', title: 'Add clamp(x, lo, hi) in src/clamp.mjs with tests', description: 'Return lo if x < lo, hi if x > hi, else x. Throw RangeError if lo > hi.' },
  { id: 'D2', title: 'Add slugify(s) in src/slug.mjs with tests', description: 'Lowercase, trim, replace runs of non-alphanumeric characters with a single "-", no leading/trailing "-".' },
  { id: 'D3', title: 'Add sum(arr) and mean(arr) in src/stats.mjs with tests', description: 'mean([]) throws RangeError. Both accept arrays of numbers.' },
  { id: 'D4', title: 'Add isPalindrome(s) in src/strings.mjs with tests', description: 'Ignore case and non-alphanumeric characters.' },
  { id: 'D5', title: 'Add chunk(arr, n) in src/array.mjs with tests', description: 'Split arr into arrays of length n (last may be shorter). Throw RangeError if n is not a positive integer.' },
];

async function solve(task) {
  const res = await fetch(`${AGENTS}/code`, { method: 'POST', headers: { Authorization: `Bearer ${GF_AGENTS_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ task, files }) });
  const j = await res.json();
  if (!res.ok || j.ok === false) throw new Error(`/code ${task.id}: ${j.error ?? res.status}`);
  const change = j.files.map((f) => ({ path: f.path, status: files[f.path] === undefined ? 'added' : 'modified', binary: false, ...lineMultisetDiff(files[f.path] ?? '', f.content) }));
  return { hash: engine.computeSimHash(canonicalChange(change)), lines: change.reduce((a, c) => a + c.added.length + c.removed.length, 0), model: j.model };
}

const sols = {};
for (const t of TASKS) {
  sols[t.id] = [];
  for (let i = 0; i < RUNS; i++) sols[t.id].push(await solve(t));
  console.error(`${t.id}: ${sols[t.id].map((s) => s.lines).join(', ')} changed lines`);
}
const sameTask = [];
const crossTask = [];
const ids = Object.keys(sols);
for (const a of ids) {
  for (let i = 0; i < RUNS; i++) for (let j = i + 1; j < RUNS; j++) sameTask.push({ task: a, d: engine.hammingDistance(sols[a][i].hash, sols[a][j].hash) });
  for (const b of ids) if (a < b) for (let i = 0; i < RUNS; i++) crossTask.push({ tasks: `${a}/${b}`, d: engine.hammingDistance(sols[a][i].hash, sols[b][i].hash) });
}
const summary = (xs) => {
  const s = xs.map((x) => x.d).sort((p, q) => p - q);
  return { n: s.length, min: s[0], p50: s[Math.floor(s.length / 2)], max: s.at(-1), withinThreshold14: s.filter((d) => d <= 14).length };
};
const out = { date: new Date().toISOString().slice(0, 10), model: sols.D1[0].model, runsPerTask: RUNS, sameTask: summary(sameTask), crossTask: summary(crossTask), sameTaskPairs: sameTask };
const text = JSON.stringify(out, null, 2);
if (OUT) fs.writeFileSync(OUT, text + '\n');
else console.log(text);
console.error(JSON.stringify({ sameTask: out.sameTask, crossTask: out.crossTask }));
