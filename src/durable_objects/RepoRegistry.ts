// One registry per repository: agent forks, the review graph (collusion clusters span shards) and the
// merge queue — the only writer of `main`.
//
// Merge queue: approved patches are queued by their shard. Each round takes the queued patches in order;
// a patch joins the batch unless one of its files changed on main since the patch's base, or is already
// taken by an earlier patch of the same batch (file-level conflict). The batch becomes ONE commit on top
// of main (composed in the Worker from repository objects) pushed with a compare-and-swap. Always composed,
// even for a lone patch whose commit descends from main: main receives exactly the tree that was reviewed
// and tested, never an agent's commit, whose tree and history may hold more than its diff shows.
import { DurableObject } from 'cloudflare:workers';
import { createArtifactsGateway, MockArtifacts, MOCK_OPS, type ArtifactsGateway, type FileUpdate, type MockOp } from '../artifacts/client.js';
import type { AgentIdentity } from '../auth.js';
import { collusionCluster } from '../epistemic/collusion.js';
import { applyEvent, emptyGuard, recordLanded, recordOwnToken, type ArtifactsEvent, type GuardAlert, type MainGuard } from '../guard.js';
import { changedPaths, pathsOverlap } from '../git/diff.js';
import { MAX_SHARDS, shardName } from '../routing.js';
import { ContainerTestRunner, GATES_PATH, materialize, MockTestRunner, parseTestConfig, readFileAt, type TestConfig, type TestRun, type TestRunnerGateway } from '../testing/runner.js';
import { fail, type Result } from '../types.js';
import type { RepoCoordinator } from './RepoCoordinator.js';
import type { TestRunner } from './TestRunner.js';

export interface RegistryEnv {
  ARTIFACTS?: unknown;
  ARTIFACTS_MODE?: string;
  /** Optional override of the batching window (tests set it high and drain the queue explicitly). */
  QUEUE_BATCH_WINDOW_MS?: string;
  /** 'container' (TestRunner Durable Object), 'mock' (dev/tests) or unset (no runner: repos that declare tests cannot merge) */
  TEST_RUNNER_MODE?: string;
  TEST_RUNNER?: DurableObjectNamespace<TestRunner>;
  REPO_COORDINATOR: DurableObjectNamespace<RepoCoordinator>;
}

export const QUEUE = Object.freeze({ batchWindowMs: 150, maxBatch: 32, maxAttempts: 3 });

export interface RepoConfig {
  repo: string;
  remote: string;
  shards: number;
  mode: 'native' | 'mock';
  /** set by destroy(): no new joins or merges while forks and main are being deleted */
  deleting?: boolean;
  /** Read replicas of main (`<repo>--m<i>`): forks the merge queue keeps at main's head; shards read from them. */
  mirrors?: Array<{ name: string; remote: string }>;
}

export const MAX_MIRRORS = 8;

/** Time budget of one destroy() call; the caller repeats until done (forks take ~1 s each to delete). */
const DESTROY_BUDGET_MS = 20_000;

export interface QueueEntry {
  patchId: string;
  shard: number;
  taskId: string;
  author: string;
  fork: string;
  commitSha: string;
  baseCommit: string;
  files: Array<{ path: string; blob: { hash: string; mode: string } | null }>;
  enqueuedAt: number;
  attempts?: number;
}

export interface MergeOutcome {
  patchId: string;
  shard: number;
  status: 'merged' | 'conflict' | 'failed' | 'rejected';
  mergedCommit?: string;
  via?: 'fast-forward' | 'batch';
  batchSize?: number;
  detail?: string;
  at: number;
}

interface QueueStats {
  rounds: number;
  pushes: number;
  fastForwards: number;
  batchCommits: number;
  mergedPatches: number;
  largestBatch: number;
  conflicts: number;
  failures: number;
  casRetries: number;
  testRuns: number;
  testFailures: number;
  testRejections: number;
  testMs: number;
  testConfigErrors: number;
  testInfraErrors: number;
  mirrorSyncs: number;
  lastMirrorSyncMs: number;
}

const EMPTY_QUEUE_STATS: QueueStats = Object.freeze({
  rounds: 0,
  pushes: 0,
  fastForwards: 0,
  batchCommits: 0,
  mergedPatches: 0,
  largestBatch: 0,
  conflicts: 0,
  failures: 0,
  casRetries: 0,
  testRuns: 0,
  testFailures: 0,
  testRejections: 0,
  testMs: 0,
  testConfigErrors: 0,
  testInfraErrors: 0,
  mirrorSyncs: 0,
  lastMirrorSyncMs: 0,
});

/** Agents' write tokens for their own fork, minted by join. */
export const FORK_TOKEN_TTL_SEC = 3600;

