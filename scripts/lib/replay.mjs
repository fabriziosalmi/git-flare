// Shared pieces of the conflict-replay and agent-replay scripts: git helpers, the pair verdict (file-level
// rule vs 3-way merge), search/replace edits, Workers AI neuron accounting. Pure functions are unit-tested in
// scripts/replay.test.mjs.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const lines = (s) => s.split('\n').filter(Boolean);

/** Run git in `repo`. `ok` lists exit codes that are answers rather than failures. */
export function git(repo, argv, ok = [0], opts = {}) {
  try {
    return { code: 0, out: execFileSync('git', ['-C', repo, ...argv], { encoding: 'utf8', maxBuffer: 256 << 20, stdio: ['ignore', 'pipe', 'ignore'], ...opts }) };
  } catch (e) {
    if (typeof e.status === 'number' && ok.includes(e.status)) return { code: e.status, out: String(e.stdout ?? '') };
    throw e;
  }
}

/** Files that every concurrent change tends to touch: a conflict confined to them is a different problem. */
export const HOT = /(^|\/)(package(-lock)?\.json|yarn\.lock|history\.md|changes(\.rst)?|changelog[^/]*|news[^/]*|authors[^/]*|__init__\.py|setup\.py|pyproject\.toml|version[^/]*)$/i;

/**
 * The two sides `a` and `b` developed concurrently from `base` (default: their merge-base).
 * verdict: 'empty' (a side changes nothing), 'disjoint' (no common path: both rules accept),
 * 'clean' (common path, `git merge-tree` merges it: only the file-level rule rejects),
 * 'conflict' (common path, a 3-way merge conflicts too).
 */
export function pairVerdict(repo, a, b, base) {
  base ??= git(repo, ['merge-base', a, b], [0, 1]).out.trim();
  if (!base) return { verdict: 'empty', base: '', sidePaths: [0, 0], common: [], conflicted: [] };
  const changed = (x) => new Set(lines(git(repo, ['diff', '--name-only', '--no-renames', base, x]).out));
  const fa = changed(a);
  const fb = changed(b);
  const sidePaths = [fa.size, fb.size];
  if (fa.size === 0 || fb.size === 0) return { verdict: 'empty', base, sidePaths, common: [], conflicted: [] };
  const common = [...fa].filter((p) => fb.has(p));
  if (common.length === 0) return { verdict: 'disjoint', base, sidePaths, common, conflicted: [] };
  const r = git(repo, ['merge-tree', '--write-tree', '--name-only', '--no-messages', a, b], [0, 1]);
  if (r.code === 0) return { verdict: 'clean', base, sidePaths, common, conflicted: [] };
  return { verdict: 'conflict', base, sidePaths, common, conflicted: lines(r.out.split('\n\n')[0]).slice(1) }; // first line is the tree id
}

// ─── Search/replace edits ───────────────────────────────────────────────────

const SAFE_PATH = /^[A-Za-z0-9._/-]{1,200}$/;
export function safeRelPath(p) {
  return typeof p === 'string' && SAFE_PATH.test(p) && !p.startsWith('/') && !p.split('/').some((s) => s === '..' || s === '.git' || s === '') && !p.startsWith('.gitflare/');
}

const squash = (x) => x.replace(/\s+/g, ' ').trim();
const tokens = (x) => new Set(x.toLowerCase().match(/[a-z_][a-z0-9_]{2,}/g) ?? []);

/**
 * Why a `search` text is not in a file: 'whitespace' (equal once whitespace is collapsed), 'lines-not-contiguous'
 * (every line exists, not as one block), 'partial' (its first line exists, the rest does not) or 'absent' (not even
 * its first line). `nearest` is the file line sharing the most identifiers with the first line of the search and
 * `nearestLine` its 1-based number.
 */
