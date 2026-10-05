import aimpWasmModule from '../crates/aimp-wasm/pkg/aimp_wasm_bg.wasm';
import { bearer, issueAgentKey, secretEquals, verifyAgentKey, type AgentIdentity, type AgentRole } from './auth.js';
import { LIMITS, RepoCoordinator } from './durable_objects/RepoCoordinator.js';
import { MAX_MIRRORS, RepoRegistry, type RepoConfig } from './durable_objects/RepoRegistry.js';
import { REVOCATION_LIST_TTL_MS, Revocations, type RevocationList } from './durable_objects/Revocations.js';
import { TestRunner } from './durable_objects/TestRunner.js';
import { RegistryProxy } from './testing/registry-proxy.js';
import { AimpEngine } from './epistemic/aimp.js';
import { normalizeFamily } from './epistemic/policy.js';
import { DEFAULT_SHARDS, MAX_SHARDS, shardName, shardOf, shardOfPatch } from './routing.js';
import { renderDashboardHtml } from './ui/dashboard.js';
import interFont from './ui/fonts/inter-latin-wght-normal.woff2';
import { baseRepoOf, parseArtifactsEvent, type ArtifactsEvent } from './guard.js';
import { BENCH_OPS, runBench, type BenchOp } from './bench.js';
import { asObject, bool, ID_RE, int, readJson, rejectUnknown, REPO_RE, SHA_RE, str, ValidationError } from './validation.js';

export { RegistryProxy, RepoCoordinator, RepoRegistry, Revocations, TestRunner };

export interface Env {
  REPO_COORDINATOR: DurableObjectNamespace<RepoCoordinator>;
  REPO_REGISTRY: DurableObjectNamespace<RepoRegistry>;
  TEST_RUNNER?: DurableObjectNamespace<TestRunner>;
  REVOCATIONS: DurableObjectNamespace<Revocations>;
  /** Cloudflare Rate Limiting binding, keyed by agent id (per location, approximate by design). */
  AGENT_LIMITER?: { limit(o: { key: string }): Promise<{ success: boolean }> };
  ARTIFACTS?: unknown;
  ARTIFACTS_MODE?: string;
  ADMIN_KEY?: string;
  AUTH_SECRET?: string;
  /** '1' routes the admin-only Artifacts load probe (staging only). */
  BENCH?: string;
}

const MAX_BODY = 64 * 1024;
const MAX_DEV_COMMIT_BODY = 512 * 1024;
const AGENT_KEY_DEFAULT_DAYS = 30;

class HttpError extends Error {
  constructor(public readonly status: number, public readonly code: string, message?: string, public readonly headers?: Record<string, string>) {
    super(message ?? code);
  }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });

type AnyResult = { ok: true } | { ok: false; status: number; error: string; detail?: string };

function fromResult(r: AnyResult, okStatus = 200): Response {
  if (r.ok) return json(okStatus, r);
  return json(r.status, { ok: false, error: r.error, ...(r.detail ? { detail: r.detail } : {}) });
}

async function requireAdmin(request: Request, env: Env): Promise<void> {
  if (!env.ADMIN_KEY || env.ADMIN_KEY.length < 32) throw new HttpError(503, 'ADMIN_KEY_NOT_CONFIGURED');
  const k = bearer(request);
  if (!k || !(await secretEquals(k, env.ADMIN_KEY))) throw new HttpError(401, 'UNAUTHORIZED');
}

async function requireAgent(request: Request, env: Env, role?: AgentRole): Promise<AgentIdentity> {
  if (!env.AUTH_SECRET || env.AUTH_SECRET.length < 32) throw new HttpError(503, 'AUTH_SECRET_NOT_CONFIGURED');
  const k = bearer(request);
  const id = k ? await verifyAgentKey(env.AUTH_SECRET, k, Date.now()) : null;
  if (!id) throw new HttpError(401, 'UNAUTHORIZED');
  const through = (await revocationList(env)).revokedThrough[id.agentId];
  if (through !== undefined && (id.issuedAt ?? 0) <= through) throw new HttpError(401, 'KEY_REVOKED');
  await agentRateLimit(env, id.agentId);
  if (role && id.role !== role) throw new HttpError(403, `${role.toUpperCase()}_ROLE_REQUIRED`);
  return id;
}

