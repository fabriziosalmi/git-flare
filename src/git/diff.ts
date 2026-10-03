// Server-side change computation from repository objects: the platform never trusts a diff sent by an
// agent. Trees are compared by hash, descending only into subtrees whose hash changed.
import { lineDiff, type FileChange } from '../epistemic/changeset.js';
import { SECRET_PATTERNS } from '../gates.js';

export interface CommitInfo {
  hash: string;
  treeHash: string;
  parents: string[];
}

export interface TreeEntry {
  name: string;
  mode: string;
  hash: string;
  type: 'blob' | 'tree' | 'commit';
}

/** Read access to one repository (the agent's fork). */
export interface ObjectReader {
  readCommit(hash: string): Promise<CommitInfo | null>;
  readTree(hash: string): Promise<TreeEntry[] | null>;
  readBlob(hash: string): Promise<Uint8Array | null>;
}

export interface DiffLimits {
  maxFiles: number;
  maxBytes: number;
}

export const DEFAULT_DIFF_LIMITS: DiffLimits = Object.freeze({ maxFiles: 200, maxBytes: 1_000_000 });

export class DiffLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiffLimitError';
  }
}

const dec = new TextDecoder('utf-8', { fatal: false, ignoreBOM: false });
/** Unified hunks kept per patch (characters); past it, a file's change is shown as ordered removed/added lines. */
const HUNKS_BUDGET = 400_000;
/** Myers edit distance spent per patch, over all its files (bounds the CPU a crafted patch can cost). */
const EDIT_BUDGET = 20_000;

/**
 * Printable ASCII runs (tab included) of a binary blob, like `strings`: what reviewers and the gates see of it.
 * Past what reviewers are shown (500 runs, 2,000 characters each), any part a secret pattern matches is still
 * kept, so the secret scan covers the whole blob.
 */
function printableRuns(b: Uint8Array, min = 8, maxRuns = 500, maxLen = 2000): string[] {
  const runs: string[] = [];
  let extra = 0;
  let start = -1;
  for (let i = 0; i <= b.length; i++) {
    const c = b[i];
    const printable = i < b.length && ((c >= 0x20 && c < 0x7f) || c === 0x09);
    if (printable && start < 0) start = i;
    else if (!printable && start >= 0) {
      if (i - start >= min) {
        const run = dec.decode(b.subarray(start, i));
        if (runs.length - extra < maxRuns && run.length <= maxLen) runs.push(run);
        else {
          if (runs.length - extra < maxRuns) runs.push(`${run.slice(0, maxLen)} [...]`);
          for (const [, re] of SECRET_PATTERNS) {
            const m = extra < 1000 ? run.match(re) : null;
            if (m) {
              runs.push(m[0]);
              extra++;
            }
          }
        }
      }
      start = -1;
    }
  }
  return runs;
}

/** First bytes of a blob, hex: lets a gate check that an image, font or media file really is one. */
const magicOf = (b: Uint8Array) => [...b.subarray(0, 16)].map((x) => x.toString(16).padStart(2, '0')).join('');

/** True if `ancestor` is reachable from `descendant` within maxCommits parent steps (BFS). */
export async function isAncestor(reader: ObjectReader, ancestor: string, descendant: string, maxCommits = 200): Promise<boolean> {
  if (ancestor === descendant) return true;
  const seen = new Set<string>([descendant]);
  const queue = [descendant];
  let steps = 0;
  while (queue.length > 0 && steps < maxCommits) {
    const c = await reader.readCommit(queue.shift()!);
    steps++;
    if (!c) continue;
    for (const p of c.parents) {
      if (p === ancestor) return true;
      if (!seen.has(p)) {
        seen.add(p);
        queue.push(p);
      }
    }
  }
  return false;
}