export function diagnoseMiss(text, search) {
  const fileLines = text.split('\n');
  const trimmed = new Set(fileLines.map((l) => l.trim()));
  const sLines = search.split('\n').map((l) => l.trim()).filter(Boolean);
  let kind = 'absent';
  if (squash(text).includes(squash(search))) kind = 'whitespace';
  else if (sLines.length > 0 && sLines.every((l) => trimmed.has(l))) kind = 'lines-not-contiguous';
  else if (sLines.length > 0 && trimmed.has(sLines[0])) kind = 'partial';
  const want = tokens(sLines[0] ?? '');
  let best = { score: 0, line: '', at: 0 };
  fileLines.forEach((l, i) => {
    const t = tokens(l);
    let score = 0;
    for (const w of want) if (t.has(w)) score++;
    if (score > best.score) best = { score, line: l.trim(), at: i + 1 };
  });
  return { kind, searchHead: sLines[0]?.slice(0, 160) ?? '', ...(best.score > 0 ? { nearest: best.line.slice(0, 160), nearestLine: best.at } : {}) };
}

const indentOf = (l) => l.match(/^[ \t]*/)[0];

/**
 * The places of a file that hold `search` once the whitespace at both ends of every line is ignored (the usual way a
 * model gets a block wrong: the right lines at another indentation). Blank lines at the edges of `search` are
 * ignored. Returns [{start, end}] as 0-based line indexes, end exclusive.
 */
export function findTrimmedBlock(fileLines, search) {
  const want = search.split('\n').map((l) => l.trim());
  while (want.length && want[0] === '') want.shift();
  while (want.length && want[want.length - 1] === '') want.pop();
  if (want.length === 0) return [];
  const found = [];
  for (let i = 0; i + want.length <= fileLines.length; i++) {
    let same = true;
    for (let j = 0; j < want.length && same; j++) same = fileLines[i + j].trim() === want[j];
    if (same) found.push({ start: i, end: i + want.length });
  }
  return found;
}

/** `n` lines on each side of the 1-based line `center`: {start, end, text} with 1-based inclusive line numbers. */
export function excerptAround(text, center, n = 12) {
  const ls = text.split('\n');
  const start = Math.max(1, center - n);
  const end = Math.min(ls.length, center + n);
  return { start, end, text: ls.slice(start - 1, end).join('\n') };
}

/**
 * Apply [{path, search, replace}] to the files under `dir`. `search` must occur exactly once in the file (an
 * empty `search` creates a file that does not exist yet). When it does not occur verbatim but one place holds the
 * same lines ignoring the whitespace at their ends, that place is used and the replacement is moved to its
 * indentation (reported in `fuzzy`). An edit that cannot be applied is reported with its `index` in `edits` and
 * skipped; the others still apply. Returns {applied: [paths], fuzzy: [paths], failed: [{index, path, reason}]}.
 */
export function applyEdits(dir, edits) {
  const applied = [];
  const fuzzy = [];
  const failed = [];
  for (const [index, e] of (Array.isArray(edits) ? edits : []).entries()) {
    if (!e || !safeRelPath(e.path) || typeof e.search !== 'string' || typeof e.replace !== 'string') {
      failed.push({ index, path: String(e?.path ?? ''), reason: 'malformed edit' });
      continue;
    }
    const file = path.join(dir, e.path);
    const exists = fs.existsSync(file);
    if (e.search === '') {
      if (exists) failed.push({ index, path: e.path, reason: 'file exists, empty search' });
      else {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, e.replace);
        applied.push(e.path);
      }
      continue;
    }
    if (!exists) {
      failed.push({ index, path: e.path, reason: 'no such file' });
      continue;
    }
    const text = fs.readFileSync(file, 'utf8');
    const first = text.indexOf(e.search);
    if (first === -1) {
      const fileLines = text.split('\n');
      const places = findTrimmedBlock(fileLines, e.search);
      if (places.length === 1) {
        const { start, end } = places[0];
        const searchLines = e.search.split('\n');
        const searchIndent = indentOf(searchLines.find((l) => l.trim() !== '') ?? '');
        const fileIndent = indentOf(fileLines[start]);
        const moved = e.replace.replace(/\n+$/, '').split('\n').map((l) => (l.trim() === '' ? l : l.startsWith(searchIndent) ? fileIndent + l.slice(searchIndent.length) : l));
        fileLines.splice(start, end - start, ...moved);
        fs.writeFileSync(file, fileLines.join('\n'));
        applied.push(e.path);
        fuzzy.push(e.path);
      } else if (places.length > 1) failed.push({ index, path: e.path, reason: 'search text not unique (ignoring whitespace)' });
      else failed.push({ index, path: e.path, reason: 'search text not found', ...diagnoseMiss(text, e.search) });
    } else if (text.indexOf(e.search, first + 1) !== -1) failed.push({ index, path: e.path, reason: 'search text not unique' });
    else {
      fs.writeFileSync(file, text.slice(0, first) + e.replace + text.slice(first + e.search.length));
      applied.push(e.path);
    }
  }
  return { applied: [...new Set(applied)], fuzzy: [...new Set(fuzzy)], failed };
}

