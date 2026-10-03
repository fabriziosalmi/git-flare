#!/usr/bin/env node
// Calibrate the near-duplicate threshold (Hamming distance between 256-bit SimHashes of two
// changes) on real commits. Uses the platform's own pipeline: lineMultisetDiff → canonicalChange → SimHash (WASM).
//
// Positives = a real commit and the same change resubmitted with small edits (what an agent resubmitting a
// rejected solution produces). Negatives = changes of different commits of the same repository, including
// "hard" pairs that touch a common file. Only commit SHAs, transform names and distances are written: the code
// stays in the public repositories, and the script regenerates everything from them.
//
//   node scripts/calibrate-simhash.mjs --repo <clone> [--repo <clone> ...] [--commits 250] [--out file.json] [--pairs file.jsonl]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { AimpEngine } from '../src/epistemic/aimp.ts';
import { canonicalChange, lineMultisetDiff } from '../src/epistemic/changeset.ts';

const args = process.argv.slice(2);
const all = (n) => args.flatMap((a, i) => (a === `--${n}` ? [args[i + 1]] : []));
const arg = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const REPOS = all('repo');
const COMMITS = Number(arg('commits', '250'));
const OUT = arg('out');
const PAIRS = arg('pairs');
if (REPOS.length === 0) {
  console.error('usage: node scripts/calibrate-simhash.mjs --repo <clone> [--repo ...] [--commits N] [--out f.json] [--pairs f.jsonl]');
  process.exit(2);
}
const here = path.dirname(new URL(import.meta.url).pathname);
const engine = await AimpEngine.create(fs.readFileSync(path.join(here, '..', 'crates', 'aimp-wasm', 'pkg', 'aimp_wasm_bg.wasm')));

// Deterministic pseudo-random numbers (the same dataset on every run).
let seed = 20261002;
const rnd = (n) => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0), seed % n);

const git = (repo, argv) => execFileSync('git', ['-C', repo, ...argv], { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] });
const show = (repo, rev, p) => {
  try {
    return git(repo, ['show', `${rev}:${p}`]);
  } catch {
    return null;
  }
};

// ── 1. Real changes ──────────────────────────────────────────────────────────
function changesOf(repo) {
  const out = [];
  for (const sha of git(repo, ['log', '--no-merges', '--format=%H', '-n', String(COMMITS * 4)]).trim().split('\n')) {
    if (out.length >= COMMITS) break;
    let numstat;
    try {
      numstat = git(repo, ['diff-tree', '--no-commit-id', '-r', '--numstat', sha]).trim().split('\n').filter(Boolean);
    } catch {
      continue; // root or shallow-boundary commit
    }
    if (numstat.length === 0 || numstat.length > 8) continue;
    const files = [];
    let lines = 0;
    let ok = true;
    for (const row of numstat) {
      const [a, d, p] = row.split('\t');
      if (a === '-' || d === '-') {
        ok = false; // binary
        break;
      }
      const after = show(repo, sha, p);
      if (after === null) continue; // deletion: keep the example simple
      const before = show(repo, `${sha}^`, p) ?? '';
      const diff = lineMultisetDiff(before, after);
      lines += diff.added.length + diff.removed.length;
      files.push({ path: p, before, after, ...diff });
    }
    if (!ok || files.length === 0 || lines < 3 || lines > 400) continue;
    out.push({ repo: path.basename(repo), sha, files, lines });
  }
  return out;
}

const fileChange = (f, after) => ({ path: f.path, status: f.before ? 'modified' : 'added', binary: false, ...lineMultisetDiff(f.before, after) });
const hashOf = (files) => engine.computeSimHash(canonicalChange(files));

// ── 2. Resubmission edits (applied to the lines the commit added) ───────────
const KEYWORDS = new Set('const let var function return this that self None True False null undefined async await import from export default class def elif else while for range func type struct package string error interface public private static'.split(' '));
const commentFor = (p) => (/\.(py|rb|sh|ya?ml|toml)$/.test(p) ? '# note' : '// note');
const logFor = (p) => (/\.py$/.test(p) ? 'print("debug")' : /\.go$/.test(p) ? 'fmt.Println("debug")' : 'console.log("debug")');

function addedMask(f) {
  const counts = new Map();
  for (const l of f.before.split('\n')) counts.set(l, (counts.get(l) ?? 0) + 1);
  return f.after.split('\n').map((l) => {
    const c = counts.get(l) ?? 0;
    if (c > 0) {
      counts.set(l, c - 1);
      return false;
    }
    return true;
  });
}