const enc = new TextEncoder();
async function shortHash(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)));
  return [...d.subarray(0, 6)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class RepoRegistry extends DurableObject<RegistryEnv> {
  private config: RepoConfig | null = null;
  private forks = new Map<string, { name: string; remote: string; lastSeenAt?: number }>();
  private joining = new Map<string, Promise<{ name: string; remote: string }>>();
  /** Approval edges reviewer → author (count per pair), one storage key each, plus adjacency for collusion. */
  private edges = new Map<string, number>();
  private outAdj = new Map<string, Set<string>>();
  private inAdj = new Map<string, Set<string>>();
  private queue: QueueEntry[] = [];
  private undelivered: MergeOutcome[] = [];
  private recent: RegistryRecent = [];
  private stats: QueueStats = { ...EMPTY_QUEUE_STATS };
  private artifacts: ArtifactsGateway;
  private readonly windowMs: number;
  /**
   * Bisection state: these queued patches, composed on top of `head`, are known to fail the project's tests.
   * Each round tests the first half of the suspects; a passing half lands and the suspects shrink to the other
   * half (still known to fail on the new main), so nothing already known is re-tested. A rejection always rests
   * on a run of that patch alone on the current main, never on inference, so a flaky suite cannot reject an
   * innocent patch.
   */
  private suspects: { ids: string[]; head: string } | null = null;
  private lastError: string | null = null;
  private blobCache = new Map<string, Uint8Array>();
  private testConfigCache = new Map<string, { config: TestConfig | null } | { error: string }>();
  private mockRunner = new MockTestRunner();
  /** Main guard (src/guard.ts): what the platform wrote to main, and any write it did not make. */
  private guard: MainGuard = emptyGuard();
  private inRound = false;
  private pendingEvents: ArtifactsEvent[] = [];
  private mirrorHeads: Record<string, string> = {};

  constructor(ctx: DurableObjectState, env: RegistryEnv) {
    super(ctx, env);
    this.windowMs = Number(env.QUEUE_BATCH_WINDOW_MS ?? QUEUE.batchWindowMs) || QUEUE.batchWindowMs;
    this.artifacts = createArtifactsGateway(env as { ARTIFACTS?: unknown; ARTIFACTS_MODE?: string });
    this.attachMintHook();
    ctx.blockConcurrencyWhile(async () => {
      const [config, legacyEdges, edges, queue, undelivered, stats, recent, forks, suspects, lastError, guard, mirrorHeads] = await Promise.all([
        ctx.storage.get<RepoConfig>('config'),
        ctx.storage.get<Record<string, number>>('edges'),
        ctx.storage.list<number>({ prefix: 'edge:' }),
        ctx.storage.get<QueueEntry[]>('queue'),
        ctx.storage.get<MergeOutcome[]>('undelivered'),
        ctx.storage.get<QueueStats>('qstats'),
        ctx.storage.get<RegistryRecent>('recent'),
        ctx.storage.list<{ name: string; remote: string }>({ prefix: 'fork:' }),
        ctx.storage.get<{ ids: string[]; head: string } | null>('suspects'),
        ctx.storage.get<string | null>('lastError'),
        ctx.storage.get<MainGuard>('guard'),
        ctx.storage.get<Record<string, string>>('mirrorHeads'),
      ]);
      this.mirrorHeads = mirrorHeads ?? {};
      this.guard = { ...emptyGuard(), ...(guard ?? {}) };
      this.suspects = suspects ?? null;
      this.lastError = lastError ?? null;
      this.config = config ?? null;
      for (const [k, v] of edges) this.addEdge(k.slice(5), v);
      if (legacyEdges) {
        // Earlier builds stored every edge in one value rewritten on each review: move to one key per edge.
        for (const [k, v] of Object.entries(legacyEdges)) this.addEdge(k, Math.max(v, this.edges.get(k) ?? 0));
        const moved: Record<string, number> = {};
        for (const [k, v] of this.edges) moved[`edge:${k}`] = v;
        for (let i = 0, keys = Object.keys(moved); i < keys.length; i += 128) await ctx.storage.put(Object.fromEntries(keys.slice(i, i + 128).map((k) => [k, moved[k]])));
        await ctx.storage.delete('edges');
      }
      this.queue = queue ?? [];
      this.undelivered = undelivered ?? [];
      this.stats = { ...EMPTY_QUEUE_STATS, ...(stats ?? {}) };
      this.recent = recent ?? [];
      for (const [k, v] of forks) this.forks.set(k.slice(5), v);
      // Events deferred by a round that never finished (the object restarted): judge them now.
      const pending = await ctx.storage.get<ArtifactsEvent[]>('pendingEvents');
      if (pending?.length) {
        this.applyEvents(pending);
        await ctx.storage.put({ guard: this.guard, lastError: this.lastError, pendingEvents: [] });
      }
    });
  }

  // ─── Admin / config ──────────────────────────────────────────────────────

  async init(repo: string, shards: number, reset: boolean, mirrors = 0): Promise<Result<{ config: RepoConfig }>> {
    if (!Number.isInteger(shards) || shards < 1 || shards > MAX_SHARDS) return fail(400, 'INVALID_SHARDS', `1..${MAX_SHARDS}`);
    if (!Number.isInteger(mirrors) || mirrors < 0 || mirrors > MAX_MIRRORS) return fail(400, 'INVALID_MIRRORS', `0..${MAX_MIRRORS}`);
    if (this.config && (this.config.mirrors?.length ?? 0) !== mirrors) return fail(409, 'MIRRORS_IMMUTABLE', `repository uses ${this.config.mirrors?.length ?? 0} read replicas`);
    if (reset) {
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.deleteAlarm();
      this.forks.clear();
      this.edges.clear();
      this.outAdj.clear();
      this.inAdj.clear();
      this.queue = [];
      this.undelivered = [];
      this.recent = [];
      this.stats = { ...EMPTY_QUEUE_STATS };
      this.suspects = null;
      this.lastError = null;
      this.blobCache.clear();
      this.testConfigCache.clear();
      this.mockRunner = new MockTestRunner();
      if (this.artifacts instanceof MockArtifacts) this.artifacts = new MockArtifacts();
      this.attachMintHook();
      this.guard = emptyGuard();
      this.pendingEvents = [];
      this.mirrorHeads = {};
      // Shard count is fixed for the life of a repository name: Workers cache it for routing.
      if (this.config && this.config.shards !== shards) return fail(409, 'SHARDS_IMMUTABLE', `repository uses ${this.config.shards} shards`);
    }
    if (this.config && this.config.repo !== repo) return fail(409, 'REPO_MISMATCH');
    if (this.config && this.config.shards !== shards) return fail(409, 'SHARDS_IMMUTABLE', `repository uses ${this.config.shards} shards`);
    const main = await this.artifacts.ensureRepo(repo);
    if (this.artifacts instanceof MockArtifacts && !(await this.artifacts.head(repo, 'main'))) {
      await this.artifacts.commit(repo, 'main', { 'README.md': `# ${repo}\n`, 'src/index.ts': 'export {};\n' }, 'initial commit');
    }
    let replicas = this.config?.mirrors ?? [];
    if (replicas.length !== mirrors) {
      try {
        replicas = await Promise.all(Array.from({ length: mirrors }, async (_, i) => {
          const f = await this.artifacts.ensureFork(repo, `${repo}--m${i}`);
          return { name: f.name, remote: f.remote };
        }));
      } catch (e) {
        return fail(502, 'MIRROR_PROVISIONING_FAILED', String((e as Error).message));
      }
    }
    this.config = { repo, remote: main.remote, shards, mode: this.artifacts.mode, ...(replicas.length ? { mirrors: replicas } : {}) };
    if (this.guard.expectedHead === null) {
      const head = await this.artifacts.head(repo, 'main');
      if (head) recordLanded(this.guard, head);
    }
    await this.ctx.storage.put({ config: this.config, guard: this.guard });
    if (replicas.length) await this.syncMirrors();
    return { ok: true, config: this.config };
  }

  getConfig(): RepoConfig | null {
    return this.config;
  }

  // ─── Main guard ──────────────────────────────────────────────────────────

  /** Repositories whose events the guard checks: main (and its read replicas). */
  private watched(): Set<string> {
    return new Set(this.config ? [this.config.repo, ...(this.config.mirrors ?? []).map((m) => m.name)] : []);
  }

  // ─── Read replicas ───────────────────────────────────────────────────────

  /**
   * Bring every replica to the head the queue last produced (one head read per replica per call): fast-forward
   * relay from main, or, if a replica is not an ancestor of that head, a CAS reset onto it. A replica is a cache of main, so it is
   * forced, never trusted. Failures leave it behind; the next alarm retries. Returns how many are still behind.
   */
  private async syncMirrors(): Promise<number> {
    const target = this.guard.expectedHead;
    const mirrors = this.config?.mirrors ?? [];
    if (!target || mirrors.length === 0 || this.guard.alert) return 0;
    const repo = this.config!.repo;
    const t0 = Date.now();
    let moved = 0;
    const results = await Promise.allSettled(
      mirrors.map(async (m) => {
        // Read the replica, never trust our record of it: a replica moved behind our back is reset here.
        const at = await this.artifacts.head(m.name, 'main');
        if (at === target) {
          this.mirrorHeads[m.name] = target;
          return;
        }
        const ff = at ? await this.artifacts.fastForward(m.name, repo, at, target) : null;
        if (!ff?.ok) {
          // Not where we left it, or not an ancestor of target: reset it (the objects are all in main's history,
          // which the relay above or an earlier sync brought; forceRef sends no objects).
          const actual = await this.artifacts.head(m.name, 'main');
          if (actual !== target) {
            if (!actual) throw new Error(`${m.name}: replica has no main`);
            const forced = await this.artifacts.forceRef(m.name, actual, target);
            if (!forced.ok) throw new Error(`${m.name}: ${ff?.ok === false ? ff.detail + '; ' : ''}${forced.detail}`);
          }
        }
        if (at !== target) moved++;
        this.mirrorHeads[m.name] = target;
      })
    );
    for (const r of results) if (r.status === 'rejected') console.warn('replica sync failed', String((r.reason as Error)?.message ?? r.reason));
    if (moved > 0) {
      this.stats.mirrorSyncs += moved;
      this.stats.lastMirrorSyncMs = Date.now() - t0;
      await this.ctx.storage.put({ mirrorHeads: this.mirrorHeads, qstats: this.stats });
    }
    return mirrors.filter((m) => this.mirrorHeads[m.name] !== target).length;
  }

  private attachMintHook(): void {
    this.artifacts.onMint = (repo, scope, id) => {
      if (scope === 'write' && this.watched().has(repo)) recordOwnToken(this.guard, id);
    };
  }

  private raise(alert: GuardAlert): void {
    this.guard.alert ??= alert;
    this.lastError = `MAIN_GUARD: ${this.guard.alert.detail}`;
  }

  /** Artifacts events for this repository (Queues event subscription → Worker queue handler). */
  async onArtifactsEvents(events: ArtifactsEvent[]): Promise<{ ok: true; applied: number; alerts: number }> {
    if (!this.config) return { ok: true, applied: 0, alerts: 0 };
    if (this.inRound) {
      // A round may be pushing right now: judge pushes and tokens once its landing is recorded (stored, because
      // the queue message is acknowledged when this returns). Clones and fetches only count: apply them now.
      const risky = events.filter((e) => /\.(pushed|token\.)/.test(e.type));
      this.pendingEvents.push(...risky);
      const r = this.applyEvents(events.filter((e) => !risky.includes(e)));
      await this.ctx.storage.put({ guard: this.guard, pendingEvents: this.pendingEvents });
      return { ok: true, ...r };
    }
    const r = this.applyEvents(events);
    await this.ctx.storage.put({ guard: this.guard, lastError: this.lastError });
    // An event can pass as "own" (a head the queue produced earlier: a rollback) or be lost: when main was
    // pushed, read its head now instead of waiting for the next merge round, which needs a queued patch.
    if (events.some((e) => e.repo === this.config!.repo && e.type === 'cf.artifacts.repo.pushed') && (await this.headMovedAway())) {
      r.alerts++;
      await this.ctx.storage.put({ guard: this.guard, lastError: this.lastError });
    }
    return { ok: true, ...r };
  }

  /**
   * True (alert raised) if main's head is not the last head the queue produced, read twice 2 s apart so that a
   * read lagging behind the queue's own push does not raise a false alert. Never throws: a failed read leaves
   * the check to the next merge round, and the events already applied are not delivered again.
   */
  private async headMovedAway(): Promise<boolean> {
    const repo = this.config!.repo;
    const expected = this.guard.expectedHead;
    if (this.guard.alert || !expected) return false;
    try {
      let head: string | null = null;
      for (let read = 0; read < 2; read++) {
        if (read) await new Promise((r) => setTimeout(r, 2000));
        head = await this.artifacts.head(repo, 'main');
        // A round that started meanwhile moves main and expectedHead itself, and checks the head on its own.
        if (this.inRound || this.guard.alert || this.guard.expectedHead !== expected || !head || head === expected) return false;
      }
      head = head!;
      this.raise({ kind: 'head-moved', at: Date.now(), repo, before: expected, after: head, detail: `main is at ${head.slice(0, 12)}, the merge queue last left it at ${expected.slice(0, 12)}` });
      return true;
    } catch (e) {
      console.warn(`guard head check on ${repo} failed: ${(e as Error).message}`);
      return false;
    }
  }

  private applyEvents(events: ArtifactsEvent[]): { applied: number; alerts: number } {
    const watched = this.watched();
    let applied = 0;
    let alerts = 0;
    for (const e of events) {
      if (!watched.has(e.repo)) continue;
      applied++;
      const alert = applyEvent(this.guard, e, watched, Date.now());
      if (alert) {
        alerts++;
        this.raise(alert);
      }
    }
    return { applied, alerts };
  }

  /**
   * Admin decision after an alert: `accept` takes main's current head as the new baseline; `restore` revokes
   * every write token on main and its replicas, then moves main back to the last head the platform produced
   * (CAS on the current head). Revoking first: a writer still holding a token cannot move main again after.
   */
  async guardResolve(action: 'accept' | 'restore'): Promise<Result<{ head: string; revokedWriteTokens: number }>> {
    if (!this.config) return fail(404, 'REPO_NOT_INITIALIZED');
    const repo = this.config.repo;
    const head = await this.artifacts.head(repo, 'main');
    if (!head) return fail(409, 'REPO_EMPTY');
    let revokedWriteTokens = 0;
    if (action === 'accept') {
      recordLanded(this.guard, head);
    } else {
      const target = this.guard.expectedHead;
      if (!target) return fail(409, 'NOTHING_TO_RESTORE');
      // On main a failed revocation fails the restore; a replica that cannot be reached must not block it.
      for (const r of this.watched()) revokedWriteTokens += await (r === repo ? this.artifacts.revokeTokens(r, 'write') : this.artifacts.revokeTokens(r, 'write').catch(() => 0));
      if (head !== target) {
        const r = await this.artifacts.forceRef(repo, head, target);
        if (!r.ok) return fail(r.reason === 'stale' ? 409 : 502, 'RESTORE_FAILED', r.detail);
      }
    }
    this.guard.alert = null;
    if (this.lastError?.startsWith('MAIN_GUARD')) this.lastError = null;
    await this.ctx.storage.put({ guard: this.guard, lastError: this.lastError });
    if (this.queue.length > 0) await this.ctx.storage.setAlarm(Date.now() + this.windowMs);
    return { ok: true, head: action === 'accept' ? head : this.guard.expectedHead!, revokedWriteTokens };
  }

  /**
   * Delete the repository: every agent fork, then main, then this object's state. Bounded per call; the
   * caller repeats while `done` is false. Idempotent.
   */
  async destroy(): Promise<Result<{ deletedForks: number; remainingForks: number; done: boolean }>> {
    if (!this.config) return { ok: true, deletedForks: 0, remainingForks: 0, done: true };
    if (!this.config.deleting) {
      this.config = { ...this.config, deleting: true };
      await this.ctx.storage.put('config', this.config);
      await this.ctx.storage.deleteAlarm();
    }
    const t0 = Date.now();
    let deletedForks = 0;
    for (const [agentId, f] of [...this.forks]) {
      if (Date.now() - t0 > DESTROY_BUDGET_MS) break;
      try {
        await this.artifacts.deleteRepo(f.name);
      } catch (e) {
        return fail(502, 'DELETE_FAILED', `${f.name}: ${String((e as Error).message)}`);
      }
      this.forks.delete(agentId);
      await this.ctx.storage.delete(`fork:${agentId}`);
      deletedForks++;
    }
    if (this.forks.size > 0) return { ok: true, deletedForks, remainingForks: this.forks.size, done: false };
    try {
      for (const m of this.config.mirrors ?? []) await this.artifacts.deleteRepo(m.name);
      await this.artifacts.deleteRepo(this.config.repo);
    } catch (e) {
      return fail(502, 'DELETE_FAILED', `${this.config.repo}: ${String((e as Error).message)}`);
    }
    await this.ctx.storage.deleteAll();
    this.config = null;
    this.edges.clear();
    this.outAdj.clear();
    this.inAdj.clear();
    this.queue = [];
    this.undelivered = [];
    this.recent = [];
    this.stats = { ...EMPTY_QUEUE_STATS };
    this.suspects = null;
    this.lastError = null;
    this.guard = emptyGuard();
    this.mirrorHeads = {};
    return { ok: true, deletedForks, remainingForks: 0, done: true };
  }

  // ─── Forks ───────────────────────────────────────────────────────────────

  /**
   * Provision (once) the agent's fork and return a fresh write token for it. Agents call this again when the
   * token nears expiry: this is the only place fork credentials are minted (about one per agent per hour,
   * instead of one per claim). The token is returned, never stored.
   */
  async join(id: AgentIdentity): Promise<Result<{ fork: { name: string; remote: string; token: string; tokenExpiresAt: string } }>> {
    if (!this.config) return fail(404, 'REPO_NOT_INITIALIZED');
    if (this.config.deleting) return fail(409, 'REPO_DELETING');
    if (id.role !== 'worker') return fail(403, 'WORKER_ROLE_REQUIRED');
    let fork = this.forks.get(id.agentId);
    if (!fork) {
      const r = await this.provisionFork(id);
      if (!r.ok) return r;
      fork = r.fork;
    }
    // Activity mark for idle-fork cleanup: active agents (gf) call join at least hourly to renew their token.
    const seen = { name: fork.name, remote: fork.remote, lastSeenAt: Date.now() };
    this.forks.set(id.agentId, seen);
    await this.ctx.storage.put(`fork:${id.agentId}`, seen);
    try {
      const t = await this.artifacts.mintToken(fork.name, 'write', FORK_TOKEN_TTL_SEC);
      return { ok: true, fork: { name: fork.name, remote: fork.remote, token: t.plaintext, tokenExpiresAt: t.expiresAt } };
    } catch (e) {
      return fail(502, 'FORK_TOKEN_FAILED', String((e as Error).message));
    }
  }

  private async provisionFork(id: AgentIdentity): Promise<Result<{ fork: { name: string; remote: string } }>> {
    let p = this.joining.get(id.agentId);
    if (!p) {
      p = (async () => {
        const forkName = `${this.config!.repo}--a${await shortHash(id.agentId)}`;
        let f;
        try {
          f = await this.artifacts.ensureFork(this.config!.repo, forkName);
        } catch (e) {
          // Live service, concurrent forks of a young repository: some attempts leave a name that reports
          // "already exists" but is not readable for minutes. The fork name is stored per agent, so fall back
          // to an alternate name instead of blocking the agent.
          console.warn('fork provisioning failed, trying alternate name', forkName, String((e as Error).message));
          f = await this.artifacts.ensureFork(this.config!.repo, `${forkName}-r2`);
        }
        const rec = { name: f.name, remote: f.remote };
        this.forks.set(id.agentId, rec);
        await this.ctx.storage.put(`fork:${id.agentId}`, rec);
        return rec;
      })().finally(() => this.joining.delete(id.agentId));
      this.joining.set(id.agentId, p);
    }
    try {
      return { ok: true, fork: await p };
    } catch (e) {
      return fail(502, 'FORK_PROVISIONING_FAILED', String((e as Error).message));
    }
  }

  getFork(agentId: string): { name: string; remote: string } | null {
    const f = this.forks.get(agentId);
    return f ? { name: f.name, remote: f.remote } : null;
  }

  /**
   * Delete the forks of agents not seen (no join) for `idleMs`, unless a queued patch still reads from them.
   * Bounded per call; shards are told to forget the fork, and the agent gets a new one if it comes back.
   */
  async cleanupIdleForks(idleMs: number, dryRun: boolean): Promise<Result<{ idle: string[]; deleted: string[]; kept: number; remaining: number }>> {
    if (!this.config) return fail(404, 'REPO_NOT_INITIALIZED');
    const now = Date.now();
    const inQueue = new Set(this.queue.map((e) => e.fork));
    const idle: string[] = [];
    const deleted: string[] = [];
    let kept = 0;
    const t0 = now;
    for (const [agentId, f] of [...this.forks]) {
      if (f.lastSeenAt === undefined) {
        // Recorded before activity marks existed: start counting from now.
        this.forks.set(agentId, { ...f, lastSeenAt: now });
        await this.ctx.storage.put(`fork:${agentId}`, this.forks.get(agentId));
        kept++;
        continue;
      }
      if (now - f.lastSeenAt < idleMs || inQueue.has(f.name)) {
        kept++;
        continue;
      }
      idle.push(f.name);
      if (dryRun || Date.now() - t0 > DESTROY_BUDGET_MS) continue;
      try {
        await this.artifacts.deleteRepo(f.name);
      } catch (e) {
        console.warn('idle fork deletion failed', f.name, String((e as Error).message));
        continue;
      }
      this.forks.delete(agentId);
      await this.ctx.storage.delete(`fork:${agentId}`);
      deleted.push(f.name);
      await Promise.allSettled(Array.from({ length: this.config.shards }, (_, i) => this.env.REPO_COORDINATOR.get(this.env.REPO_COORDINATOR.idFromName(shardName(this.config!.repo, i))).forgetFork(agentId)));
    }
    return { ok: true, idle, deleted, kept, remaining: dryRun ? idle.length : idle.length - deleted.length };
  }

  // ─── Review graph ────────────────────────────────────────────────────────

  /** Record a review edge (approvals only) and return the reviewers colluding with `author`. */
  async recordReview(reviewer: string, author: string, approval: boolean): Promise<string[]> {
    if (approval) {
      const k = `${reviewer}\u0000${author}`;
      const n = (this.edges.get(k) ?? 0) + 1;
      this.addEdge(k, n);
      await this.ctx.storage.put(`edge:${k}`, n);
    }
    return [...collusionCluster(this.outAdj, this.inAdj, author)];
  }

  private addEdge(key: string, count: number): void {
    this.edges.set(key, count);
    const [from, to] = key.split('\u0000');
    let o = this.outAdj.get(from);
    if (!o) this.outAdj.set(from, (o = new Set()));
    o.add(to);
    let i = this.inAdj.get(to);
    if (!i) this.inAdj.set(to, (i = new Set()));
    i.add(from);
  }

  // ─── Merge queue ─────────────────────────────────────────────────────────

  async enqueue(entry: QueueEntry): Promise<Result<{ position: number }>> {
    if (!this.config) return fail(404, 'REPO_NOT_INITIALIZED');
    if (this.config.deleting) return fail(409, 'REPO_DELETING');
    if (this.queue.some((e) => e.patchId === entry.patchId)) return { ok: true, position: this.queue.findIndex((e) => e.patchId === entry.patchId) };
    this.queue.push({ ...entry, attempts: 0 });
    await this.ctx.storage.put('queue', this.queue);
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null) await this.ctx.storage.setAlarm(Date.now() + this.windowMs);
    return { ok: true, position: this.queue.length - 1 };
  }

  async alarm(): Promise<void> {
    if (this.queue.length > 0) {
      this.inRound = true;
      try {
        await this.processRound();
      } finally {
        this.inRound = false;
        if (this.pendingEvents.length > 0) {
          this.applyEvents(this.pendingEvents.splice(0));
          await this.ctx.storage.put({ guard: this.guard, lastError: this.lastError, pendingEvents: [] });
        }
      }
    }
    await this.deliver();
    // Replicas after outcomes: merges are reported first, agents' next claims see the new head a moment later.
    const behind = await this.syncMirrors();
    if (this.queue.length > 0) await this.ctx.storage.setAlarm(Date.now() + (this.lastError ? 30_000 : this.windowMs));
    else if (this.undelivered.length > 0) await this.ctx.storage.setAlarm(Date.now() + 2000);
    else if (behind > 0) await this.ctx.storage.setAlarm(Date.now() + 5000);
  }

  private testRunner(): TestRunnerGateway | null {
    if (this.env.TEST_RUNNER_MODE === 'mock') return this.mockRunner;
    if (this.env.TEST_RUNNER_MODE === 'container' && this.env.TEST_RUNNER) {
      const ns = this.env.TEST_RUNNER;
      const repo = this.config!.repo;
      return new ContainerTestRunner(() => ns.get(ns.idFromName(repo)));
    }
    return null;
  }

  /** Test commands declared on main at `head` (trusted: agents cannot modify `.gitflare/`). */
  private async testConfigAt(head: string): Promise<{ config: TestConfig | null } | { error: string }> {
    const cached = this.testConfigCache.get(head);
    if (cached) return cached;
    const raw = await readFileAt(this.artifacts.reader(this.config!.repo), head, GATES_PATH);
    let res: { config: TestConfig | null } | { error: string };
    if (raw === null) res = { config: null };
    else {
      const parsed = parseTestConfig(raw);
      res = 'error' in parsed ? parsed : this.testRunner() ? { config: parsed } : { error: `TEST_RUNNER_UNAVAILABLE: ${GATES_PATH} declares tests but no test runner is configured` };
    }
    this.testConfigCache.set(head, res);
    if (this.testConfigCache.size > 50) this.testConfigCache.delete(this.testConfigCache.keys().next().value!);
    return res;
  }

  private async processRound(): Promise<void> {
    const repo = this.config!.repo;
    const t0 = Date.now();
    this.stats.rounds++;
    this.lastError = null;
    const outcomes: MergeOutcome[] = [];
    const done = new Set<string>();
    const head = await this.artifacts.head(repo, 'main');
    if (!head) return;
    // Main guard: nothing lands on top of a main the platform did not produce.
    if (!this.guard.alert && this.guard.expectedHead === null) recordLanded(this.guard, head); // first round: trust on first use
    else if (!this.guard.alert && head !== this.guard.expectedHead) {
      this.raise({ kind: 'head-moved', at: Date.now(), repo, before: this.guard.expectedHead ?? undefined, after: head, detail: `main is at ${head.slice(0, 12)}, the merge queue last left it at ${this.guard.expectedHead?.slice(0, 12)}` });
    }
    if (this.guard.alert) {
      this.lastError = `MAIN_GUARD: ${this.guard.alert.detail}`;
      return this.finishRound(outcomes, done);
    }
    const tests = await this.testConfigAt(head);
    if ('error' in tests) {
      // Fail closed: nothing lands while the declared tests cannot run. Patches stay queued.
      this.lastError = tests.error;
      this.stats.testConfigErrors++;
      return this.finishRound(outcomes, done);
    }

    // 1. Candidates: the first half of the suspects while bisecting (main unchanged since the failing run),
    //    otherwise the head of the queue. Then a conflict-free batch (file level) among them.
    const suspectIds = this.suspects?.head === head ? new Set(this.suspects.ids) : null;
    const suspects = suspectIds ? this.queue.filter((e) => suspectIds.has(e.patchId)) : [];
    if (suspects.length === 0) this.suspects = null;
    const take = suspects.length > 0 ? suspects.slice(0, Math.ceil(suspects.length / 2)) : this.queue.slice(0, QUEUE.maxBatch);
    const main = this.artifacts.reader(repo);
    const changedSince = new Map<string, Set<string>>();
    const taken = new Set<string>();
    const batch: QueueEntry[] = [];
    const conflicts: string[] = [];
    for (const e of take) {
      let since = changedSince.get(e.baseCommit);
      if (!since) {
        try {
          since = await changedPaths(main, e.baseCommit, head);
        } catch (err) {
          this.failAttempt(e, `cannot diff main since base: ${String((err as Error).message)}`, outcomes, done);
          continue;
        }
        changedSince.set(e.baseCommit, since);
      }
      const paths = e.files.map((f) => f.path);
      const blocked = pathsOverlap(paths, new Set([...since, ...taken]));
      if (blocked) {
        this.stats.conflicts++;
        conflicts.push(e.patchId);
        outcomes.push({ patchId: e.patchId, shard: e.shard, status: 'conflict', detail: `${blocked} changed on main since ${e.baseCommit.slice(0, 12)} or by an earlier patch in the batch`, at: Date.now() });
        done.add(e.patchId);
        continue;
      }
      for (const p of paths) taken.add(p);
      batch.push(e);
    }
    if (batch.length === 0) {
      if (conflicts.length > 0) this.remember('conflicts-only', [], undefined, conflicts, t0);
      return this.finishRound(outcomes, done);
    }
    const updates: FileUpdate[] = batch.flatMap((e) => e.files.map((f) => ({ path: f.path, blob: f.blob, source: e.fork })));

    // 2. Run the project's tests on the exact tree this batch would produce.
    let testRun: TestRun | undefined;
    if (tests.config) {
      try {
        const files = await materialize(main, (r) => this.artifacts.reader(r), head, updates, this.blobCache);
        testRun = await this.testRunner()!.run(files, tests.config);
      } catch (err) {
        this.lastError = `TEST_RUN_ERROR: ${String((err as Error).message)}`;
        this.stats.testInfraErrors++;
        for (const e of batch) this.failAttempt(e, this.lastError, outcomes, done);
        return this.finishRound(outcomes, done);
      }
      this.stats.testRuns++;
      this.stats.testMs += testRun.ms;
      if (!testRun.passed) {
        this.stats.testFailures++;
        if (batch.length === 1) {
          // Isolated culprit: reject it. (A patch that only breaks together with an already-merged one
          // lands here too: it is tested on top of the merged one.)
          const e = batch[0];
          this.stats.testRejections++;
          outcomes.push({ patchId: e.patchId, shard: e.shard, status: 'rejected', detail: `TESTS_FAILED: ${testRun.logTail.slice(-1500)}`, at: Date.now() });
          done.add(e.patchId);
          this.suspects = null;
        } else {
          // Bisect across rounds: this batch fails on `head`; the next round tests its first half.
          this.suspects = { ids: batch.map((e) => e.patchId), head };
        }
        this.remember('tests-failed', batch.map((e) => e.patchId), undefined, conflicts, t0, testRun);
        return this.finishRound(outcomes, done);
      }
    }

    // 3. Land: one commit composed from the reviewed blobs on top of the head the tests ran on.
    const message = [
      `git-flare merge queue: ${batch.length} patch${batch.length === 1 ? '' : 'es'}`,
      '',
      ...batch.map((e) => `Git-Flare-Patch: ${e.patchId} task=${e.taskId} author=${e.author} commit=${e.commitSha}`),
      ...(testRun ? [`Git-Flare-Tests: passed (${testRun.results.map((r) => r.command).join(' && ')}, ${testRun.ms} ms)`] : []),
    ].join('\n');
    const author = { name: 'git-flare merge queue', email: 'merge-queue@git-flare.invalid', time: Math.floor(Date.now() / 1000) };
    let res;
    try {
      res = await this.artifacts.commitFiles(repo, head, updates, message, author);
    } catch (err) {
      res = { ok: false as const, reason: 'error' as const, detail: String((err as Error).message) };
    }
    if (res.ok) {
      this.landed(batch, 'batch', res.commit);
      for (const e of batch) {
        outcomes.push({ patchId: e.patchId, shard: e.shard, status: 'merged', mergedCommit: res.commit, via: 'batch', batchSize: batch.length, at: Date.now() });
        done.add(e.patchId);
      }
      this.remember('batch', batch.map((e) => e.patchId), res.commit, conflicts, t0, testRun);
    } else if (res.reason === 'stale') {
      this.stats.casRetries++; // main moved between head() and the push: everyone stays queued
    } else {
      for (const e of batch) this.failAttempt(e, res.detail, outcomes, done);
    }
    return this.finishRound(outcomes, done);
  }

  private landed(batch: QueueEntry[], via: 'fast-forward' | 'batch', newHead: string) {
    recordLanded(this.guard, newHead);
    this.stats.pushes++;
    if (via === 'fast-forward') this.stats.fastForwards++;
    else this.stats.batchCommits++;
    this.stats.mergedPatches += batch.length;
    this.stats.largestBatch = Math.max(this.stats.largestBatch, batch.length);
    if (this.suspects) {
      // The landed half passed, so the failure is in the rest: the new main plus the rest is the tree that failed.
      const merged = new Set(batch.map((e) => e.patchId));
      const rest = this.suspects.ids.filter((id) => !merged.has(id));
      this.suspects = rest.length > 0 ? { ids: rest, head: newHead } : null;
    }
  }

  private failAttempt(e: QueueEntry, detail: string, outcomes: MergeOutcome[], done: Set<string>): void {
    e.attempts = (e.attempts ?? 0) + 1;
    console.warn('merge attempt failed', e.patchId, e.attempts, detail);
    if (e.attempts >= QUEUE.maxAttempts) {
      this.stats.failures++;
      outcomes.push({ patchId: e.patchId, shard: e.shard, status: 'failed', detail, at: Date.now() });
      done.add(e.patchId);
    }
  }

  private remember(via: string, patches: string[], commit: string | undefined, conflicts: string[], t0: number, test?: TestRun) {
    this.recent.unshift({
      at: Date.now(),
      via,
      patches,
      commit,
      conflicts,
      ms: Date.now() - t0,
      ...(test ? { test: { passed: test.passed, ms: test.ms, results: test.results, logTail: test.logTail.slice(-800) } } : {}),
    });
    this.recent = this.recent.slice(0, 20);
  }

  private async finishRound(outcomes: MergeOutcome[], done: Set<string>): Promise<void> {
    this.queue = this.queue.filter((e) => !done.has(e.patchId));
    this.undelivered.push(...outcomes);
    await this.ctx.storage.put({ queue: this.queue, undelivered: this.undelivered, qstats: this.stats, recent: this.recent, suspects: this.suspects, lastError: this.lastError, guard: this.guard });
  }

  private async deliver(): Promise<void> {
    if (this.undelivered.length === 0) return;
    const repo = this.config!.repo;
    const pending = this.undelivered;
    const failed: MergeOutcome[] = [];
    await Promise.all(
      pending.map(async (o) => {
        try {
          const stub = this.env.REPO_COORDINATOR.get(this.env.REPO_COORDINATOR.idFromName(shardName(repo, o.shard)));
          await stub.onMergeResult(o);
        } catch (err) {
          console.warn('merge outcome delivery failed', o.patchId, String((err as Error).message));
          failed.push(o);
        }
      })
    );
    this.undelivered = failed;
    await this.ctx.storage.put('undelivered', this.undelivered);
  }

  async status(): Promise<{
    config: RepoConfig | null;
    forks: number;
    queue: Array<Pick<QueueEntry, 'patchId' | 'taskId' | 'enqueuedAt'>>;
    stats: QueueStats;
    recent: RegistryRecent;
    bisecting: { suspects: number } | null;
    lastError: string | null;
    guard: { state: 'ok' | 'alert'; alert: GuardAlert | null; expectedHead: string | null; counts: MainGuard['counts']; recent: MainGuard['recent'] };
    mirrors: Array<{ name: string; head: string | null; current: boolean }>;
    testRunner: string;
  }> {
    return {
      config: this.config,
      forks: this.forks.size,
      bisecting: this.suspects ? { suspects: this.suspects.ids.length } : null,
      guard: { state: this.guard.alert ? 'alert' : 'ok', alert: this.guard.alert, expectedHead: this.guard.expectedHead, counts: this.guard.counts, recent: this.guard.recent.slice(-10) },
      mirrors: (this.config?.mirrors ?? []).map((m) => ({ name: m.name, head: this.mirrorHeads[m.name] ?? null, current: this.mirrorHeads[m.name] === this.guard.expectedHead })),
      lastError: this.lastError,
      testRunner: this.env.TEST_RUNNER_MODE ?? 'none',
      queue: this.queue.map((e) => ({ patchId: e.patchId, taskId: e.taskId, enqueuedAt: e.enqueuedAt })),
      stats: { ...this.stats },
      recent: this.recent,
    };
  }

  // ─── Shared mock (ARTIFACTS_MODE=mock) ───────────────────────────────────

  async mockOp(op: MockOp, args: unknown[]): Promise<unknown> {
    if (!(this.artifacts instanceof MockArtifacts)) throw new Error('mock operations are only available in mock mode');
    if (!(MOCK_OPS as readonly string[]).includes(op)) throw new Error(`unknown mock op ${op}`);
    const m = this.artifacts as unknown as Record<string, (...a: unknown[]) => unknown>;
    return await m[op](...args);
  }

  devConfigureMock(cfg: { latencyMs?: number; testMs?: number; failNext?: MockArtifacts['failNext'] }): Result<{ activeTokens: Record<string, number> }> {
    if (!(this.artifacts instanceof MockArtifacts)) return fail(404, 'NOT_AVAILABLE_IN_NATIVE_MODE');
    if (cfg.latencyMs !== undefined) this.artifacts.latencyMs = cfg.latencyMs;
    if (cfg.testMs !== undefined) this.mockRunner.delayMs = cfg.testMs;
    if (cfg.failNext) this.artifacts.failNext = { ...cfg.failNext };
    const activeTokens: Record<string, number> = {};
    if (this.config) {
      activeTokens[this.config.repo] = this.artifacts.activeTokens(this.config.repo);
      for (const f of this.forks.values()) activeTokens[f.name] = this.artifacts.activeTokens(f.name);
    }
    return { ok: true, activeTokens };
  }

  async devAdvanceMain(files: Record<string, string | null>, message: string): Promise<Result<{ commitSha: string }>> {
    if (!(this.artifacts instanceof MockArtifacts) || !this.config) return fail(404, 'NOT_AVAILABLE');
    const commitSha = await this.artifacts.commit(this.config.repo, 'main', files, message);
    recordLanded(this.guard, commitSha); // an operator action, not a foreign write
    await this.ctx.storage.put('guard', this.guard);
    return { ok: true, commitSha };
  }

  /** Test hook: files of main's head in mock mode. */
  async devMainFiles(): Promise<Record<string, string> | null> {
    if (!(this.artifacts instanceof MockArtifacts) || !this.config) return null;
    const head = await this.artifacts.head(this.config.repo, 'main');
    return head ? this.artifacts.filesOf(head) : null;
  }
}

type RegistryRecent = Array<{
  at: number;
  via: string;
  patches: string[];
  commit?: string;
  conflicts: string[];
  ms: number;
  test?: { passed: boolean; ms: number; results: TestRun['results']; logTail: string };
}>;
