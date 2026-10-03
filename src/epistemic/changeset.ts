// What a patch changes. Gates and reviewers get an ORDERED line diff: a line moved elsewhere in a file shows
// up as removed and added (a multiset diff would make a reordering invisible), plus unified hunks with
// context so reviewers see where each change sits. Similarity hashing cancels lines that are both removed
// and added, so it depends only on what changed, not on how the diff aligned the two versions.

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  binary: boolean;
  added: string[];
  removed: string[];
  /** Unified hunks (3 lines of context) of a modified text file; absent when the patch's hunks are too large. */
  hunks?: string;
  /** Binary files: printable runs of the new content (what `strings` shows), for the secret scan and reviewers. */
  strings?: string[];
  /** Binary files: the first 16 bytes of the new content, hex (file type signature). */
  magic?: string;
  /** Mode change of an existing path, e.g. `100644 -> 100755` or `100644 -> 120000` (symlink). */
  modeChange?: string;
  /** Resulting blob (absent for deletions): what the merge queue writes into main. */
  blob?: { hash: string; mode: string };
}

type Edit = { op: ' ' | '-' | '+'; line: string };

/**
 * Myers' shortest edit script between a and b, or null when it needs more than maxD insertions and deletions.
 * Each step keeps only the slice of the frontier the backtrack reads (O(D²) memory, not O(D·(N+M))).
 */
function myers(a: readonly string[], b: readonly string[], maxD: number): Edit[] | null {
  const n = a.length;
  const m = b.length;
  const dMax = Math.min(n + m, maxD);
  const off = dMax + 1;
  const v = new Int32Array(2 * dMax + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= dMax && found < 0; d++) {
    trace.push(v.slice(off - d - 1, off + d + 2)); // k in [-d-1, d+1] at index k + d + 1
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
  }
  if (found < 0) return null;
  const out: Edit[] = [];
  let x = n;
  let y = m;
  for (let d = found; d >= 0; d--) {
    const snap = trace[d];
    const at = (k: number) => snap[k + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      out.push({ op: ' ', line: a[x] });
    }
    if (d > 0) {
      if (x === prevX) out.push({ op: '+', line: b[--y] });
      else out.push({ op: '-', line: a[--x] });
    }
  }
  return out.reverse();
}

/** Unified hunks (`@@ -a,b +c,d @@`, then ' ', '-' and '+' lines) with `context` lines around each change. */
function unifiedHunks(edits: readonly Edit[], context = 3): string {
  const changed: number[] = [];
  edits.forEach((e, i) => e.op !== ' ' && changed.push(i));
  if (!changed.length) return '';
  const oldNo: number[] = [];
  const newNo: number[] = [];
  let o = 0;
  let w = 0;
  for (const e of edits) {
    oldNo.push(o);
    newNo.push(w);
    if (e.op !== '+') o++;
    if (e.op !== '-') w++;
  }
  const out: string[] = [];
  for (let g = 0; g < changed.length; ) {
    let h = g;
    while (h + 1 < changed.length && changed[h + 1] - changed[h] <= 2 * context + 1) h++; // contexts touch: one hunk
    const start = Math.max(0, changed[g] - context);
    const end = Math.min(edits.length - 1, changed[h] + context);
    const span = edits.slice(start, end + 1);
    const oldLen = span.filter((e) => e.op !== '+').length;
    const newLen = span.filter((e) => e.op !== '-').length;
    out.push(`@@ -${oldNo[start] + (oldLen ? 1 : 0)},${oldLen} +${newNo[start] + (newLen ? 1 : 0)},${newLen} @@`);
    for (const e of span) {
      if (e.line.endsWith(NO_EOL)) out.push(e.op + e.line.slice(0, -NO_EOL.length), '\\ No newline at end of file');
      else out.push(e.op + e.line);
    }
    g = h + 1;
  }
  return out.join('\n');
}

