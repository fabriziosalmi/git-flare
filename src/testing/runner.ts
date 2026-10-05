// Project tests for the merge queue. The repository declares its test commands in `.gitflare/gates.json`
// on main (agents cannot change it: `.gitflare/` is a protected path). Before a batch lands, the registry
// materializes the composed tree (main + the batch's files) and runs those commands on it in an isolated
// container with no network access; only a passing tree is pushed.
import type { FileUpdate } from '../artifacts/client.js';
import type { ObjectReader, TreeEntry } from '../git/diff.js';
import { writeTar, type TarEntry } from '../git/tar.js';

export const GATES_PATH = '.gitflare/gates.json';

export interface TestConfig {
  /** Dependency install, run before the commands with read-only access to the npm registry (see registry-proxy.ts). */
  install: string[];
  commands: string[];
  timeoutMs: number;
}

export interface TestRun {
  passed: boolean;
  results: Array<{ command: string; exitCode: number; ms: number; timedOut?: boolean; phase?: 'install' }>;
  logTail: string;
  ms: number;
  /** container image the run used (provenance) */
  image?: string;
}

export interface TestRunnerGateway {
  readonly mode: 'container' | 'mock';
  run(files: TarEntry[], config: TestConfig): Promise<TestRun>;
}

export const MATERIALIZE_LIMITS = Object.freeze({ maxFiles: 5000, maxBytes: 50_000_000 });
const LOG_TAIL_BYTES = 4000;

const dec = new TextDecoder();

export function parseTestConfig(raw: string): TestConfig | { error: string } {
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    return { error: `${GATES_PATH} is not valid JSON` };
  }
  const t = (j as { test?: { commands?: unknown; timeoutSec?: unknown; install?: unknown } })?.test;
  if (t === undefined) return { error: `${GATES_PATH} has no "test" section` };
  const commands = t.commands;
  if (!Array.isArray(commands) || commands.length < 1 || commands.length > 10 || !commands.every((c) => typeof c === 'string' && c.length > 0 && c.length <= 500)) {
    return { error: 'test.commands must be 1..10 non-empty strings of at most 500 characters' };
  }
  const timeoutSec = t.timeoutSec === undefined ? 300 : t.timeoutSec;
  if (typeof timeoutSec !== 'number' || !Number.isInteger(timeoutSec) || timeoutSec < 10 || timeoutSec > 900) return { error: 'test.timeoutSec must be an integer in 10..900' };
  const install = t.install === undefined ? [] : t.install;
  if (!Array.isArray(install) || install.length > 5 || !install.every((c) => typeof c === 'string' && c.length > 0 && c.length <= 500)) {
    return { error: 'test.install must be at most 5 non-empty strings of at most 500 characters' };
  }
  return { install: install as string[], commands: commands as string[], timeoutMs: timeoutSec * 1000 };
}

/** Read one file at a commit by walking its tree. */
export async function readFileAt(reader: ObjectReader, commit: string, path: string): Promise<string | null> {
  const c = await reader.readCommit(commit);
  if (!c) return null;
  let tree = c.treeHash;
  const parts = path.split('/');
  for (let i = 0; i < parts.length; i++) {
    const entries = await reader.readTree(tree);
    const e = entries?.find((x) => x.name === parts[i]);
    if (!e) return null;
    if (i === parts.length - 1) {
      if (e.type !== 'blob') return null;
      const b = await reader.readBlob(e.hash);
      return b ? dec.decode(b) : null;
    }
    if (e.type !== 'tree') return null;
    tree = e.hash;
  }
  return null;
}

/** Every file of a tree (recursive), with blob id and mode. Submodules are skipped. */
export async function listFiles(reader: ObjectReader, treeHash: string, maxFiles = MATERIALIZE_LIMITS.maxFiles): Promise<Map<string, { hash: string; mode: string }>> {
  const out = new Map<string, { hash: string; mode: string }>();
  const walk = async (hash: string, prefix: string): Promise<void> => {
    const entries = (await reader.readTree(hash)) as TreeEntry[] | null;
    if (!entries) throw new Error(`tree ${hash} not found`);
    for (const e of entries) {
      if (e.type === 'tree') await walk(e.hash, `${prefix}${e.name}/`);
      else if (e.type === 'blob') out.set(`${prefix}${e.name}`, { hash: e.hash, mode: e.mode.replace(/^0+/, '') });
      if (out.size > maxFiles) throw new Error(`tree has more than ${maxFiles} files`);
    }
  };
  await walk(treeHash, '');
  return out;
}