/** Per-agent request budget (binding optional: absent in local dev and tests). */
export async function agentRateLimit(env: Pick<Env, 'AGENT_LIMITER'>, agentId: string): Promise<void> {
  if (!env.AGENT_LIMITER) return;
  const { success } = await env.AGENT_LIMITER.limit({ key: agentId });
  if (!success) throw new HttpError(429, 'RATE_LIMITED', undefined, { 'Retry-After': '10' });
}

// Revocation list, cached per isolate (see Revocations.ts). A failed refresh keeps serving the last list;
// with no list at all, authenticated requests fail closed.
let revocations: { list: RevocationList; at: number } | null = null;
let revocationsInflight: Promise<RevocationList> | null = null;
const revocationsStub = (env: Env) => env.REVOCATIONS.get(env.REVOCATIONS.idFromName('global'));

async function revocationList(env: Env): Promise<RevocationList> {
  if (revocations && Date.now() - revocations.at < REVOCATION_LIST_TTL_MS) return revocations.list;
  revocationsInflight ??= revocationsStub(env)
    .getList()
    .then((list) => {
      revocations = { list, at: Date.now() };
      return list;
    })
    .finally(() => (revocationsInflight = null));
  try {
    return await revocationsInflight;
  } catch (e) {
    if (revocations) {
      console.warn('revocation list refresh failed, serving the cached one', String((e as Error).message));
      return revocations.list;
    }
    throw new HttpError(503, 'REVOCATIONS_UNAVAILABLE');
  }
}

let aimp: Promise<AimpEngine> | null = null;
// Shard count is immutable per repository name, so routing config can be cached for the isolate's life.
const configCache = new Map<string, RepoConfig>();

const registryOf = (env: Env, repo: string) => env.REPO_REGISTRY.get(env.REPO_REGISTRY.idFromName(repo));
const shardStub = (env: Env, repo: string, shard: number) => env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(shardName(repo, shard)));

async function repoConfig(env: Env, repo: string): Promise<RepoConfig> {
  const cached = configCache.get(repo);
  if (cached) return cached;
  const cfg = await registryOf(env, repo).getConfig();
  if (!cfg) throw new HttpError(404, 'REPO_NOT_INITIALIZED');
  configCache.set(repo, cfg);
  return cfg;
}

async function taskShard(env: Env, repo: string, taskId: string) {
  const cfg = await repoConfig(env, repo);
  return shardStub(env, repo, shardOf(taskId, cfg.shards));
}