// The last line of a text that does not end with a newline carries this mark, so that it differs from the same
// line with one (as in git); it is shown as `\ No newline at end of file` and stripped everywhere else.
const NO_EOL = '\u0000<no newline at end of file>';
function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  else lines[lines.length - 1] += NO_EOL;
  return lines;
}
const plain = (line: string) => (line.endsWith(NO_EOL) ? line.slice(0, -NO_EOL.length) : line);

/**
 * Ordered line diff of a modified text file: Myers after trimming the common prefix and suffix. Past maxEdits,
 * or when the differing middles share no line, the whole middle is reported as removed then added: reviewers
 * see more, never less. `cost` bounds the work done (lines in the differing middles), for a per-patch budget.
 */
export function lineDiff(oldText: string, newText: string, maxEdits = 2000): { added: string[]; removed: string[]; hunks: string; cost: number } {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const am = a.slice(p, a.length - s);
  const bm = b.slice(p, b.length - s);
  const inOld = new Set(am);
  const shared = bm.some((line) => inOld.has(line));
  const script = shared ? myers(am, bm, maxEdits) : null;
  // Work done: the edit distance Myers reached (all of maxEdits when it gave up); nothing when it did not run.
  const cost = !shared ? 0 : script ? script.filter((e) => e.op !== ' ').length : maxEdits;
  const middle = script ?? [...am.map((line) => ({ op: '-' as const, line })), ...bm.map((line) => ({ op: '+' as const, line }))];
  const edits: Edit[] = [...a.slice(0, p).map((line) => ({ op: ' ' as const, line })), ...middle, ...a.slice(a.length - s).map((line) => ({ op: ' ' as const, line }))];
  return {
    added: edits.filter((e) => e.op === '+').map((e) => plain(e.line)),
    removed: edits.filter((e) => e.op === '-').map((e) => plain(e.line)),
    hunks: unifiedHunks(edits),
    cost,
  };
}

export function lineMultisetDiff(oldText: string, newText: string): { added: string[]; removed: string[] } {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const counts = new Map<string, number>();
  for (const l of oldLines) counts.set(l, (counts.get(l) ?? 0) + 1);
  const added: string[] = [];
  for (const l of newLines) {
    const c = counts.get(l) ?? 0;
    if (c > 0) counts.set(l, c - 1);
    else added.push(l);
  }
  const remaining = new Map<string, number>();
  for (const l of newLines) remaining.set(l, (remaining.get(l) ?? 0) + 1);
  const removed: string[] = [];
  for (const l of oldLines) {
    const c = remaining.get(l) ?? 0;
    if (c > 0) remaining.set(l, c - 1);
    else removed.push(l);
  }
  return { added, removed };
}

const normalize = (line: string) => line.trim().replace(/\s+/g, ' ');

/**
 * Canonical text of a change for similarity hashing: one token per changed line,
 * prefixed by polarity and path, whitespace-normalized, sorted. Context lines never appear,
 * so two different fixes in the same region do not look alike because of shared context.
 */
export function canonicalChange(files: readonly FileChange[]): string {
  const tokens: string[] = [];
  for (const f of files) {
    if (f.binary) {
      tokens.push(`~${f.path}\t<binary ${f.status}>`);
      continue;
    }
    // A line both removed and added (moved) cancels out: the multiset difference, whatever the alignment.
    const removed = new Map<string, number>();
    for (const l of f.removed) removed.set(l, (removed.get(l) ?? 0) + 1);
    for (const l of f.added) {
      const c = removed.get(l) ?? 0;
      if (c > 0) {
        removed.set(l, c - 1);
        continue;
      }
      const n = normalize(l);
      if (n) tokens.push(`+${f.path}\t${n}`);
    }
    for (const [l, c] of removed) {
      const n = normalize(l);
      if (n) for (let i = 0; i < c; i++) tokens.push(`-${f.path}\t${n}`);
    }
  }
  return tokens.sort().join('\n');
}