/**
 * Files of the tree a batch would produce: main's head with the batch's updates applied. Blob contents are
 * cached by id across rounds (unchanged files are read once per registry lifetime).
 */
export async function materialize(
  main: ObjectReader,
  readerFor: (repo: string) => ObjectReader,
  head: string,
  updates: readonly FileUpdate[],
  cache: Map<string, Uint8Array>
): Promise<TarEntry[]> {
  const commit = await main.readCommit(head);
  if (!commit) throw new Error(`main head ${head} not found`);
  const files = new Map<string, { hash: string; mode: string; source?: string }>(await listFiles(main, commit.treeHash));
  for (const u of updates) {
    if (u.blob) files.set(u.path, { hash: u.blob.hash, mode: u.blob.mode.replace(/^0+/, ''), source: u.source });
    else files.delete(u.path);
  }
  if (files.size > MATERIALIZE_LIMITS.maxFiles) throw new Error(`tree has more than ${MATERIALIZE_LIMITS.maxFiles} files`);
  let bytes = 0;
  const entries: TarEntry[] = [];
  for (const [path, f] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
    let content = cache.get(f.hash);
    if (!content) {
      const b = await (f.source ? readerFor(f.source) : main).readBlob(f.hash);
      if (!b) throw new Error(`blob ${f.hash} (${path}) not found`);
      content = b;
      cache.set(f.hash, content);
    }
    bytes += content.length;
    if (bytes > MATERIALIZE_LIMITS.maxBytes) throw new Error(`tree exceeds ${MATERIALIZE_LIMITS.maxBytes} bytes`);
    entries.push({ path, mode: f.mode, content });
  }
  // Bound the cache: drop everything not in the current tree once it grows past the byte limit.
  let cached = 0;
  for (const v of cache.values()) cached += v.length;
  if (cached > MATERIALIZE_LIMITS.maxBytes) {
    const keep = new Set([...files.values()].map((f) => f.hash));
    for (const k of [...cache.keys()]) if (!keep.has(k)) cache.delete(k);
  }
  return entries;
}

/**
 * Deterministic stand-in for dev and tests. A tree fails when a file contains "@gf-test-fail", or when two
 * or more files contain "@gf-test-pair" (models two individually fine patches that break together).
 */
export class MockTestRunner implements TestRunnerGateway {
  readonly mode = 'mock' as const;
  runs = 0;
  /** How long a run takes (dev only: a load simulation needs the composed-tree tests to last). */
  delayMs = 0;
  async run(files: TarEntry[], config: TestConfig): Promise<TestRun> {
    this.runs++;
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    const text = files.map((f) => ({ path: f.path, body: dec.decode(f.content) }));
    const failing = text.filter((f) => f.body.includes('@gf-test-fail')).map((f) => f.path);
    const pairs = text.filter((f) => f.body.includes('@gf-test-pair')).map((f) => f.path);
    const passed = failing.length === 0 && pairs.length < 2;
    const why = failing.length ? `failing marker in ${failing.join(', ')}` : pairs.length >= 2 ? `incompatible pair: ${pairs.join(' + ')}` : 'ok';
    const install = config.install.map((command) => ({ command, exitCode: 0, ms: 0, phase: 'install' as const }));
    return { passed, results: [...install, ...config.commands.map((command) => ({ command, exitCode: passed ? 0 : 1, ms: 0 }))], logTail: `[mock runner] ${files.length} files: ${why}`, ms: this.delayMs };
  }
}

/** Runs the tests in the repository's TestRunner Durable Object (a container without network access). */
export class ContainerTestRunner implements TestRunnerGateway {
  readonly mode = 'container' as const;
  constructor(private readonly stub: () => { run(tar: Uint8Array, commands: string[], timeoutMs: number, install?: string[]): Promise<TestRun> }) {}
  run(files: TarEntry[], config: TestConfig): Promise<TestRun> {
    return this.stub().run(writeTar(files), config.commands, config.timeoutMs, config.install);
  }
}

export function tail(text: string, bytes = LOG_TAIL_BYTES): string {
  return text.length <= bytes ? text : `…${text.slice(text.length - bytes)}`;
}
