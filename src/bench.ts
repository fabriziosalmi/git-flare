// Load probe for Cloudflare Artifacts. Admin-only, and routed only when the Worker has
// BENCH=1 (staging). One invocation runs `n` operations of one kind with `concurrency` in flight; the client
// (scripts/bench-artifacts.mjs) fires many invocations in parallel to reach a target rate.
import { isNotFound } from './artifacts/client.js';

export type BenchOp = 'get' | 'info' | 'token' | 'readTree' | 'refs' | 'clone' | 'fork';
export const BENCH_OPS: readonly BenchOp[] = ['get', 'info', 'token', 'readTree', 'refs', 'clone', 'fork'];

export interface BenchResult {
  op: BenchOp;
  succeeded: number;
  errors: Record<string, number>;
  latencies: number[];
  /** wall time of the measured operations only (setup and token clean-up excluded) */
  opMs: number;
  revoked?: number;
  revokeMs?: number;
  created?: string[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Binding = any;

const normalize = (e: unknown) => String((e as Error)?.message ?? e).replace(/[0-9a-f]{12,}/gi, '<id>').replace(/(?<!HTTP )\d+/g, 'N').slice(0, 140);

async function pool(n: number, concurrency: number, fn: (i: number) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, concurrency) }, async () => {
      while (next < n) await fn(next++);
    })
  );
}

export async function runBench(ns: Binding, p: { op: BenchOp; repo: string; n: number; concurrency: number; tree?: string; tag?: string }): Promise<BenchResult> {
  const res: BenchResult = { op: p.op, succeeded: 0, errors: {}, latencies: [], opMs: 0 };
  const tokens: Array<{ repo: string; id: string }> = [];
  let refsToken: { id: string; plaintext: string } | null = null;
  let remote = '';
  if (p.op === 'refs' || p.op === 'clone') {
    const h = await ns.get(p.repo);
    remote = (await h.info()).remote;
    refsToken = await h.createToken('read', 300);
  }
  const created: string[] = [];
  const tOps = Date.now();
  await pool(p.n, p.concurrency, async (i) => {
    const t0 = Date.now();
    try {
      switch (p.op) {
        case 'get':
          await ns.get(p.repo);
          break;
        case 'info':
          await (await ns.get(p.repo)).info();
          break;
        case 'token': {
          const t = await (await ns.get(p.repo)).createToken('read', 60);
          tokens.push({ repo: p.repo, id: t.id });
          break;
        }
        case 'readTree':
          if (!(await (await ns.get(p.repo)).readTree(p.tree))) throw new Error('readTree returned null');
          break;
        case 'refs': {
          const r = await fetch(`${remote}/info/refs?service=git-upload-pack`, { headers: { Authorization: `Bearer ${refsToken!.plaintext}`, 'Git-Protocol': 'version=2' } });
          await r.arrayBuffer();
          if (!r.ok) throw new Error(`HTTP ${r.status}${r.headers.get('retry-after') ? ` retry-after=${r.headers.get('retry-after')}` : ''}`);
          break;
        }
        case 'clone': {
          // What `git clone` does over smart HTTP (protocol v0): ref advertisement, then the full pack of main.
          const auth = { Authorization: `Bearer ${refsToken!.plaintext}` };
          const adv = await fetch(`${remote}/info/refs?service=git-upload-pack`, { headers: auth });
          const text = await adv.text();
          const head = /([0-9a-f]{40}) refs\/heads\/main/.exec(text)?.[1];
          if (!adv.ok || !head) throw new Error(`HTTP ${adv.status} advertisement`);
          const want = `want ${head} ofs-delta no-progress\n`;
          const body = `${(want.length + 4).toString(16).padStart(4, '0')}${want}00000009done\n`;
          const up = await fetch(`${remote}/git-upload-pack`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/x-git-upload-pack-request', Accept: 'application/x-git-upload-pack-result' }, body });
          const bytes = (await up.arrayBuffer()).byteLength;
          if (!up.ok || bytes < 32) throw new Error(`HTTP ${up.status} upload-pack (${bytes} bytes)`);
          break;
        }
        case 'fork': {
          const name = `${p.repo}--bench-${p.tag ?? 'x'}-${i}`;
          const f = await (await ns.get(p.repo)).fork(name, { defaultBranchOnly: true, description: 'git-flare bench fork' });
          created.push(name);
          if (f?.token?.id) tokens.push({ repo: name, id: f.token.id });
          break;
        }
      }
      res.succeeded++;
      res.latencies.push(Date.now() - t0);
    } catch (e) {
      const k = normalize(e);
      res.errors[k] = (res.errors[k] ?? 0) + 1;
    }
  });
  res.opMs = Date.now() - tOps;
  // Clean up credentials minted by the probe (best effort, counted).
  const tRevoke = Date.now();
  if (tokens.length > 0 || refsToken) {
    let revoked = 0;
    const all = [...tokens, ...(refsToken ? [{ repo: p.repo, id: refsToken.id }] : [])];
    await pool(all.length, 4, async (i) => {
      try {
        if (await (await ns.get(all[i].repo)).revokeToken(all[i].id)) revoked++;
      } catch (e) {
        if (!isNotFound(e)) console.warn('bench revoke failed', normalize(e));
      }
    });
    res.revoked = revoked;
    res.revokeMs = Date.now() - tRevoke;
  }
  if (created.length) res.created = created;
  return res;
}
