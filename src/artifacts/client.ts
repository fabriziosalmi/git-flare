// Gateway to Cloudflare Artifacts. Two implementations with the same semantics:
//   - NativeArtifacts: Workers binding + git smart HTTP for merges (pack relay or composed commit);
//   - MockArtifacts: in-memory commit graph for local dev and tests (explicit ARTIFACTS_MODE=mock only).
//     With sharding the mock lives in the repository's registry Durable Object and shards reach it through
//     RemoteMockArtifacts, so every Durable Object sees the same repositories.
// Semantics verified on the live service: docs/spikes/artifacts-2026-10-02.md.
import type { CommitInfo, ObjectReader, TreeEntry } from '../git/diff.js';
import { composeTree, makeCommit, makeObject, writePack, type GitObject, type Signature } from '../git/objects.js';
import { deleteRefs, receivePack, relayFastForward, type RelayResult } from '../git/smart-http.js';

export interface MintedToken {
  id: string;
  plaintext: string;
  expiresAt: string;
}

export interface FileUpdate {
  path: string;
  /** null deletes the path */
  blob: { hash: string; mode: string } | null;
  /** repository holding the blob (the author's fork) */
  source: string;
}

export type CommitFilesResult =
  | { ok: true; commit: string; objects: number; packBytes: number; ms: number }
  | { ok: false; reason: 'stale' | 'error'; detail: string };

export interface ArtifactsGateway {
  readonly mode: 'native' | 'mock';
  ensureRepo(name: string): Promise<{ name: string; remote: string }>;
  /** Idempotent: returns the existing fork or creates it (and revokes every token on the new fork). */
  ensureFork(base: string, forkName: string): Promise<{ name: string; remote: string; created: boolean }>;
  head(repo: string, branch: string): Promise<string | null>;
  mintToken(repo: string, scope: 'read' | 'write', ttlSeconds: number): Promise<MintedToken>;
  revokeToken(repo: string, idOrPlaintext: string): Promise<boolean>;
  reader(repo: string): ObjectReader;
  /** Move main to `newSha` (a descendant of expectedOld) by relaying the fork's pack. */
  fastForward(mainRepo: string, forkRepo: string, expectedOld: string, newSha: string): Promise<RelayResult>;
  /** Compose a new commit on top of expectedHead applying whole-file updates, then CAS-update main. */
  commitFiles(mainRepo: string, expectedHead: string, updates: readonly FileUpdate[], message: string, author: Signature): Promise<CommitFilesResult>;
  deleteRepo(name: string): Promise<boolean>;
  /** Point main at `newSha` (an existing commit, fast-forward or not) if it is still `expectedOld`. */
  forceRef(repo: string, expectedOld: string, newSha: string): Promise<{ ok: true } | { ok: false; reason: 'stale' | 'error'; detail: string }>;
  /** Delete branches (full ref names) in one request; refs that do not exist are reported as missing. */
  deleteRefs(repo: string, refs: readonly string[]): Promise<{ deleted: string[]; missing: string[]; failed: string[] }>;
  /** Revoke every active token of `scope` on `repo`; returns how many. */
  revokeTokens(repo: string, scope: 'read' | 'write'): Promise<number>;
  /** Called with every token this gateway mints (the registry uses it to recognise its own tokens on main). */
  onMint?: (repo: string, scope: 'read' | 'write', id: string) => void;
}

/** The binding's expiresAt as ISO 8601 (accepts ISO strings, Dates, unix seconds or ms); falls back to now + TTL. */
export function isoExpiry(v: unknown, ttlSeconds: number): string {
  const ms = typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : v instanceof Date ? v.getTime() : Date.parse(String(v));
  return new Date(Number.isFinite(ms) ? ms : Date.now() + ttlSeconds * 1000).toISOString();
}

export function isNotFound(err: unknown): boolean {
  // The binding throws a plain Error without a code: "ArtifactsError: Repository not found: <name>."
  return /not found/i.test(String((err as Error)?.message ?? err));
}

export function createArtifactsGateway(env: { ARTIFACTS?: any; ARTIFACTS_MODE?: string }, mockHost?: () => MockHost): ArtifactsGateway {
  if (env.ARTIFACTS_MODE === 'mock') return mockHost ? new RemoteMockArtifacts(mockHost) : new MockArtifacts();
  if (env.ARTIFACTS_MODE === 'native') {
    if (!env.ARTIFACTS) throw new Error("ARTIFACTS_MODE=native but the 'ARTIFACTS' binding is not configured");
    return new NativeArtifacts(env.ARTIFACTS);
  }
  throw new Error(`ARTIFACTS_MODE must be 'native' or 'mock', got ${JSON.stringify(env.ARTIFACTS_MODE)}`);
}