/** First JSON object in model output (string or already parsed), as agents/src/index.ts extractJson. */
export function extractJson(x) {
  if (x && typeof x === 'object' && !Array.isArray(x)) return x;
  if (typeof x !== 'string') return null;
  const s = x.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = s.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try {
        return JSON.parse(s.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Pairs of path sets that share a path, ignoring paths matching `ignore`: [sharing, pairs]. */
export function sharedPathPairs(sets, ignore) {
  let sharing = 0;
  let pairs = 0;
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      pairs++;
      const b = new Set(sets[j]);
      if (sets[i].some((p) => !(ignore && ignore.test(p)) && b.has(p))) sharing++;
    }
  }
  return [sharing, pairs];
}

/** Bucket of the number of commits on the longer side of a pair since the fork. */
export function divergenceBucket(n) {
  return n <= 1 ? '1' : n <= 3 ? '2-3' : n <= 10 ? '4-10' : '>10';
}
export const DIVERGENCE_BUCKETS = ['1', '2-3', '4-10', '>10'];

/**
 * A patch is rejected by the file-level rule when a file it touches was touched by one of the `k` patches that
 * landed just before it. `fileSets` is the stream of patches (arrays of paths) in landing order. `hot` removes
 * matching paths from every set first; a patch with no path left, or with more than `big` paths before that
 * filter, is not counted as a patch (it still counts as a landing). Returns {rejected, n}.
 */
export function streamRejects(fileSets, k, { hot, big = Infinity } = {}) {
  const sets = fileSets.map((s) => new Set(hot ? s.filter((p) => !hot.test(p)) : s));
  let rejected = 0;
  let n = 0;
  for (let i = k; i < sets.length; i++) {
    if (sets[i].size === 0 || fileSets[i].length > big) continue;
    n++;
    let hit = false;
    for (let j = i - k; j < i && !hit; j++) for (const p of sets[i]) if (sets[j].has(p)) { hit = true; break; }
    if (hit) rejected++;
  }
  return { rejected, n };
}

/** Wilson score interval (95%) for k successes in n trials: [low, high] as fractions; [0, 1] when n is 0. */
export function wilson(k, n) {
  if (n === 0) return [0, 1];
  const z = 1.96;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const w = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - w) / d), Math.min(1, (c + w) / d)];
}

const NOT_SOURCE = /\.(md|rst|txt|ya?ml|toml|cfg|ini)$|^docs?\/|^tests?\//i;
const median = (xs) => (xs.length === 0 ? null : [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]);

/**
 * What an agent's patches look like next to the pull requests that closed the same tasks. `tasks` are agent-replay
 * manifest tasks. Source files are the human files that are not documentation, configuration or tests.
 * selection: of the source files the human PRs changed, how many the agent chose to read (tasks with at least one
 * source file only); the files the agent edited are counted per file.
 */
