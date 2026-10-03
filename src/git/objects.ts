// Git object encoding and packfile writing, enough for the merge queue to compose a commit in the
// Worker: blob / tree / commit objects (SHA-1 object format) and a version-2 pack of whole objects.
// Hashes are verified against real git in test/objects.test.ts.

const enc = new TextEncoder();

export type ObjectType = 'commit' | 'tree' | 'blob';
const TYPE_CODE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3 };

export interface GitObject {
  type: ObjectType;
  body: Uint8Array;
  hash: string;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export async function sha1Hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-1', bytes));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]{40}$/.test(hex)) throw new Error(`invalid object id ${hex}`);
  const out = new Uint8Array(20);
  for (let i = 0; i < 20; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function makeObject(type: ObjectType, body: Uint8Array): Promise<GitObject> {
  const header = enc.encode(`${type} ${body.length}\0`);
  return { type, body, hash: await sha1Hex(concat([header, body])) };
}

export interface TreeItem {
  name: string;
  /** 'blob' | 'tree' | 'commit' (submodule) */
  type: 'blob' | 'tree' | 'commit';
  mode: string;
  hash: string;
}

/** Canonical git mode string for a tree entry. Trees are written as "40000" (no leading zero). */
export function canonicalMode(item: Pick<TreeItem, 'type' | 'mode'>): string {
  if (item.type === 'tree') return '40000';
  if (item.type === 'commit') return '160000';
  const m = item.mode.replace(/^0+/, '');
  if (m === '100644' || m === '100755' || m === '120000') return m;
  throw new Error(`unsupported blob mode ${item.mode}`);
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/** git sorts tree entries bytewise, comparing directory names as if they ended with "/". */
export function sortTreeItems(items: readonly TreeItem[]): TreeItem[] {
  const key = (i: TreeItem) => enc.encode(i.type === 'tree' ? `${i.name}/` : i.name);
  return [...items].sort((a, b) => compareBytes(key(a), key(b)));
}

export async function makeTree(items: readonly TreeItem[]): Promise<GitObject> {
  const names = new Set<string>();
  const parts: Uint8Array[] = [];
  for (const it of sortTreeItems(items)) {
    if (!it.name || it.name.includes('/') || it.name.includes('\0') || it.name === '.' || it.name === '..') throw new Error(`invalid tree entry name ${JSON.stringify(it.name)}`);
    if (names.has(it.name)) throw new Error(`duplicate tree entry ${it.name}`);
    names.add(it.name);
    parts.push(enc.encode(`${canonicalMode(it)} ${it.name}\0`), hexToBytes(it.hash));
  }
  return makeObject('tree', concat(parts));
}

export interface Signature {
  name: string;
  email: string;
  /** seconds since epoch */
  time: number;
}

const sig = (s: Signature) => `${s.name.replace(/[<>\n]/g, '')} <${s.email.replace(/[<>\n]/g, '')}> ${s.time} +0000`;

export async function makeCommit(opts: { tree: string; parents: string[]; author: Signature; committer: Signature; message: string }): Promise<GitObject> {
  const lines = [`tree ${opts.tree}`, ...opts.parents.map((p) => `parent ${p}`), `author ${sig(opts.author)}`, `committer ${sig(opts.committer)}`, ''];
  const message = opts.message.endsWith('\n') ? opts.message : `${opts.message}\n`;
  return makeObject('commit', enc.encode(`${lines.join('\n')}\n${message}`));
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  // CompressionStream('deflate') produces the zlib (RFC 1950) format git expects.
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function objectHeader(type: ObjectType, size: number): Uint8Array {
  const out: number[] = [];
  let byte = (TYPE_CODE[type] << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  while (size > 0) {
    out.push(byte | 0x80);
    byte = size & 0x7f;
    size = Math.floor(size / 128);
  }
  out.push(byte);
  return new Uint8Array(out);
}

/** Version-2 packfile of whole (non-delta) objects, with SHA-1 trailer. */
export async function writePack(objects: readonly GitObject[]): Promise<Uint8Array> {
  const header = new Uint8Array(12);
  header.set(enc.encode('PACK'), 0);
  const view = new DataView(header.buffer);
  view.setUint32(4, 2);
  view.setUint32(8, objects.length);
  const parts: Uint8Array[] = [header];
  for (const o of objects) parts.push(objectHeader(o.type, o.body.length), await deflate(o.body));
  const body = concat(parts);
  const trailer = hexToBytes(await sha1Hex(body));
  return concat([body, trailer]);
}

// ─── Tree composition ───────────────────────────────────────────────────────

export interface PathUpdate {
  path: string;
  /** null deletes the path */
  blob: { hash: string; mode: string } | null;
}

/**
 * Apply file-level updates to an existing root tree, reading only the directories on the updated paths.
 * Returns the new root tree hash and the tree objects that must be written (bottom-up order).
 * Deletions apply first, so one change can replace a file with a directory (delete `lib`, write `lib/x`) or
 * a directory with a file (delete every file under `lib`, write `lib`); a file over a directory that still
 * holds files, or a directory over a file that stays, is a conflict. Empty directories are pruned.
 */
export async function composeTree(
  readTree: (hash: string) => Promise<TreeItem[] | null>,
  rootTree: string,
  updates: readonly PathUpdate[]
): Promise<{ root: string; objects: GitObject[] }> {
  interface Dir {
    items: Map<string, TreeItem>;
    children: Map<string, Dir>;
  }
  const load = async (hash: string | null): Promise<Dir> => {
    const items = new Map<string, TreeItem>();
    if (hash) {
      const entries = await readTree(hash);
      if (!entries) throw new Error(`tree ${hash} not found`);
      for (const e of entries) items.set(e.name, e);
    }
    return { items, children: new Map() };
  };
  const root = await load(rootTree);
  // A directory every file of which this change deletes (its loaded children emptied too).
  const emptied = (d: Dir): boolean =>
    [...d.items.values()].every((it) => it.type === 'tree' && d.children.has(it.name) && emptied(d.children.get(it.name)!)) && [...d.children.values()].every(emptied);
  for (const u of [...updates.filter((x) => !x.blob), ...updates.filter((x) => x.blob)]) {
    const parts = u.path.split('/');
    if (parts.some((p) => p === '' || p === '.' || p === '..')) throw new Error(`invalid path ${u.path}`);
    let dir = root;
    for (const name of parts.slice(0, -1)) {
      let child = dir.children.get(name);
      if (!child) {
        const existing = dir.items.get(name);
        if (existing && existing.type !== 'tree') throw new Error(`path conflict: ${name} is a file in ${u.path}`);
        child = await load(existing ? existing.hash : null);
        dir.children.set(name, child);
      }
      dir = child;
    }
    const leaf = parts[parts.length - 1];
    if (dir.children.has(leaf) || dir.items.get(leaf)?.type === 'tree') {
      const child = dir.children.get(leaf);
      if (!u.blob || !child || !emptied(child)) throw new Error(`path conflict: ${u.path} is a directory`);
      dir.children.delete(leaf); // the directory this change emptied becomes a file
    }
    if (u.blob) dir.items.set(leaf, { name: leaf, type: 'blob', mode: u.blob.mode, hash: u.blob.hash });
    else dir.items.delete(leaf);
  }
  const objects: GitObject[] = [];
  const build = async (dir: Dir): Promise<string | null> => {
    for (const [name, child] of dir.children) {
      const h = await build(child);
      if (h) dir.items.set(name, { name, type: 'tree', mode: '40000', hash: h });
      else dir.items.delete(name);
    }
    if (dir.items.size === 0) return null;
    const t = await makeTree([...dir.items.values()]);
    objects.push(t);
    return t.hash;
  };
  const rootHash = (await build(root)) ?? (await makeTree([])).hash;
  if (!objects.some((o) => o.hash === rootHash)) objects.push(await makeTree([]));
  return { root: rootHash, objects };
}