function editAdded(c, fn) {
  // Apply `fn(lines, mask, file)` to the largest file of the change; returns the changed files or null.
  const target = [...c.files].sort((a, b) => b.added.length - a.added.length)[0];
  if (!target || target.added.filter((l) => l.trim()).length === 0) return null;
  const lines = target.after.split('\n');
  const mask = addedMask(target);
  const next = fn([...lines], mask, target);
  if (!next || next.join('\n') === target.after) return null;
  return c.files.map((f) => (f === target ? fileChange(f, next.join('\n')) : fileChange(f, f.after)));
}

const idxAdded = (mask, lines) => mask.flatMap((m, i) => (m && lines[i].trim() ? [i] : []));

// Line-level edits: (lines, mask, file) → new lines, or null when the edit does not apply.
function renameLines(lines, mask) {
  const freq = new Map();
  for (const i of idxAdded(mask, lines)) for (const w of lines[i].match(/[A-Za-z_][A-Za-z0-9_]{3,}/g) ?? []) if (!KEYWORDS.has(w)) freq.set(w, (freq.get(w) ?? 0) + 1);
  const id = [...freq].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0];
  if (!id) return null;
  const re = new RegExp(`\\b${id}\\b`, 'g');
  return lines.map((l, i) => (mask[i] ? l.replace(re, `${id}Alt`) : l));
}
function literalLines(lines, mask) {
  for (const i of idxAdded(mask, lines)) {
    if (/\d/.test(lines[i])) return lines.map((l, j) => (j === i ? l.replace(/\d+/, (m) => String(Number(m) + 1)) : l));
    if (/(["'])[^"']+\1/.test(lines[i])) return lines.map((l, j) => (j === i ? l.replace(/(["'])([^"']+)\1/, (_m, q, t) => `${q}${t}x${q}`) : l));
  }
  return null;
}
function commentLines(lines, mask, f) {
  const i = idxAdded(mask, lines)[0];
  return i === undefined ? null : [...lines.slice(0, i + 1), commentFor(f.path), ...lines.slice(i + 1)];
}
const TRANSFORMS = {
  whitespace: (c) => editAdded(c, (lines, mask) => lines.map((l, i) => (mask[i] ? l.replace(/^( +)/, (m) => '\t'.repeat(Math.ceil(m.length / 2))) + '  ' : l))),
  rename: (c) => editAdded(c, renameLines),
  comment: (c) => editAdded(c, commentLines),
  literal: (c) => editAdded(c, literalLines),
  dropLine: (c) =>
    editAdded(c, (lines, mask) => {
      const ids = idxAdded(mask, lines);
      if (ids.length < 3) return null;
      const drop = ids[Math.floor(ids.length / 2)];
      return lines.filter((_l, i) => i !== drop);
    }),
  extraLine: (c) =>
    editAdded(c, (lines, mask, f) => {
      const i = idxAdded(mask, lines).at(-1);
      return i === undefined ? null : [...lines.slice(0, i + 1), logFor(f.path), ...lines.slice(i + 1)];
    }),
  reorder: (c) =>
    editAdded(c, (lines, mask) => {
      const ids = idxAdded(mask, lines);
      const k = ids.findIndex((v, j) => j > 0 && ids[j - 1] === v - 1 && lines[v] !== lines[v - 1]);
      if (k < 1) return null;
      const out = [...lines];
      [out[ids[k] - 1], out[ids[k]]] = [out[ids[k]], out[ids[k] - 1]];
      return out;
    }),
  // rename + literal + comment on the same file (a resubmission that was "cleaned up")
  combo: (c) =>
    editAdded(c, (lines, mask, f) => {
      const renamed = renameLines(lines, mask);
      if (!renamed) return null;
      const lit = literalLines(renamed, mask) ?? renamed;
      return commentLines(lit, mask, f);
    }),
};

// ── 3. Pairs ─────────────────────────────────────────────────────────────────
const sizeBucket = (n) => (n <= 10 ? '3-10' : n <= 50 ? '11-50' : '51-400');
const pairs = [];
const meta = [];
for (const repo of REPOS) {
  const head = git(repo, ['rev-parse', 'HEAD']).trim();
  const url = git(repo, ['config', '--get', 'remote.origin.url']).trim();
  const changes = changesOf(repo);
  meta.push({ repo: path.basename(repo), url, head, changes: changes.length });
  for (const c of changes) c.hash = hashOf(c.files.map((f) => fileChange(f, f.after)));
  for (const c of changes) {
    for (const [name, t] of Object.entries(TRANSFORMS)) {
      const v = t(c);
      if (!v) continue;
      pairs.push({ label: 1, kind: name, repo: c.repo, a: c.sha.slice(0, 12), size: c.lines, bucket: sizeBucket(c.lines), d: engine.hammingDistance(c.hash, hashOf(v)) });
    }
  }
  // Negatives: random pairs, and hard pairs touching a common file.
  const byFile = new Map();
  for (const c of changes) for (const f of c.files) byFile.set(f.path, [...(byFile.get(f.path) ?? []), c]);
  const seen = new Set();
  const neg = (x, y, kind) => {
    const k = [x.sha, y.sha].sort().join();
    if (x === y || seen.has(k)) return;
    seen.add(k);
    const size = Math.min(x.lines, y.lines);
    pairs.push({ label: 0, kind, repo: x.repo, a: x.sha.slice(0, 12), b: y.sha.slice(0, 12), size, bucket: sizeBucket(size), d: engine.hammingDistance(x.hash, y.hash) });
  };
  for (let i = 0; i < changes.length * 6; i++) neg(changes[rnd(changes.length)], changes[rnd(changes.length)], 'random');
  for (const group of byFile.values()) for (let i = 0; i < Math.min(group.length * 2, 40); i++) neg(group[rnd(group.length)], group[rnd(group.length)], 'same-file');
  console.error(`${path.basename(repo)}: ${changes.length} changes, ${pairs.length} pairs so far`);
}

// ── 4. Curves ────────────────────────────────────────────────────────────────
function curve(ps) {
  const out = [];
  for (let t = 0; t <= 96; t++) {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const p of ps) {
      const dup = p.d <= t;
      if (p.label && dup) tp++;
      else if (!p.label && dup) fp++;
      else if (p.label) fn++;
    }
    const precision = tp + fp ? tp / (tp + fp) : 1;
    const recall = tp + fn ? tp / (tp + fn) : 0;
    out.push({ t, tp, fp, fn, precision: +precision.toFixed(4), recall: +recall.toFixed(4), f1: +(precision + recall ? (2 * precision * recall) / (precision + recall) : 0).toFixed(4) });
  }
  return out;
}
const pick = (c, minPrecision) => [...c].reverse().find((r) => r.precision >= minPrecision && r.tp > 0) ?? null;
const at = (c, t) => c.find((r) => r.t === t);
const positives = pairs.filter((p) => p.label);
const negatives = pairs.filter((p) => !p.label);
const overall = curve(pairs);
const hard = curve([...positives, ...negatives.filter((p) => p.kind === 'same-file')]);
const pct = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : null;
};
const dist = (ps) => ({ n: ps.length, p05: pct(ps.map((p) => p.d), 0.05), p50: pct(ps.map((p) => p.d), 0.5), p95: pct(ps.map((p) => p.d), 0.95), min: pct(ps.map((p) => p.d), 0) });
const result = {
  date: new Date().toISOString().slice(0, 10),
  method: 'scripts/calibrate-simhash.mjs: platform pipeline (lineMultisetDiff → canonicalChange → 256-bit SimHash, WASM)',
  repos: meta,
  counts: { positives: positives.length, negatives: negatives.length, sameFileNegatives: negatives.filter((p) => p.kind === 'same-file').length },
  distances: {
    positivesByTransform: Object.fromEntries(Object.keys(TRANSFORMS).map((k) => [k, dist(positives.filter((p) => p.kind === k))])),
    positivesBySize: Object.fromEntries(['3-10', '11-50', '51-400'].map((b) => [b, dist(positives.filter((p) => p.bucket === b))])),
    negatives: { random: dist(negatives.filter((p) => p.kind === 'random')), sameFile: dist(negatives.filter((p) => p.kind === 'same-file')) },
  },
  currentThreshold: { t: 8, overall: at(overall, 8), hardNegatives: at(hard, 8) },
  recommended: {
    precision99: pick(overall, 0.99),
    precision99HardNegatives: pick(hard, 0.99),
    precision999HardNegatives: pick(hard, 0.999),
    bestF1HardNegatives: [...hard].sort((a, b) => b.f1 - a.f1)[0],
  },
  recallAtBySize: (t) => t,
  curves: { overall, hardNegatives: hard },
};
result.recallBySizeAt = Object.fromEntries(
  [8, result.recommended.precision99HardNegatives?.t].filter((t) => t !== undefined).map((t) => [
    t,
    Object.fromEntries(['3-10', '11-50', '51-400'].map((b) => {
      const ps = positives.filter((p) => p.bucket === b);
      return [b, ps.length ? +(ps.filter((p) => p.d <= t).length / ps.length).toFixed(3) : null];
    })),
  ])
);
delete result.recallAtBySize;
const text = JSON.stringify(result, null, 2);
if (OUT) fs.writeFileSync(OUT, text + '\n');
else console.log(text);
if (PAIRS) fs.writeFileSync(PAIRS, pairs.map((p) => JSON.stringify(p)).join('\n') + '\n');
console.error(JSON.stringify({ counts: result.counts, current: result.currentThreshold, recommended: result.recommended }, null, 1));