export function footprintSummary(tasks) {
  const committed = tasks.filter((t) => t.status === 'committed');
  const perFile = {};
  for (const t of committed) for (const f of t.editedFiles ?? []) perFile[f] = (perFile[f] ?? 0) + 1;
  let humanSource = 0;
  let hit = 0;
  let tasksWithSource = 0;
  let tasksWithHit = 0;
  for (const t of tasks) {
    const src = (t.humanFiles ?? []).filter((f) => !NOT_SOURCE.test(f) && !HOT.test(f));
    if (src.length === 0) continue;
    const chosen = new Set(t.selected ?? []);
    const h = src.filter((f) => chosen.has(f)).length;
    humanSource += src.length;
    hit += h;
    tasksWithSource++;
    if (h > 0) tasksWithHit++;
  }
  return {
    tasks: tasks.length,
    committed: committed.length,
    medianFilesPerAgentPatch: median(committed.map((t) => (t.editedFiles ?? []).length)),
    medianFilesPerHumanPr: median(tasks.map((t) => (t.humanFiles ?? []).length)),
    editedFiles: Object.fromEntries(Object.entries(perFile).sort((a, b) => b[1] - a[1])),
    selection: { humanSourceFiles: humanSource, readByAgent: hit, tasksWithHumanSource: tasksWithSource, tasksWhereAgentReadOne: tasksWithHit },
  };
}

// ─── Reading large files by ranges ──────────────────────────────────────────

const DEF_LINE = /^\s*(?:export\s+)?(?:async\s+)?(?:def|class|function|const|let|var|type|interface|enum|struct|fn|func|impl|pub)\b/;
/** Definitions with their 1-based line numbers: what an agent sees of a file too large to read whole. */
export function outlineOf(text, max = 700) {
  const out = [];
  text.split('\n').forEach((l, i) => {
    if (DEF_LINE.test(l) && out.length < max) out.push({ line: i + 1, text: l.trim().slice(0, 100) });
  });
  return out;
}

/** Clamp a model's line ranges to the file: at most 3, each at most `maxLines`, sorted, merged; falls back to the head of the file. */
export function cleanRanges(ranges, total, maxLines = 160) {
  const rs = (Array.isArray(ranges) ? ranges : [])
    .map((r) => ({ start: Math.floor(Number(r?.start)), end: Math.floor(Number(r?.end)) }))
    .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end >= r.start && r.start >= 1 && r.start <= total)
    .map((r) => ({ start: r.start, end: Math.min(r.end, r.start + maxLines - 1, total) }))
    .sort((a, b) => a.start - b.start)
    .slice(0, 3);
  const merged = [];
  for (const r of rs) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged.length ? merged : [{ start: 1, end: Math.min(total, maxLines) }];
}

// ─── Workers AI neurons ─────────────────────────────────────────────────────

/** Neurons per million tokens, from https://developers.cloudflare.com/workers-ai/platform/pricing/ (read 2026-10-04). */
export const NEURON_RATES = Object.freeze({
  '@cf/qwen/qwen2.5-coder-32b-instruct': { in: 60000, out: 90909 },
  '@cf/meta/llama-3.1-8b-instruct-fp8': { in: 4119, out: 34868 },
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast': { in: 26668, out: 204805 }, // listed for the non-fast model: an estimate
  '@cf/openai/gpt-oss-20b': { in: 18182, out: 27273 },
  '@cf/google/gemma-3-12b-it': { in: 31371, out: 50560 },
});
export const FREE_NEURONS_PER_DAY = 10000;

export function neuronsFor(model, promptTokens, completionTokens) {
  const r = NEURON_RATES[model];
  if (!r) throw new Error(`no neuron rate for ${model}: add it to NEURON_RATES from the pricing page`);
  return (promptTokens * r.in + completionTokens * r.out) / 1e6;
}

/** Neurons spent per UTC day by these scripts, kept in a small file so separate runs share one budget. */
export function ledgerPath() {
  return process.env.GF_NEURON_LEDGER ?? path.join(os.homedir(), '.cache', 'git-flare-neurons.json');
}
export function ledgerRead(file = ledgerPath(), now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  try {
    return { day, spent: JSON.parse(fs.readFileSync(file, 'utf8'))[day] ?? 0 };
  } catch {
    return { day, spent: 0 };
  }
}
export function ledgerAdd(neurons, file = ledgerPath(), now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  let all = {};
  try {
    all = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    /* first use */
  }
  all[day] = (all[day] ?? 0) + neurons;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(all)}\n`);
  return all[day];
}
