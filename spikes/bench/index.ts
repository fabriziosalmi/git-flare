// Throughput probe for the Durable Objects in the production runtime, Artifacts mocked inside the registry
// (so the numbers are the objects' own capacity: logic + SQLite-backed storage + RPC). Deployed only for the
// measurement, behind an unguessable path segment (secret BENCH_TOKEN), then deleted.
//
//   GET /<token>/claims?n=400&run=<id>           registry + 1 shard: n joins, n first claims, then n steady-state claims
//   GET /<token>/reviews?from=A&to=B&n=200&run=<id>[&fresh=0]  registry: add edges [A,B), then n concurrent recordReview
//
// Inside a Worker Date.now() advances only on I/O, so only wall times across awaits are meaningful.
import { RepoCoordinator } from '../../src/durable_objects/RepoCoordinator';
import { RepoRegistry } from '../../src/durable_objects/RepoRegistry';

export { RepoCoordinator, RepoRegistry };

interface Env {
  REPO_COORDINATOR: DurableObjectNamespace<RepoCoordinator>;
  REPO_REGISTRY: DurableObjectNamespace<RepoRegistry>;
  BENCH_TOKEN: string;
}

const id = (agentId: string, role: 'worker' | 'reviewer') => ({ agentId, role, family: `f${agentId.length % 4}` });

async function inBatches<T>(n: number, size: number, fn: (i: number) => Promise<T>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < n; i += size) out.push(...(await Promise.all(Array.from({ length: Math.min(size, n - i) }, (_, j) => fn(i + j)))));
  return out;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handle(request, env);
    } catch (e) {
      return Response.json({ error: String((e as Error)?.message ?? e).slice(0, 400) }, { status: 500 });
    }
  },
};

async function handle(request: Request, env: Env): Promise<Response> {
  {
    const u = new URL(request.url);
    const [, token, op] = u.pathname.split('/');
    if (!env.BENCH_TOKEN || token !== env.BENCH_TOKEN) return new Response('not found', { status: 404 });
    const run = (u.searchParams.get('run') ?? 'x').toLowerCase().replace(/[^a-z0-9-]/g, '');
    const n = Math.min(Number(u.searchParams.get('n') ?? '200'), 1000);
    const repo = `b${op}${run}`;
    const registry = env.REPO_REGISTRY.get(env.REPO_REGISTRY.idFromName(repo));
    const init = await registry.init(repo, 1, u.searchParams.get('fresh') !== '0');
    if (!init.ok) return Response.json(init, { status: 500 });

    if (op === 'claims') {
      const shard = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(`${repo}#0`));
      // Each of n agents claims twice: the first claim of an agent on a shard asks the registry for its fork
      // (one RPC, then cached by the shard); the second is the steady state.
      const tasks = Array.from({ length: 2 * n }, (_, i) => ({ id: `T${i}`, title: `task ${i}`, description: '' }));
      await shard.init(repo, 0, 1, init.config.remote, tasks, true);
      const workers = Array.from({ length: n }, (_, i) => id(`a${i}`, 'worker'));
      const tj = Date.now();
      const joins = await Promise.all(workers.map((w) => registry.join(w)));
      const joinMs = Date.now() - tj;
      const timed = async (offset: number) => {
        const t = Date.now();
        const res = await Promise.all(workers.map((w, i) => shard.claim(w, `T${offset + i}`, 60_000)));
        const ms = Date.now() - t;
        return { ok: res.filter((r) => r.ok).length, wallMs: ms, perSec: Math.round((n / Math.max(1, ms)) * 1000) };
      };
      const first = await timed(0);
      const steady = await timed(n);
      return Response.json({
        op,
        n,
        joins: { ok: joins.filter((r) => r.ok).length, wallMs: joinMs, perSec: Math.round((n / Math.max(1, joinMs)) * 1000) },
        firstClaims: first,
        claims: steady,
      });
    }

    if (op === 'reviews') {
      // Role-separated swarm: reviewers r0..r(R-1) approve workers w0..w(W-1); no identity both reviews and works.
      // prefill=[from,to) edges are added first (call repeatedly with fresh=0 to grow the graph past the
      // per-invocation subrequest limit), then n concurrent recordReview calls are timed.
      const from = Number(u.searchParams.get('from') ?? '0');
      const to = Math.min(Number(u.searchParams.get('to') ?? '0'), from + 5000);
      const R = 500;
      const W = 5000;
      const edge = (i: number) => [`r${i % R}`, `w${Math.floor(i / R) % W}`] as const;
      const tp = Date.now();
      await inBatches(Math.max(0, to - from), 100, (k) => registry.recordReview(edge(from + k)[0], edge(from + k)[1], true));
      const prefillMs = Date.now() - tp;
      const tr = Date.now();
      const res = await Promise.all(Array.from({ length: n }, (_, k) => registry.recordReview(`r${(k * 7) % R}`, `w${(to + k * 13) % W}`, true)));
      const reviewMs = Date.now() - tr;
      return Response.json({
        op,
        edgesBefore: to,
        added: Math.max(0, to - from),
        prefillMs,
        n,
        reviews: { ok: res.length, excludedTotal: res.reduce((a, r) => a + r.length, 0), wallMs: reviewMs, perSec: Math.round((n / Math.max(1, reviewMs)) * 1000) },
      });
    }
    return new Response('unknown op', { status: 404 });
  }
}