export async function computeChanges(
  reader: ObjectReader,
  baseCommit: string,
  headCommit: string,
  limits: DiffLimits = DEFAULT_DIFF_LIMITS
): Promise<FileChange[]> {
  const [base, head] = await Promise.all([reader.readCommit(baseCommit), reader.readCommit(headCommit)]);
  if (!base) throw new Error(`base commit ${baseCommit} not found`);
  if (!head) throw new Error(`commit ${headCommit} not found`);

  const changes: FileChange[] = [];
  let bytes = 0;

  let hunkChars = 0;
  let editBudget = EDIT_BUDGET;
  const blobText = async (hash: string): Promise<{ text: string; binary: boolean; bytes: Uint8Array }> => {
    const b = await reader.readBlob(hash);
    if (!b) throw new Error(`blob ${hash} not found`);
    bytes += b.length;
    if (bytes > limits.maxBytes) throw new DiffLimitError(`change exceeds ${limits.maxBytes} bytes`);
    return { text: dec.decode(b), binary: b.includes(0), bytes: b };
  };

  const push = (c: FileChange) => {
    changes.push(c);
    if (changes.length > limits.maxFiles) throw new DiffLimitError(`change touches more than ${limits.maxFiles} files`);
  };

  const walk = async (oldTree: string | null, newTree: string | null, prefix: string): Promise<void> => {
    const [o, n] = await Promise.all([
      oldTree ? reader.readTree(oldTree) : Promise.resolve([] as TreeEntry[]),
      newTree ? reader.readTree(newTree) : Promise.resolve([] as TreeEntry[]),
    ]);
    const om = new Map((o ?? []).map((e) => [e.name, e]));
    const nm = new Map((n ?? []).map((e) => [e.name, e]));
    for (const name of [...new Set([...om.keys(), ...nm.keys()])].sort()) {
      const a = om.get(name);
      const b = nm.get(name);
      if (a && b && a.hash === b.hash && a.type === b.type && a.mode === b.mode) continue;
      const path = prefix + name;
      const aTree = a?.type === 'tree' ? a.hash : null;
      const bTree = b?.type === 'tree' ? b.hash : null;
      if (aTree || bTree) await walk(aTree, bTree, `${path}/`);
      const aBlob = a?.type === 'blob' ? a : undefined;
      const bBlob = b?.type === 'blob' ? b : undefined;
      if (!aBlob && !bBlob) continue;
      if (aBlob && bBlob) {
        const modeChange = aBlob.mode !== bBlob.mode ? { modeChange: `${aBlob.mode} -> ${bBlob.mode}` } : {};
        const [x, y] = await Promise.all([blobText(aBlob.hash), blobText(bBlob.hash)]);
        // `binary` describes what lands (the new content): removing an accidental NUL byte gives a readable file.
        if (y.binary) {
          push({ path, status: 'modified', binary: true, added: [], removed: [], strings: printableRuns(y.bytes), magic: magicOf(y.bytes), ...modeChange, blob: { hash: bBlob.hash, mode: bBlob.mode } });
        } else if (x.binary) {
          push({ path, status: 'modified', binary: false, added: y.text.split('\n'), removed: [], ...modeChange, blob: { hash: bBlob.hash, mode: bBlob.mode } });
        } else {
          const { added, removed, hunks, cost } = lineDiff(x.text, y.text, Math.min(2000, editBudget));
          editBudget = Math.max(0, editBudget - cost);
          const keep = hunks && hunkChars + hunks.length <= HUNKS_BUDGET;
          if (keep) hunkChars += hunks.length;
          push({ path, status: 'modified', binary: false, added, removed, ...(keep ? { hunks } : {}), ...modeChange, blob: { hash: bBlob.hash, mode: bBlob.mode } });
        }
      } else if (bBlob) {
        const y = await blobText(bBlob.hash);
        push({ path, status: 'added', binary: y.binary, added: y.binary ? [] : y.text.split('\n'), removed: [], ...(y.binary ? { strings: printableRuns(y.bytes), magic: magicOf(y.bytes) } : {}), blob: { hash: bBlob.hash, mode: bBlob.mode } });
      } else if (aBlob) {
        const x = await blobText(aBlob.hash);
        push({ path, status: 'deleted', binary: x.binary, added: [], removed: x.binary ? [] : x.text.split('\n') });
      }
    }
  };

  await walk(base.treeHash, head.treeHash, '');
  return changes;
}

/** Paths (files, submodules) that differ between two commits. Reads trees only, never blobs. */
export async function changedPaths(reader: ObjectReader, fromCommit: string, toCommit: string, maxPaths = 10_000): Promise<Set<string>> {
  const out = new Set<string>();
  if (fromCommit === toCommit) return out;
  const [a, b] = await Promise.all([reader.readCommit(fromCommit), reader.readCommit(toCommit)]);
  if (!a) throw new Error(`commit ${fromCommit} not found`);
  if (!b) throw new Error(`commit ${toCommit} not found`);
  const walk = async (oldTree: string | null, newTree: string | null, prefix: string): Promise<void> => {
    const [o, n] = await Promise.all([
      oldTree ? reader.readTree(oldTree) : Promise.resolve([] as TreeEntry[]),
      newTree ? reader.readTree(newTree) : Promise.resolve([] as TreeEntry[]),
    ]);
    const om = new Map((o ?? []).map((e) => [e.name, e]));
    const nm = new Map((n ?? []).map((e) => [e.name, e]));
    for (const name of new Set([...om.keys(), ...nm.keys()])) {
      const x = om.get(name);
      const y = nm.get(name);
      if (x && y && x.hash === y.hash && x.type === y.type && x.mode === y.mode) continue; // a mode change is a change
      const path = prefix + name;
      if (x?.type === 'tree' || y?.type === 'tree') await walk(x?.type === 'tree' ? x.hash : null, y?.type === 'tree' ? y.hash : null, `${path}/`);
      if ((x && x.type !== 'tree') || (y && y.type !== 'tree')) out.add(path);
      if (out.size > maxPaths) throw new DiffLimitError(`more than ${maxPaths} paths changed`);
    }
  };
  await walk(a.treeHash, b.treeHash, '');
  return out;
}

/** True if two path sets touch the same file, or one contains a file where the other has a directory. */
export function pathsOverlap(a: Iterable<string>, b: ReadonlySet<string>): string | null {
  for (const p of a) {
    if (b.has(p)) return p;
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) if (b.has(parts.slice(0, i).join('/'))) return p;
    for (const q of b) if (q.startsWith(`${p}/`)) return p;
  }
  return null;
}