// ─── Native ──────────────────────────────────────────────────────────────────

export class NativeArtifacts implements ArtifactsGateway {
  readonly mode = 'native' as const;
  onMint?: (repo: string, scope: 'read' | 'write', id: string) => void;
  constructor(private readonly ns: any) {}

  async ensureRepo(name: string) {
    try {
      const info = await (await this.ns.get(name)).info();
      return { name, remote: info.remote as string };
    } catch (err) {
      if (!isNotFound(err)) throw err;
      const created = await this.ns.create(name, { setDefaultBranch: 'main', description: 'git-flare managed repository' });
      if (created.token) await this.revokeToken(name, created.token); // create() mints a 24h write token
      return { name, remote: created.remote as string };
    }
  }

  async ensureFork(base: string, forkName: string) {
    try {
      const info = await (await this.ns.get(forkName)).info();
      return { name: forkName, remote: info.remote as string, created: false };
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
    let remote: string;
    try {
      const forked = await (await this.ns.get(base)).fork(forkName, { defaultBranchOnly: true, description: `git-flare agent fork of ${base}` });
      remote = forked.remote as string;
    } catch (err) {
      // Observed on the live service: a fork attempt can fail after the repo was created, and get() does
      // not see a just-created repo for a while. "already exists" means it is there: wait until readable.
      if (!/already exists/i.test(String((err as Error)?.message))) throw err;
      remote = await this.waitReadable(forkName);
    }
    await this.revokeAllTokens(forkName); // fork() mints a 24h write token we never hand out
    return { name: forkName, remote, created: true };
  }

  private async waitReadable(name: string): Promise<string> {
    let last: unknown;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        return (await (await this.ns.get(name)).info()).remote as string;
      } catch (err) {
        if (!isNotFound(err)) throw err;
        last = err;
        await new Promise((r) => setTimeout(r, 400 * attempt));
      }
    }
    throw new Error(`repo ${name} exists but is not readable after retries: ${String((last as Error)?.message)}`);
  }

  private async revokeAllTokens(repo: string): Promise<void> {
    const handle = await this.ns.get(repo);
    const list = await handle.listTokens();
    await Promise.allSettled(((list?.tokens ?? []) as Array<{ id: string; state?: string }>).filter((t) => t.state !== 'revoked').map((t) => handle.revokeToken(t.id)));
  }

  async head(repo: string, branch: string): Promise<string | null> {
    try {
      const log = await (await this.ns.get(repo)).log({ ref: branch, limit: 1 });
      return log?.[0]?.hash ?? null;
    } catch (err) {
      if (/not found|unknown revision|empty/i.test(String((err as Error)?.message))) return null;
      throw err;
    }
  }

  async mintToken(repo: string, scope: 'read' | 'write', ttlSeconds: number): Promise<MintedToken> {
    const t = await (await this.ns.get(repo)).createToken(scope, ttlSeconds);
    this.onMint?.(repo, scope, t.id);
    return { id: t.id, plaintext: t.plaintext, expiresAt: isoExpiry(t.expiresAt, ttlSeconds) };
  }

  async revokeToken(repo: string, idOrPlaintext: string): Promise<boolean> {
    try {
      return Boolean(await (await this.ns.get(repo)).revokeToken(idOrPlaintext));
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  reader(repo: string): ObjectReader {
    const handle = () => this.ns.get(repo);
    return {
      readCommit: async (hash) => {
        const c = await (await handle()).readCommit(hash);
        return c ? { hash: c.hash, treeHash: c.treeHash, parents: c.parents ?? [] } : null;
      },
      readTree: async (hash) => ((await (await handle()).readTree(hash)) as TreeEntry[] | null) ?? null,
      readBlob: async (hash) => {
        const b = await (await handle()).readBlob(hash);
        return b ? new Uint8Array(await b.arrayBuffer()) : null;
      },
    };
  }

  private async gitUrl(repo: string): Promise<string> {
    const info = await (await this.ns.get(repo)).info();
    return (info.remote as string).replace(/\.git$/, '') + '.git';
  }

  async fastForward(mainRepo: string, forkRepo: string, expectedOld: string, newSha: string): Promise<RelayResult> {
    const [mainUrl, forkUrl] = await Promise.all([this.gitUrl(mainRepo), this.gitUrl(forkRepo)]);
    const [readTok, writeTok] = await Promise.all([this.mintToken(forkRepo, 'read', 300), this.mintToken(mainRepo, 'write', 300)]);
    try {
      return await relayFastForward({ forkUrl, forkReadToken: readTok.plaintext, mainUrl, mainWriteToken: writeTok.plaintext, expectedOld, newSha });
    } finally {
      await Promise.allSettled([this.revokeToken(forkRepo, readTok.id), this.revokeToken(mainRepo, writeTok.id)]);
    }
  }

  async commitFiles(mainRepo: string, expectedHead: string, updates: readonly FileUpdate[], message: string, author: Signature): Promise<CommitFilesResult> {
    const t0 = Date.now();
    const main = this.reader(mainRepo);
    const head = await main.readCommit(expectedHead);
    if (!head) return { ok: false, reason: 'error', detail: `main head ${expectedHead} not found` };
    const blobs: GitObject[] = [];
    const seen = new Set<string>();
    for (const u of updates) {
      if (!u.blob || seen.has(u.blob.hash)) continue;
      seen.add(u.blob.hash);
      const bytes = await this.reader(u.source).readBlob(u.blob.hash);
      if (!bytes) return { ok: false, reason: 'error', detail: `blob ${u.blob.hash} not found in ${u.source}` };
      const obj = await makeObject('blob', bytes);
      if (obj.hash !== u.blob.hash) return { ok: false, reason: 'error', detail: `blob ${u.blob.hash} content hashes to ${obj.hash}` };
      blobs.push(obj);
    }
    const { root, objects: trees } = await composeTree(async (h) => main.readTree(h), head.treeHash, updates);
    const commit = await makeCommit({ tree: root, parents: [expectedHead], author, committer: author, message });
    const pack = await writePack([...blobs, ...trees, commit]);
    const [url, tok] = await Promise.all([this.gitUrl(mainRepo), this.mintToken(mainRepo, 'write', 300)]);
    try {
      const res = await receivePack({ mainUrl: url, token: tok.plaintext, oldSha: expectedHead, newSha: commit.hash, ref: 'refs/heads/main', pack });
      if (!res.ok) return res;
      return { ok: true, commit: commit.hash, objects: blobs.length + trees.length + 1, packBytes: pack.length, ms: Date.now() - t0 };
    } finally {
      await this.revokeToken(mainRepo, tok.id).catch(() => false);
    }
  }

  async forceRef(repo: string, expectedOld: string, newSha: string) {
    // The objects are already in the repository: an empty pack carries the ref update (CAS on expectedOld).
    const [url, tok] = await Promise.all([this.gitUrl(repo), this.mintToken(repo, 'write', 300)]);
    try {
      return await receivePack({ mainUrl: url, token: tok.plaintext, oldSha: expectedOld, newSha, ref: 'refs/heads/main', pack: await writePack([]) });
    } finally {
      await this.revokeToken(repo, tok.id).catch(() => false);
    }
  }

  async deleteRefs(repo: string, refs: readonly string[]) {
    const [url, tok] = await Promise.all([this.gitUrl(repo), this.mintToken(repo, 'write', 300)]);
    try {
      return await deleteRefs({ url, token: tok.plaintext, refs });
    } finally {
      await this.revokeToken(repo, tok.id).catch(() => false);
    }
  }

  async revokeTokens(repo: string, scope: 'read' | 'write'): Promise<number> {
    const handle = await this.ns.get(repo);
    const list = (((await handle.listTokens())?.tokens ?? []) as Array<{ id: string; scope?: string; state?: string }>).filter((t) => t.scope === scope && t.state !== 'revoked');
    const done = await Promise.allSettled(list.map((t) => handle.revokeToken(t.id)));
    return done.filter((r) => r.status === 'fulfilled').length;
  }

  async deleteRepo(name: string): Promise<boolean> {
    try {
      return Boolean(await this.ns.delete(name));
    } catch (err) {
      if (isNotFound(err)) return false; // already gone
      throw err;
    }
  }
}

// ─── Mock ────────────────────────────────────────────────────────────────────

interface MockCommit {
  hash: string;
  parents: string[];
  files: Map<string, string>;
  message: string;
}

const enc = new TextEncoder();

async function sha1(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-1', enc.encode(s)));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Operations the registry exposes so shards can share its in-memory mock. */
export const MOCK_OPS = ['ensureRepo', 'ensureFork', 'head', 'mintToken', 'revokeToken', 'readCommitOf', 'readTreeOf', 'readBlobOf', 'fastForward', 'commitFiles', 'deleteRepo', 'forceRef', 'revokeTokens', 'deleteRefs', 'commit', 'setRef', 'activeTokens'] as const;
export type MockOp = (typeof MOCK_OPS)[number];
export type MockHost = { mockOp(op: MockOp, args: unknown[]): Promise<unknown> };

/** In-memory Artifacts double: one instance per registry Durable Object; commits shared across its repos. */
export class MockArtifacts implements ArtifactsGateway {
  readonly mode = 'mock' as const;
  onMint?: (repo: string, scope: 'read' | 'write', id: string) => void;
  latencyMs = 0;
  failNext: Partial<Record<'head' | 'mintToken' | 'mintToken:read' | 'mintToken:write' | 'ensureFork' | 'fastForward' | 'commitFiles', string>> = {};
  private repos = new Map<string, { refs: Map<string, string>; tokens: Map<string, { plaintext: string; revoked: boolean; scope: string }> }>();
  private commits = new Map<string, MockCommit>();
  private trees = new Map<string, { commit: string; dir: string }>();
  private blobs = new Map<string, string>();

  private async io(op?: keyof MockArtifacts['failNext']) {
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));
    if (op && this.failNext[op]) {
      const m = this.failNext[op]!;
      delete this.failNext[op];
      throw new Error(m);
    }
  }

  private repo(name: string) {
    const r = this.repos.get(name.toLowerCase());
    if (!r) throw new Error(`ArtifactsError: Repository not found: ${name}.`);
    return r;
  }

  private remote(name: string) {
    return `https://mock.artifacts.invalid/git/mock/${name}.git`;
  }

  async ensureRepo(name: string) {
    await this.io();
    if (!this.repos.has(name.toLowerCase())) this.repos.set(name.toLowerCase(), { refs: new Map(), tokens: new Map() });
    return { name, remote: this.remote(name) };
  }

  async ensureFork(base: string, forkName: string) {
    await this.io('ensureFork');
    if (this.repos.has(forkName.toLowerCase())) return { name: forkName, remote: this.remote(forkName), created: false };
    const b = this.repo(base);
    const refs = new Map<string, string>();
    const main = b.refs.get('main');
    if (main) refs.set('main', main);
    this.repos.set(forkName.toLowerCase(), { refs, tokens: new Map() });
    return { name: forkName, remote: this.remote(forkName), created: true };
  }

  async head(repo: string, branch: string) {
    await this.io('head');
    return this.repo(repo).refs.get(branch) ?? null;
  }

  async mintToken(repo: string, scope: 'read' | 'write', ttlSeconds: number): Promise<MintedToken> {
    await this.io(this.failNext[`mintToken:${scope}`] ? `mintToken:${scope}` : 'mintToken');
    const r = this.repo(repo);
    const id = crypto.randomUUID().slice(0, 16);
    const plaintext = `mock_${scope}_${crypto.randomUUID().replace(/-/g, '')}`;
    r.tokens.set(id, { plaintext, revoked: false, scope });
    this.onMint?.(repo, scope, id);
    return { id, plaintext, expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString() };
  }

  async revokeToken(repo: string, idOrPlaintext: string) {
    await this.io();
    const r = this.repos.get(repo.toLowerCase());
    if (!r) return false;
    for (const [id, t] of r.tokens) {
      if (id === idOrPlaintext || t.plaintext === idOrPlaintext) {
        t.revoked = true;
        return true;
      }
    }
    return false;
  }

  /** Test/dev helper: number of active (not revoked) tokens on a repo. */
  activeTokens(repo: string): number {
    const r = this.repos.get(repo.toLowerCase());
    return r ? [...r.tokens.values()].filter((t) => !t.revoked).length : 0;
  }

  /** Dev helper: point a branch at an existing commit (like `git branch -f`). */
  setRef(repo: string, branch: string, sha: string): void {
    if (!this.commits.has(sha)) throw new Error(`unknown commit ${sha}`);
    this.repo(repo).refs.set(branch, sha);
  }

  /** Dev helper standing in for `git push`: commit file changes on top of a branch. null deletes a file. */
  async commit(repo: string, branch: string, changes: Record<string, string | null>, message: string): Promise<string> {
    const r = this.repo(repo);
    const parent = r.refs.get(branch);
    return this.writeCommit(r, branch, parent, changes, message);
  }

  private async writeCommit(r: { refs: Map<string, string> }, branch: string, parent: string | undefined, changes: Record<string, string | null>, message: string) {
    const files = new Map(parent ? this.commits.get(parent)!.files : []);
    for (const [p, c] of Object.entries(changes)) {
      if (c === null) files.delete(p);
      else files.set(p, c);
    }
    const hash = await sha1(`${parent ?? ''}\n${message}\n${[...files].map(([p, c]) => `${p}\0${c}`).join('\n')}\n${crypto.randomUUID()}`);
    this.commits.set(hash, { hash, parents: parent ? [parent] : [], files, message });
    r.refs.set(branch, hash);
    return hash;
  }

  /** Test helper: file contents of a commit. */
  filesOf(sha: string): Record<string, string> | null {
    const c = this.commits.get(sha);
    return c ? Object.fromEntries(c.files) : null;
  }

  private async treeHash(commit: string, dir: string) {
    const h = await sha1(`tree:${commit}:${dir}:${[...this.commits.get(commit)!.files].filter(([p]) => p.startsWith(dir)).map(([p, c]) => `${p}=${c}`).join('|')}`);
    this.trees.set(h, { commit, dir });
    return h;
  }

  async readCommitOf(repo: string, hash: string): Promise<CommitInfo | null> {
    await this.io();
    this.repo(repo);
    const c = this.commits.get(hash);
    return c ? { hash, treeHash: await this.treeHash(hash, ''), parents: c.parents } : null;
  }

  async readTreeOf(repo: string, hash: string): Promise<TreeEntry[] | null> {
    await this.io();
    this.repo(repo);
    const t = this.trees.get(hash);
    if (!t) return null;
    const files = this.commits.get(t.commit)!.files;
    const entries = new Map<string, TreeEntry>();
    for (const [path, content] of files) {
      if (!path.startsWith(t.dir)) continue;
      const rest = path.slice(t.dir.length);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        const bh = await sha1(`blob:${content}`);
        this.blobs.set(bh, content);
        entries.set(rest, { name: rest, mode: '100644', hash: bh, type: 'blob' });
      } else {
        const name = rest.slice(0, slash);
        if (!entries.has(name)) entries.set(name, { name, mode: '040000', hash: await this.treeHash(t.commit, `${t.dir}${name}/`), type: 'tree' });
      }
    }
    return [...entries.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  async readBlobOf(repo: string, hash: string): Promise<Uint8Array | null> {
    await this.io();
    this.repo(repo);
    const c = this.blobs.get(hash);
    return c === undefined ? null : enc.encode(c);
  }

  reader(repo: string): ObjectReader {
    return {
      readCommit: (hash) => this.readCommitOf(repo, hash),
      readTree: (hash) => this.readTreeOf(repo, hash),
      readBlob: (hash) => this.readBlobOf(repo, hash),
    };
  }

  async fastForward(mainRepo: string, forkRepo: string, expectedOld: string, newSha: string): Promise<RelayResult> {
    await this.io('fastForward');
    const main = this.repo(mainRepo);
    this.repo(forkRepo);
    if (!this.commits.has(newSha)) return { ok: false, reason: 'error', detail: `unknown commit ${newSha}` };
    if ((main.refs.get('main') ?? '') !== expectedOld) return { ok: false, reason: 'stale', detail: 'ng refs/heads/main stale ref' };
    main.refs.set('main', newSha);
    return { ok: true, objects: 0, packBytes: 0, ms: { uploadPack: 0, receivePack: 0 } };
  }

  async commitFiles(mainRepo: string, expectedHead: string, updates: readonly FileUpdate[], message: string): Promise<CommitFilesResult> {
    await this.io('commitFiles');
    const main = this.repo(mainRepo);
    if ((main.refs.get('main') ?? '') !== expectedHead) return { ok: false, reason: 'stale', detail: 'ng refs/heads/main stale ref' };
    const changes: Record<string, string | null> = {};
    for (const u of updates) {
      if (!u.blob) {
        changes[u.path] = null;
        continue;
      }
      const content = this.blobs.get(u.blob.hash);
      if (content === undefined) return { ok: false, reason: 'error', detail: `blob ${u.blob.hash} not found` };
      changes[u.path] = content;
    }
    const commit = await this.writeCommit(main, 'main', expectedHead, changes, message);
    return { ok: true, commit, objects: updates.length + 1, packBytes: 0, ms: 0 };
  }

  async deleteRepo(name: string) {
    await this.io();
    return this.repos.delete(name.toLowerCase());
  }

  async forceRef(repo: string, expectedOld: string, newSha: string) {
    await this.io();
    const r = this.repo(repo);
    if (!this.commits.has(newSha)) return { ok: false as const, reason: 'error' as const, detail: `unknown commit ${newSha}` };
    if ((r.refs.get('main') ?? '') !== expectedOld) return { ok: false as const, reason: 'stale' as const, detail: 'ng refs/heads/main stale ref' };
    r.refs.set('main', newSha);
    return { ok: true as const };
  }

  async deleteRefs(repo: string, refs: readonly string[]) {
    await this.io();
    const r = this.repo(repo);
    const deleted: string[] = [];
    const missing: string[] = [];
    for (const ref of refs) {
      const branch = ref.replace(/^refs\/heads\//, '');
      if (r.refs.delete(branch)) deleted.push(ref);
      else missing.push(ref);
    }
    return { deleted, missing, failed: [] as string[] };
  }

  async revokeTokens(repo: string, scope: 'read' | 'write') {
    await this.io();
    let n = 0;
    for (const t of this.repo(repo).tokens.values()) {
      if (t.scope !== scope || t.revoked) continue;
      t.revoked = true;
      n++;
    }
    return n;
  }
}

/** Shard-side view of the registry's mock: same interface, every call is an RPC to the registry. */
export class RemoteMockArtifacts implements ArtifactsGateway {
  readonly mode = 'mock' as const;
  constructor(private readonly host: () => MockHost) {}
  private call<T>(op: MockOp, ...args: unknown[]): Promise<T> {
    return this.host().mockOp(op, args) as Promise<T>;
  }
  ensureRepo(name: string) {
    return this.call<{ name: string; remote: string }>('ensureRepo', name);
  }
  ensureFork(base: string, forkName: string) {
    return this.call<{ name: string; remote: string; created: boolean }>('ensureFork', base, forkName);
  }
  head(repo: string, branch: string) {
    return this.call<string | null>('head', repo, branch);
  }
  mintToken(repo: string, scope: 'read' | 'write', ttlSeconds: number) {
    return this.call<MintedToken>('mintToken', repo, scope, ttlSeconds);
  }
  revokeToken(repo: string, idOrPlaintext: string) {
    return this.call<boolean>('revokeToken', repo, idOrPlaintext);
  }
  reader(repo: string): ObjectReader {
    return {
      readCommit: (hash) => this.call<CommitInfo | null>('readCommitOf', repo, hash),
      readTree: (hash) => this.call<TreeEntry[] | null>('readTreeOf', repo, hash),
      readBlob: (hash) => this.call<Uint8Array | null>('readBlobOf', repo, hash),
    };
  }
  fastForward(mainRepo: string, forkRepo: string, expectedOld: string, newSha: string) {
    return this.call<RelayResult>('fastForward', mainRepo, forkRepo, expectedOld, newSha);
  }
  commitFiles(mainRepo: string, expectedHead: string, updates: readonly FileUpdate[], message: string, author: Signature) {
    return this.call<CommitFilesResult>('commitFiles', mainRepo, expectedHead, updates, message, author);
  }
  deleteRepo(name: string) {
    return this.call<boolean>('deleteRepo', name);
  }
  forceRef(repo: string, expectedOld: string, newSha: string) {
    return this.call<{ ok: true } | { ok: false; reason: 'stale' | 'error'; detail: string }>('forceRef', repo, expectedOld, newSha);
  }
  revokeTokens(repo: string, scope: 'read' | 'write') {
    return this.call<number>('revokeTokens', repo, scope);
  }
  deleteRefs(repo: string, refs: readonly string[]) {
    return this.call<{ deleted: string[]; missing: string[]; failed: string[] }>('deleteRefs', repo, refs);
  }

  commit(repo: string, branch: string, changes: Record<string, string | null>, message: string) {
    return this.call<string>('commit', repo, branch, changes, message);
  }
  setRef(repo: string, branch: string, sha: string) {
    return this.call<void>('setRef', repo, branch, sha);
  }
}