async function patchShard(env: Env, repo: string, patchId: string) {
  const cfg = await repoConfig(env, repo);
  const s = shardOfPatch(patchId);
  if (s === null || s >= cfg.shards) throw new HttpError(404, 'PATCH_NOT_FOUND');
  return shardStub(env, repo, s);
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (method === 'GET' && (path === '/' || path === '/index.html')) {
    const repo = url.searchParams.get('repo') ?? 'demo';
    return new Response(renderDashboardHtml(REPO_RE.test(repo) ? repo : 'demo'), {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'" },
    });
  }
  if (method === 'GET' && path === '/fonts/inter.woff2') {
    // Inter (SIL Open Font License 1.1, src/ui/fonts/LICENSE-Inter.txt), served same-origin for the dashboard.
    return new Response(interFont, { headers: { 'Content-Type': 'font/woff2', 'Cache-Control': 'public, max-age=31536000, immutable' } });
  }
  if (method === 'GET' && path === '/api/health') return json(200, { ok: true, mode: env.ARTIFACTS_MODE ?? null });

  if (method === 'GET' && path === '/api/whoami') {
    const k = bearer(request);
    if (k && env.ADMIN_KEY && env.ADMIN_KEY.length >= 32 && (await secretEquals(k, env.ADMIN_KEY))) return json(200, { ok: true, admin: true });
    const id = await requireAgent(request, env);
    return json(200, { ok: true, admin: false, agentId: id.agentId, role: id.role, modelFamily: id.family });
  }

  if (method === 'POST' && path === '/api/agents') {
    await requireAdmin(request, env);
    if (!env.AUTH_SECRET || env.AUTH_SECRET.length < 32) throw new HttpError(503, 'AUTH_SECRET_NOT_CONFIGURED');
    const b = await readJson(request, MAX_BODY);
    rejectUnknown(b, ['agentId', 'role', 'modelFamily', 'ttlDays']);
    const agentId = str(b, 'agentId', { max: 64, re: ID_RE });
    const role = str(b, 'role', { max: 16, re: /^(worker|reviewer)$/ }) as AgentRole;
    const family = normalizeFamily(str(b, 'modelFamily', { max: 64, optional: true, min: 0 }));
    const ttlDays = int(b, 'ttlDays', { min: 1, max: 365, optional: true, fallback: AGENT_KEY_DEFAULT_DAYS });
    const apiKey = await issueAgentKey(env.AUTH_SECRET, { agentId, role, family }, Date.now(), ttlDays * 86_400_000);
    return json(201, { ok: true, agentId, role, modelFamily: family, apiKey });
  }

  if (method === 'POST' && path === '/api/bench/artifacts' && env.BENCH === '1' && env.ARTIFACTS_MODE === 'native') {
    await requireAdmin(request, env);
    const b = await readJson(request, MAX_BODY);
    rejectUnknown(b, ['op', 'repo', 'n', 'concurrency', 'tree', 'tag']);
    const op = str(b, 'op', { max: 16 }) as BenchOp;
    if (!BENCH_OPS.includes(op)) throw new ValidationError('op', `one of ${BENCH_OPS.join(', ')}`);
    const repo = str(b, 'repo', { max: 64, re: REPO_RE });
    const n = int(b, 'n', { min: 1, max: 500 });
    const concurrency = int(b, 'concurrency', { min: 1, max: 64, optional: true, fallback: 6 });
    const tree = str(b, 'tree', { max: 40, re: SHA_RE, optional: true });
    const tag = str(b, 'tag', { max: 16, re: ID_RE, optional: true });
    const t0 = Date.now();
    const r = await runBench(env.ARTIFACTS, { op, repo, n, concurrency, tree: tree || undefined, tag: tag || undefined });
    return json(200, { ok: true, ms: Date.now() - t0, ...r });
  }

  const revoke = method === 'POST' ? /^\/api\/agents\/([^/]+)\/revoke$/.exec(path) : null;
  if (revoke) {
    await requireAdmin(request, env);
    if (!ID_RE.test(revoke[1]) || revoke[1].length > 64) throw new ValidationError('agentId', 'invalid');
    // Every key of the agent issued up to this second is refused; keys issued from the next second on work.
    const list = await revocationsStub(env).revoke(revoke[1], Math.floor(Date.now() / 1000));
    revocations = { list, at: Date.now() };
    return json(200, { ok: true, agentId: revoke[1], revokedThrough: list.revokedThrough[revoke[1]], propagationSec: REVOCATION_LIST_TTL_MS / 1000 });
  }

  if (method === 'POST' && path === '/api/epistemic/compare') {
    const b = await readJson(request, MAX_BODY);
    const a = str(b, 'textA', { max: 20_000, min: 0 });
    const c = str(b, 'textB', { max: 20_000, min: 0 });
    aimp ??= AimpEngine.create(aimpWasmModule);
    const engine = await aimp;
    const hashA = engine.computeSimHash(a);
    const hashB = engine.computeSimHash(c);
    const distance = engine.hammingDistance(hashA, hashB);
    return json(200, { ok: true, hashA, hashB, distance, nearDuplicate: distance <= LIMITS.duplicateThresholdBits });
  }

  const m = path.match(/^\/api\/repos\/([^/]+)(?:\/([a-z-]+)(?:\/([^/]+)(?:\/([a-z]+))?)?)?$/);
  if (!m) throw new HttpError(404, 'NOT_FOUND');
  const [, repo, action, sub, subAction] = m;
  if (!REPO_RE.test(repo)) throw new ValidationError('repo', `must match ${REPO_RE}`);

  if (method === 'GET' && action === 'status' && !sub) {
    const registry = await registryOf(env, repo).status();
    if (!registry.config) return json(200, { ok: true, repo: null, mode: env.ARTIFACTS_MODE ?? null, shards: 0, tasks: [], patches: [], stats: {}, queue: { length: 0 } });
    type ShardStatus = { tasks: Array<{ id: string }>; patches: Array<{ submittedAt: number }>; stats: Record<string, number> };
    const shards = (await Promise.all(Array.from({ length: registry.config.shards }, (_, i) => shardStub(env, repo, i).status()))) as unknown as ShardStatus[];
    const stats: Record<string, number> = {};
    for (const s of shards) for (const [k, v] of Object.entries(s.stats)) stats[k] = (stats[k] ?? 0) + v;
    return json(200, {
      ok: true,
      repo,
      mode: registry.config.mode,
      shards: registry.config.shards,
      forks: registry.forks,
      tasks: shards.flatMap((s) => s.tasks).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      patches: shards
        .flatMap((s) => s.patches)
        .sort((a, b) => b.submittedAt - a.submittedAt)
        .slice(0, LIMITS.statusPatchLimit),
      stats,
      queue: { length: registry.queue.length, pending: registry.queue, ...registry.stats, recent: registry.recent, bisecting: registry.bisecting, lastError: registry.lastError, testRunner: registry.testRunner },
      guard: registry.guard,
      mirrors: registry.mirrors,
    });
  }

  if (method === 'DELETE' && !action) {
    await requireAdmin(request, env);
    // Shards first (their tasks and patches), then the registry deletes forks and main over repeated calls.
    const cfg = configCache.get(repo) ?? (await registryOf(env, repo).getConfig());
    if (cfg) await Promise.all(Array.from({ length: cfg.shards }, (_, i) => shardStub(env, repo, i).destroy()));
    const r = await registryOf(env, repo).destroy();
    if (r.ok && r.done) configCache.delete(repo);
    return fromResult(r);
  }

  if (method === 'POST' && action === 'init' && !sub) {
    await requireAdmin(request, env);
    const b = await readJson(request, MAX_BODY * 8);
    rejectUnknown(b, ['tasks', 'reset', 'shards', 'mirrors']);
    const reset = bool(b, 'reset', false);
    const shards = int(b, 'shards', { min: 1, max: MAX_SHARDS, optional: true, fallback: DEFAULT_SHARDS });
    const mirrors = int(b, 'mirrors', { min: 0, max: MAX_MIRRORS, optional: true, fallback: 0 });
    const raw = b.tasks ?? [];
    if (!Array.isArray(raw) || raw.length > 1000) throw new ValidationError('tasks', 'must be an array of at most 1000 items');
    const tasks = raw.map((t, i) => {
      const o = asObject(t, `tasks[${i}]`);
      rejectUnknown(o, ['id', 'title', 'description']);
      return { id: str(o, 'id', { max: 64, re: ID_RE }), title: str(o, 'title', { max: 200 }), description: str(o, 'description', { max: 2000, optional: true, min: 0 }) };
    });
    if (new Set(tasks.map((t) => t.id)).size !== tasks.length) throw new ValidationError('tasks', 'duplicate task ids');
    const reg = await registryOf(env, repo).init(repo, shards, reset, mirrors);
    if (!reg.ok) return fromResult(reg);
    configCache.set(repo, reg.config);
    const replicas = reg.config.mirrors ?? [];
    const results = await Promise.all(
      Array.from({ length: reg.config.shards }, (_, i) => {
        const m = replicas.length ? replicas[i % replicas.length] : undefined; // shard i reads from replica i mod K
        return shardStub(env, repo, i).init(repo, i, reg.config.shards, reg.config.remote, tasks.filter((t) => shardOf(t.id, reg.config.shards) === i), reset, m && { repo: m.name, remote: m.remote });
      })
    );
    const bad = results.find((r) => !r.ok);
    if (bad) return fromResult(bad);
    const perShard = results.map((r) => (r.ok ? r.tasks : 0));
    return json(200, { ok: true, repo, mode: reg.config.mode, shards: reg.config.shards, mirrors: replicas.length, tasks: perShard.reduce((a, n) => a + n, 0), tasksPerShard: perShard });
  }

  if (method === 'POST' && action === 'cleanup' && !sub) {
    await requireAdmin(request, env);
    const b = await readJson(request, MAX_BODY);
    rejectUnknown(b, ['idleDays', 'dryRun']);
    const idleDays = int(b, 'idleDays', { min: 1, max: 365, optional: true, fallback: 7 });
    const dryRun = bool(b, 'dryRun', false);
    const cfg = await repoConfig(env, repo);
    const branches = dryRun
      ? []
      : await Promise.all(Array.from({ length: cfg.shards }, (_, i) => shardStub(env, repo, i).cleanupBranches(500)));
    const forks = await registryOf(env, repo).cleanupIdleForks(idleDays * 86_400_000, dryRun);
    if (!forks.ok) return fromResult(forks);
    const sum = (k: 'deleted' | 'missing' | 'failed' | 'remaining') => branches.reduce((a, r) => a + r[k], 0);
    return json(200, {
      ok: true,
      dryRun,
      branches: { deleted: sum('deleted'), alreadyGone: sum('missing'), failed: sum('failed'), remaining: sum('remaining') },
      forks: { idleDays, idle: forks.idle.length, deleted: forks.deleted.length, kept: forks.kept, remaining: forks.remaining },
    });
  }

  if (method === 'POST' && action === 'guard' && !sub) {
    await requireAdmin(request, env);
    const b = await readJson(request, MAX_BODY);
    rejectUnknown(b, ['action']);
    const act = str(b, 'action', { max: 16, re: /^(accept|restore)$/ }) as 'accept' | 'restore';
    return fromResult(await registryOf(env, repo).guardResolve(act));
  }

  if (method === 'POST' && action === 'join' && !sub) {
    const id = await requireAgent(request, env, 'worker');
    await repoConfig(env, repo);
    return fromResult(await registryOf(env, repo).join(id));
  }

  if (method === 'POST' && action === 'claim' && !sub) {
    const id = await requireAgent(request, env, 'worker');
    const b = await readJson(request, MAX_BODY);
    rejectUnknown(b, ['taskId', 'leaseMs']);
    const taskId = str(b, 'taskId', { max: 64, re: ID_RE });
    const leaseMs = int(b, 'leaseMs', { min: LIMITS.leaseMinMs, max: LIMITS.leaseMaxMs, optional: true, fallback: LIMITS.leaseDefaultMs });
    return fromResult(await (await taskShard(env, repo, taskId)).claim(id, taskId, leaseMs));
  }

  if (method === 'POST' && (action === 'heartbeat' || action === 'release' || action === 'submit') && !sub) {
    const id = await requireAgent(request, env, 'worker');
    const b = await readJson(request, MAX_BODY);
    const allowed = action === 'heartbeat' ? ['taskId', 'leaseEpoch', 'extendMs'] : action === 'submit' ? ['taskId', 'leaseEpoch', 'commitSha'] : ['taskId', 'leaseEpoch'];
    rejectUnknown(b, allowed);
    const taskId = str(b, 'taskId', { max: 64, re: ID_RE });
    const epoch = int(b, 'leaseEpoch', { min: 1, max: Number.MAX_SAFE_INTEGER });
    const stub = await taskShard(env, repo, taskId);
    if (action === 'heartbeat') {
      const extendMs = int(b, 'extendMs', { min: LIMITS.leaseMinMs, max: LIMITS.leaseMaxMs, optional: true, fallback: LIMITS.leaseDefaultMs });
      return fromResult(await stub.heartbeat(id, taskId, epoch, extendMs));
    }
    if (action === 'release') return fromResult(await stub.release(id, taskId, epoch));
    const commitSha = str(b, 'commitSha', { max: 40, re: SHA_RE });
    return fromResult(await stub.submit(id, taskId, epoch, commitSha));
  }

  if (method === 'POST' && action === 'attest' && !sub) {
    const id = await requireAgent(request, env, 'reviewer');
    const b = await readJson(request, MAX_BODY);
    rejectUnknown(b, ['patchId', 'confidencePercent', 'reasoning']);
    const patchId = str(b, 'patchId', { max: 64, re: ID_RE });
    const confidencePercent = int(b, 'confidencePercent', { min: 1, max: 99 });
    const reasoning = str(b, 'reasoning', { max: 4000, optional: true, min: 0 });
    return fromResult(await (await patchShard(env, repo, patchId)).attest(id, patchId, confidencePercent, reasoning));
  }

  if (method === 'GET' && action === 'patches' && sub && subAction === 'diff') {
    const id = await requireAgent(request, env);
    if (!ID_RE.test(sub)) throw new ValidationError('patchId', 'invalid');
    return fromResult(await (await patchShard(env, repo, sub)).patchDiff(id, sub));
  }

  if (method === 'POST' && action === 'dev-commit' && !sub) {
    if (env.ARTIFACTS_MODE !== 'mock') throw new HttpError(404, 'NOT_FOUND');
    const id = await requireAgent(request, env, 'worker');
    const b = await readJson(request, MAX_DEV_COMMIT_BODY);
    rejectUnknown(b, ['taskId', 'leaseEpoch', 'files', 'message', 'rebase']);
    const files = asObject(b.files, 'files');
    const clean: Record<string, string | null> = {};
    for (const [p, c] of Object.entries(files)) {
      if (!/^[A-Za-z0-9._/-]{1,200}$/.test(p) || p.includes('..') || p.startsWith('/')) throw new ValidationError('files', `bad path ${p}`);
      if (c !== null && typeof c !== 'string') throw new ValidationError('files', `content of ${p} must be a string or null`);
      clean[p] = c as string | null;
    }
    const taskId = str(b, 'taskId', { max: 64, re: ID_RE });
    return fromResult(
      await (await taskShard(env, repo, taskId)).devCommit(id, taskId, int(b, 'leaseEpoch', { min: 1, max: Number.MAX_SAFE_INTEGER }), clean, str(b, 'message', { max: 500 }), bool(b, 'rebase', false))
    );
  }

  if (method === 'POST' && action === 'dev-configure' && !sub) {
    if (env.ARTIFACTS_MODE !== 'mock') throw new HttpError(404, 'NOT_FOUND');
    await requireAdmin(request, env);
    const b = await readJson(request, MAX_BODY);
    rejectUnknown(b, ['latencyMs', 'testMs']);
    return fromResult(
      await registryOf(env, repo).devConfigureMock({
        ...(b.latencyMs !== undefined ? { latencyMs: int(b, 'latencyMs', { min: 0, max: 60_000 }) } : {}),
        ...(b.testMs !== undefined ? { testMs: int(b, 'testMs', { min: 0, max: 600_000 }) } : {}),
      })
    );
  }

  if (method === 'GET' && action === 'dev-main-files' && !sub) {
    if (env.ARTIFACTS_MODE !== 'mock') throw new HttpError(404, 'NOT_FOUND');
    await requireAdmin(request, env);
    return json(200, { ok: true, files: await registryOf(env, repo).devMainFiles() });
  }

  if (method === 'POST' && action === 'dev-advance-main' && !sub) {
    if (env.ARTIFACTS_MODE !== 'mock') throw new HttpError(404, 'NOT_FOUND');
    await requireAdmin(request, env);
    const b = await readJson(request, MAX_DEV_COMMIT_BODY);
    const files = asObject(b.files, 'files') as Record<string, string | null>;
    return fromResult(await registryOf(env, repo).devAdvanceMain(files, str(b, 'message', { max: 500 })));
  }

  throw new HttpError(404, 'NOT_FOUND');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (e) {
      if (e instanceof ValidationError) return json(400, { ok: false, error: 'VALIDATION_FAILED', detail: e.message });
      if (e instanceof HttpError) {
        const r = json(e.status, { ok: false, error: e.code });
        for (const [k, v] of Object.entries(e.headers ?? {})) r.headers.set(k, v);
        return r;
      }
      console.error('unhandled', e);
      return json(500, { ok: false, error: 'INTERNAL' });
    }
  },

  /** Artifacts events (Queues event subscriptions on each repository's main): handed to its registry's guard. */
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    const byRepo = new Map<string, { events: ArtifactsEvent[]; messages: Message<unknown>[] }>();
    for (const m of batch.messages) {
      const e = parseArtifactsEvent(m.body);
      if (!e) {
        m.ack(); // not an Artifacts event: nothing to do with it
        continue;
      }
      const repo = baseRepoOf(e.repo);
      if (!REPO_RE.test(repo)) {
        m.ack();
        continue;
      }
      const g = byRepo.get(repo) ?? { events: [], messages: [] };
      g.events.push(e);
      g.messages.push(m);
      byRepo.set(repo, g);
    }
    await Promise.all(
      [...byRepo].map(async ([repo, g]) => {
        try {
          await registryOf(env, repo).onArtifactsEvents(g.events);
          for (const m of g.messages) m.ack();
        } catch (err) {
          console.warn('guard delivery failed, will retry', repo, String((err as Error).message));
          for (const m of g.messages) m.retry();
        }
      })
    );
  },
} satisfies ExportedHandler<Env>;
