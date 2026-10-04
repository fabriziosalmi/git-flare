// Task shard: one of N coordinators of a repository (tasks are routed by routing.shardOf). Invariants
// (docs/SPEC.md):
//   - every state transition happens synchronously BEFORE any non-storage await, and every result of an
//     external call is applied only after re-checking the lease epoch (no interleaving can double-grant);
//   - identity comes from the Worker (verified key), never from request bodies;
//   - the claim path makes no per-claim Artifacts call: main's head is cached for a second and the read
//     token for main is shared by the shard (kept in memory only, never in storage, renewed before expiry).
//     Write access to an agent's own fork comes from /join (one token per agent per hour), so claims scale
//     with the Durable Objects, not with Artifacts' control plane (docs/spikes/artifacts-load-2026-10-02.md);
//   - merged / rejected / duplicate / stale / expired patches are terminal; approved patches are handed to
//     the repository's merge queue (RepoRegistry) and become merged or stale when it reports back.
import { DurableObject } from 'cloudflare:workers';
import aimpWasmModule from '../../crates/aimp-wasm/pkg/aimp_wasm_bg.wasm';
import { createArtifactsGateway, RemoteMockArtifacts, type ArtifactsGateway, type MintedToken } from '../artifacts/client.js';
import type { AgentIdentity } from '../auth.js';
import { canonicalChange } from '../epistemic/changeset.js';
import { AimpEngine } from '../epistemic/aimp.js';
import { evaluate, normalizeFamily } from '../epistemic/policy.js';
import { runGates } from '../gates.js';
import { computeChanges, DiffLimitError, isAncestor } from '../git/diff.js';
import type { FileChange } from '../epistemic/changeset.js';
import { EMPTY_STATS, fail, summarizeChanges, TERMINAL_PATCH, type Patch, type RepoStats, type Result, type Task } from '../types.js';
import type { MergeOutcome, RepoRegistry } from './RepoRegistry.js';

export interface CoordinatorEnv {
  ARTIFACTS?: unknown;
  ARTIFACTS_MODE?: string;
  REPO_REGISTRY: DurableObjectNamespace<RepoRegistry>;
}

export const LIMITS = Object.freeze({
  leaseMinMs: 10_000,
  leaseMaxMs: 600_000,
  leaseDefaultMs: 120_000,
  /** A lease (heartbeats included) can be held at most this long; then the task must be released. */
  leaseMaxAgeMs: 3_600_000,
  /** Shared read token for main: minted with this TTL, renewed when less than readTokenMinLeftSec remain. */
  readTokenTtlSec: 3600,
  readTokenMinLeftSec: 1800,
  /** Main's head as seen by claims may be this old (a stale base only widens the diff window: harmless). */
  headCacheMs: 1000,
  /** Branches of closed patches are deleted by the shard alarm this long after closing, at most N per run. */
  cleanupDelayMs: 60_000,
  cleanupPerAlarm: 50,
  reviewTimeoutMs: 30 * 60_000,
  /**
   * Near-duplicate threshold (Hamming distance between 256-bit SimHashes), calibrated on 10,947 pairs from
   * public repositories (benchmarks/results/2026-10-02/simhash-calibration.json): the largest value with no
   * false positive among 5,614 different changes (1,343 touching the same file); recall 0.87 on resubmissions
   * with small edits. At this distance a one-line logic change is also "near", so near-duplicates are only
   * flagged for reviewers; only an identical canonical change is closed as a duplicate.
   */
  duplicateThresholdBits: 14,
  maxTasks: 5000,
  statusPatchLimit: 100,
});

interface Meta {
  repo: string;
  shard: number;
  shards: number;
  remote: string;
  createdAt: number;
  /** Where this shard's agents read main from: a read replica (`<repo>--m<i>`) or main itself. */
  read?: { repo: string; remote: string };
}

interface TaskInput {
  id: string;
  title: string;
  description: string;
}

export class RepoCoordinator extends DurableObject<CoordinatorEnv> {
  private meta: Meta | null = null;
  private tasks = new Map<string, Task & { claimedAt?: number }>();
  private patches = new Map<string, Patch>();
  private forkCache = new Map<string, { name: string; remote: string }>();
  private stats: RepoStats = { ...EMPTY_STATS };
  private aimp!: AimpEngine;
  private artifacts: ArtifactsGateway;
  private mainHead: { sha: string; at: number } | null = null;
  private headInflight: Promise<string | null> | null = null;
  private readToken: MintedToken | null = null;
  private readTokenInflight: Promise<MintedToken> | null = null;

  constructor(ctx: DurableObjectState, env: CoordinatorEnv) {
    super(ctx, env);
    this.artifacts = createArtifactsGateway(env as { ARTIFACTS?: unknown; ARTIFACTS_MODE?: string }, () => this.registry());
    ctx.blockConcurrencyWhile(async () => {
      this.aimp = await AimpEngine.create(aimpWasmModule);
      const [meta, stats, tasks, patches] = await Promise.all([
        ctx.storage.get<Meta>('meta'),
        ctx.storage.get<RepoStats>('stats'),
        ctx.storage.list<Task>({ prefix: 'task:' }),
        ctx.storage.list<Patch>({ prefix: 'patch:' }),
      ]);
      this.meta = meta ?? null;
      this.stats = { ...EMPTY_STATS, ...(stats ?? {}) };
      for (const [k, v] of tasks) this.tasks.set(k.slice(5), v);
      const moved: Record<string, unknown> = {};
      for (const [k, v] of patches) {
        const legacy = v as Patch & { changes?: FileChange[] };
        if (legacy.changes) {
          // Earlier builds kept the full change inside the patch record (and so in memory): split it out.
          legacy.files = summarizeChanges(legacy.changes);
          moved[`pchg:${legacy.patchId}`] = legacy.changes;
          delete legacy.changes;
          moved[k] = legacy;
        }
        this.patches.set(k.slice(6), legacy);
      }
      const keys = Object.keys(moved);
      for (let i = 0; i < keys.length; i += 128) await ctx.storage.put(Object.fromEntries(keys.slice(i, i + 128).map((key) => [key, moved[key]])));
    });
  }

  private registry() {
    if (!this.meta) throw new Error('shard not initialized');
    return this.env.REPO_REGISTRY.get(this.env.REPO_REGISTRY.idFromName(this.meta.repo));
  }

  // ─── Admin ────────────────────────────────────────────────────────────────

  /**
   * Delete the branches of closed patches from their authors' forks (one request and one token per fork).
   * Merged patches' objects are in main by then; the others are no longer needed. Failures stay for later.
   */
  async cleanupBranches(limit = 100): Promise<{ ok: true; deleted: number; missing: number; failed: number; remaining: number }> {
    const todo = this.closedWithBranch().slice(0, limit);
    const byFork = new Map<string, Patch[]>();
    for (const p of todo) byFork.set(p.fork, [...(byFork.get(p.fork) ?? []), p]);
    let deleted = 0;
    let missing = 0;
    let failed = 0;
    const writes: Record<string, unknown> = {};
    for (const [fork, patches] of byFork) {
      const refOf = (p: Patch) => `refs/heads/task/${p.taskId}/${p.leaseEpoch}`;
      try {
        const r = await this.artifacts.deleteRefs(fork, patches.map(refOf));
        for (const p of patches) {
          const ref = refOf(p);
          if (r.deleted.includes(ref) || r.missing.includes(ref)) {
            p.branchDeleted = true;
            writes[`patch:${p.patchId}`] = p;
          }
        }
        deleted += r.deleted.length;
        missing += r.missing.length;
        failed += r.failed.length;
      } catch (e) {
        if (/not found/i.test(String((e as Error).message))) {
          // The fork itself is gone (idle-fork cleanup or repository deletion): nothing left to delete.
          for (const p of patches) {
            p.branchDeleted = true;
            writes[`patch:${p.patchId}`] = p;
          }
          missing += patches.length;
        } else {
          console.warn('branch cleanup failed', fork, String((e as Error).message));
          failed += patches.length;
        }
      }
    }
    this.stats.branchesDeleted += deleted;
    if (Object.keys(writes).length > 0) await this.ctx.storage.put({ ...writes, stats: this.stats });
    return { ok: true, deleted, missing, failed, remaining: this.closedWithBranch().length };
  }

  private closedWithBranch(): Patch[] {
    return [...this.patches.values()].filter((p) => TERMINAL_PATCH.has(p.status) && !p.branchDeleted);
  }

  /** The registry deleted this agent's fork: the next claim looks it up again. */
  forgetFork(agentId: string): { ok: true } {
    this.forkCache.delete(agentId);
    return { ok: true };
  }

  /** Forget everything (repository deletion). Idempotent. */
  async destroy(): Promise<{ ok: true }> {
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
    this.meta = null;
    this.tasks.clear();
    this.patches.clear();
    this.forkCache.clear();
    this.stats = { ...EMPTY_STATS };
    this.mainHead = null;
    this.readToken = null;
    return { ok: true };
  }

  async init(
    repo: string,
    shard: number,
    shards: number,
    remote: string,
    tasks: TaskInput[],
    reset: boolean,
    read?: { repo: string; remote: string }
  ): Promise<Result<{ shard: number; tasks: number; added: number }>> {
    if (reset) {
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.deleteAlarm();
      this.meta = null;
      this.tasks.clear();
      this.patches.clear();
      this.forkCache.clear();
      this.stats = { ...EMPTY_STATS };
      this.mainHead = null;
      this.readToken = null;
    }
    if (this.meta && (this.meta.repo !== repo || this.meta.shard !== shard || this.meta.shards !== shards)) return fail(409, 'SHARD_MISMATCH');
    if (this.tasks.size + tasks.length > LIMITS.maxTasks) return fail(400, 'TOO_MANY_TASKS', `max ${LIMITS.maxTasks} per shard`);
    this.meta ??= { repo, shard, shards, remote, createdAt: Date.now() };
    if (read && !this.meta.read) this.meta.read = read;
    const writes: Record<string, unknown> = { meta: this.meta };
    let added = 0;
    for (const t of tasks) {
      if (this.tasks.has(t.id)) continue;
      const task: Task = { id: t.id, title: t.title, description: t.description, status: 'available', leaseEpoch: 0 };
      this.tasks.set(t.id, task);
      writes[`task:${t.id}`] = task;
      added++;
    }
    await this.ctx.storage.put(writes);
    return { ok: true, shard, tasks: this.tasks.size, added };
  }

  // ─── Workers ──────────────────────────────────────────────────────────────

  async claim(
    id: AgentIdentity,
    taskId: string,
    leaseMs: number
  ): Promise<
    Result<{
      taskId: string;
      leaseEpoch: number;
      leaseExpiresAt: number;
      baseCommit: string;
      branch: string;
      fork: { name: string; remote: string };
      main: { remote: string; readToken: string; tokenExpiresAt: string; replica?: string };
      timingMs: { provisioning: number };
    }>
  > {
    if (!this.meta) return fail(404, 'REPO_NOT_INITIALIZED');
    if (id.role !== 'worker') return fail(403, 'WORKER_ROLE_REQUIRED');
    if (!this.tasks.has(taskId)) return fail(404, 'TASK_NOT_FOUND');
    // Fork lookup first (it may await the registry); every task check below is synchronous.
    let fork = this.forkCache.get(id.agentId) ?? null;
    if (!fork) {
      fork = await this.registry().getFork(id.agentId);
      if (fork) this.forkCache.set(id.agentId, fork);
    }
    if (!fork) return fail(409, 'NOT_JOINED', 'call /join first: it provisions your fork (takes seconds, once)');
    const forkName = fork.name;
    const forkRemote = fork.remote;
    const task = this.tasks.get(taskId)!;
    const lease = Math.min(Math.max(leaseMs, LIMITS.leaseMinMs), LIMITS.leaseMaxMs);
    const now = Date.now();

    if (task.status === 'claimed') {
      if (task.provisioning || task.op || (task.leaseExpiresAt ?? 0) > now) {
        this.stats.claimRaceLosses++;
        return fail(409, task.holder === id.agentId ? 'ALREADY_HOLDER' : 'ALREADY_CLAIMED');
      }
      this.reclaim(task); // expired lease: reclaim inline, alarm may not have fired yet
    } else if (task.status !== 'available') {
      return fail(409, 'TASK_NOT_AVAILABLE', task.status);
    }

    // Reservation: synchronous, before any external I/O.
    const epoch = ++task.leaseEpoch;
    Object.assign(task, {
      status: 'claimed',
      holder: id.agentId,
      claimedAt: now,
      leaseExpiresAt: now + lease,
      provisioning: true,
      branch: `task/${taskId}/${epoch}`,
      baseCommit: undefined,
      forkName,
      patchId: undefined,
    } satisfies Partial<Task & { claimedAt: number }>);
    await this.ctx.storage.put(`task:${taskId}`, task);

    const t0 = Date.now();
    try {
      // Both are usually served from memory: at most one head read per second and one token mint per
      // half hour per shard, whatever the claim rate.
      const [base, mainTok] = await Promise.all([this.currentHead(), this.sharedReadToken()]);
      if (task.leaseEpoch !== epoch || task.holder !== id.agentId) return fail(409, 'LEASE_LOST');
      if (!base) {
        this.rollbackClaim(task, epoch);
        await this.ctx.storage.put(`task:${taskId}`, task);
        return fail(409, 'REPO_EMPTY', 'main has no commits yet');
      }
      Object.assign(task, { provisioning: false, baseCommit: base });
      this.stats.claims++;
      await this.ctx.storage.put({ [`task:${taskId}`]: task, stats: this.stats });
      await this.scheduleAlarm();
      return {
        ok: true,
        taskId,
        leaseEpoch: epoch,
        leaseExpiresAt: task.leaseExpiresAt!,
        baseCommit: base,
        branch: task.branch!,
        fork: { name: forkName, remote: forkRemote },
        main: { remote: this.readFrom().remote, readToken: mainTok.plaintext, tokenExpiresAt: mainTok.expiresAt, ...(this.meta.read ? { replica: this.meta.read.repo } : {}) },
        timingMs: { provisioning: Date.now() - t0 },
      };
    } catch (e) {
      console.warn('claim provisioning failed', taskId, String((e as Error).message));
      if (this.rollbackClaim(task, epoch)) {
        this.stats.provisioningFailures++;
        await this.ctx.storage.put({ [`task:${taskId}`]: task, stats: this.stats });
      }
      return fail(502, 'PROVISIONING_FAILED', String((e as Error).message));
    }
  }

  async heartbeat(id: AgentIdentity, taskId: string, epoch: number, extendMs: number): Promise<Result<{ leaseExpiresAt: number }>> {
    const g = this.leaseGuard(id, taskId, epoch);
    if (!g.ok) return g;
    const task = g.task;
    const now = Date.now();
    const next = now + Math.min(Math.max(extendMs, LIMITS.leaseMinMs), LIMITS.leaseMaxMs);
    if (next > (task.claimedAt ?? now) + LIMITS.leaseMaxAgeMs) return fail(409, 'LEASE_MAX_AGE', 'lease held for the maximum time; release and claim again');
    task.leaseExpiresAt = next;
    await this.ctx.storage.put(`task:${taskId}`, task);
    await this.scheduleAlarm();
    return { ok: true, leaseExpiresAt: next };
  }

  async release(id: AgentIdentity, taskId: string, epoch: number): Promise<Result<{ status: string }>> {
    const g = this.leaseGuard(id, taskId, epoch);
    if (!g.ok) return g;
    this.reclaim(g.task, false);
    await this.ctx.storage.put(`task:${taskId}`, g.task);
    await this.scheduleAlarm();
    return { ok: true, status: g.task.status };
  }

  async submit(
    id: AgentIdentity,
    taskId: string,
    epoch: number,
    commitSha: string
  ): Promise<
    Result<{
      patchId: string;
      status: string;
      baseCommit: string;
      gates: Patch['gates'];
      changedFiles: number;
      simHash: string;
      duplicateOf?: string;
      nearDuplicateOf?: Patch['nearDuplicateOf'];
      similar: Patch['similar'];
      timingMs: { diffAndGates: number };
    }>
  > {
    const g = this.leaseGuard(id, taskId, epoch);
    if (!g.ok) return g;
    const task = g.task;
    const forkName = task.forkName!;
    task.op = 'submitting';

    let computed: { base: string; changes: FileChange[]; gates: Patch['gates']; simHash: string; canonicalHash: string };
    const t0 = Date.now();
    try {
      const reader = this.artifacts.reader(forkName);
      if (!(await reader.readCommit(commitSha))) return this.endOp(task, epoch, fail(404, 'COMMIT_NOT_FOUND_IN_FORK', `push ${commitSha} to ${task.branch} first`));
      // Base = the newest main commit the agent built on: the claim's base, or the current main head if the
      // agent rebased onto it. Diffing against the right base keeps the merge queue free of false conflicts.
      const head = await this.artifacts.head(this.meta!.repo, 'main');
      let base = task.baseCommit!;
      if (head && head !== base && (await isAncestor(reader, head, commitSha))) base = head;
      else if (!(await isAncestor(reader, base, commitSha))) return this.endOp(task, epoch, fail(409, 'NOT_DESCENDANT_OF_BASE', `commit must build on ${task.baseCommit}`));
      // The base came from a replica (or a cache): it must be part of main's history, or a tampered replica could
      // hand out a base whose content reviewers never see in the diff.
      else if (head && base !== head && !(await isAncestor(this.artifacts.reader(this.meta!.repo), base, head))) {
        return this.endOp(task, epoch, fail(409, 'BASE_NOT_ON_MAIN', `${base} is not in main's history; claim again`));
      }
      const changes = await computeChanges(reader, base, commitSha);
      const canonical = canonicalChange(changes);
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical)));
      computed = { base, changes, gates: runGates(changes), simHash: this.aimp.computeSimHash(canonical), canonicalHash: [...digest].map((b) => b.toString(16).padStart(2, '0')).join('') };
    } catch (e) {
      if (e instanceof DiffLimitError) return this.endOp(task, epoch, fail(413, 'CHANGE_TOO_LARGE', e.message));
      return this.endOp(task, epoch, fail(502, 'DIFF_FAILED', String((e as Error).message)));
    }
    if (task.leaseEpoch !== epoch || task.status !== 'claimed' || task.holder !== id.agentId) return fail(409, 'LEASE_LOST');
    task.op = undefined;
    const diffMs = Date.now() - t0;

    const patchId = `p${this.meta!.shard}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
    let duplicateOf: string | undefined;
    let nearDuplicateOf: Patch['nearDuplicateOf'];
    const similar: Patch['similar'] = [];
    for (const p of this.patches.values()) {
      // Only merit-based closures count: a stale (conflict) or expired (unreviewed) patch may be resubmitted.
      const closedOnMerit = p.taskId === taskId && (p.status === 'rejected' || p.status === 'duplicate');
      if (closedOnMerit && p.canonicalHash === computed.canonicalHash) {
        duplicateOf ??= p.patchId;
        continue;
      }
      const d = this.aimp.hammingDistance(computed.simHash, p.simHash);
      if (d > LIMITS.duplicateThresholdBits) continue;
      if (closedOnMerit) {
        if (!nearDuplicateOf || d < nearDuplicateOf.distance) nearDuplicateOf = { patchId: p.patchId, distance: d };
      } else if (p.taskId !== taskId && similar.length < 5) similar.push({ patchId: p.patchId, taskId: p.taskId, distance: d });
    }

    const gatesFailed = computed.gates.some((x) => !x.passed);
    const patch: Patch = {
      patchId,
      taskId,
      author: id.agentId,
      authorFamily: normalizeFamily(id.family),
      fork: forkName,
      commitSha,
      baseCommit: computed.base,
      leaseEpoch: epoch,
      submittedAt: Date.now(),
      status: gatesFailed ? 'rejected' : duplicateOf ? 'duplicate' : 'evaluating',
      files: summarizeChanges(computed.changes),
      gates: computed.gates,
      simHash: computed.simHash,
      canonicalHash: computed.canonicalHash,
      duplicateOf,
      ...(nearDuplicateOf && !duplicateOf ? { nearDuplicateOf } : {}),
      similar,
      reviews: [],
    };
    patch.evaluation = evaluate([], patch.gates, new Set());
    if (patch.status !== 'evaluating') patch.closedAt = patch.submittedAt;
    this.patches.set(patchId, patch);
    this.stats.submits++;
    if (gatesFailed) this.stats.gateRejections++;
    else if (duplicateOf) this.stats.duplicates++;

    if (patch.status === 'evaluating') {
      Object.assign(task, { status: 'submitted', patchId });
    } else {
      this.reclaim(task, false);
      task.patchId = patchId;
    }
    await this.ctx.storage.put({ [`task:${taskId}`]: task, [`patch:${patchId}`]: patch, [`pchg:${patchId}`]: computed.changes, stats: this.stats });
    await this.scheduleAlarm();
    return {
      ok: true,
      patchId,
      status: patch.status,
      baseCommit: patch.baseCommit,
      gates: patch.gates,
      changedFiles: patch.files.length,
      simHash: patch.simHash,
      duplicateOf,
      ...(patch.nearDuplicateOf ? { nearDuplicateOf: patch.nearDuplicateOf } : {}),
      similar,
      timingMs: { diffAndGates: diffMs },
    };
  }

  // ─── Reviewers ────────────────────────────────────────────────────────────

  async attest(id: AgentIdentity, patchId: string, confidencePercent: number, reasoning: string): Promise<Result<{ patchId: string; status: string; evaluation: Patch['evaluation'] }>> {
    const pre = this.reviewGuard(id, patchId);
    if (!pre.ok) return pre;
    // The review graph spans shards: record the edge and learn the author's collusion cluster first.
    let excluded: string[];
    try {
      excluded = await this.registry().recordReview(id.agentId, pre.patch.author, confidencePercent > 50);
    } catch (e) {
      return fail(502, 'REGISTRY_UNAVAILABLE', String((e as Error).message));
    }
    const g = this.reviewGuard(id, patchId); // re-check: another review may have closed it meanwhile
    if (!g.ok) return g;
    const patch = g.patch;
    patch.reviews.push({ reviewerId: id.agentId, family: normalizeFamily(id.family), confidencePercent, reasoning, at: Date.now() });
    this.stats.reviews++;
    const evaluation = evaluate(
      patch.reviews.map((r) => ({ reviewerId: r.reviewerId, family: r.family, confidencePercent: r.confidencePercent })),
      patch.gates,
      new Set(excluded)
    );
    patch.evaluation = evaluation;

    if (evaluation.decision === 'reject') {
      patch.status = 'rejected';
      patch.closedAt = Date.now();
      this.stats.reviewRejections++;
      const task = this.tasks.get(patch.taskId);
      if (task && task.status === 'submitted' && task.patchId === patchId) this.reclaim(task, false);
    } else if (evaluation.decision === 'merge') {
      patch.status = 'queued';
      await this.persistPatch(patch);
      try {
        const q = await this.registry().enqueue({
          patchId,
          shard: this.meta!.shard,
          taskId: patch.taskId,
          author: patch.author,
          fork: patch.fork,
          commitSha: patch.commitSha,
          baseCommit: patch.baseCommit,
          files: patch.files.map((f) => ({ path: f.path, blob: f.blob ?? null })),
          enqueuedAt: Date.now(),
        });
        if (!q.ok) throw new Error(q.error);
      } catch (e) {
        if (patch.status === 'queued') {
          patch.status = 'evaluating';
          patch.mergeError = `ENQUEUE_FAILED: ${String((e as Error).message)}`;
        }
      }
    }
    await this.persistPatch(patch);
    await this.scheduleAlarm();
    return { ok: true, patchId, status: patch.status, evaluation };
  }

  /** Called by the registry's merge queue (at-least-once delivery; idempotent). */
  async onMergeResult(o: MergeOutcome): Promise<{ ok: true; applied: boolean }> {
    const patch = this.patches.get(o.patchId);
    if (!patch || patch.status !== 'queued') return { ok: true, applied: false };
    const task = this.tasks.get(patch.taskId);
    const owns = task !== undefined && task.patchId === patch.patchId;
    if (o.status === 'merged') {
      this.mainHead = null; // main moved: the next claim reads the new head
      Object.assign(patch, { status: 'merged', mergedCommit: o.mergedCommit, mergedVia: o.via, mergedBatchSize: o.batchSize });
      this.stats.merges++;
      if (owns) Object.assign(task, { status: 'merged', mergedCommit: o.mergedCommit, mergedAt: o.at, holder: undefined, leaseExpiresAt: undefined });
    } else if (o.status === 'rejected') {
      // The project's tests failed on the composed tree (isolated by bisection).
      patch.status = 'rejected';
      patch.mergeError = o.detail ?? 'TESTS_FAILED';
      this.stats.testRejections++;
      if (owns && task.status === 'submitted') this.reclaim(task, false);
    } else {
      patch.status = 'stale';
      patch.mergeError = `${o.status === 'conflict' ? 'CONFLICT' : 'MERGE_FAILED'}: ${o.detail ?? ''}`;
      if (o.status === 'conflict') {
        this.stats.staleMerges++;
        if (task) task.conflicts = (task.conflicts ?? 0) + 1; // persisted with the patch below; redelivery returns early above
      }
      if (owns && task.status === 'submitted') this.reclaim(task, false);
    }
    patch.closedAt = o.at;
    await this.persistPatch(patch);
    await this.scheduleAlarm(); // the closed patch's branch gets cleaned up
    return { ok: true, applied: true };
  }

  async patchDiff(
    id: AgentIdentity,
    patchId: string
  ): Promise<Result<{ patch: Pick<Patch, 'patchId' | 'taskId' | 'author' | 'commitSha' | 'baseCommit' | 'status' | 'gates' | 'nearDuplicateOf'> & { changes: FileChange[] } }>> {
    void id;
    const p = this.patches.get(patchId);
    if (!p) return fail(404, 'PATCH_NOT_FOUND');
    const changes = (await this.ctx.storage.get<FileChange[]>(`pchg:${patchId}`)) ?? [];
    return { ok: true, patch: { patchId: p.patchId, taskId: p.taskId, author: p.author, commitSha: p.commitSha, baseCommit: p.baseCommit, status: p.status, changes, gates: p.gates, ...(p.nearDuplicateOf ? { nearDuplicateOf: p.nearDuplicateOf } : {}) } };
  }

  // ─── Dev only (ARTIFACTS_MODE=mock) ───────────────────────────────────────

  /** Stand-in for `git push` against the shared mock: commits files on the caller's fork branch. */
  async devCommit(id: AgentIdentity, taskId: string, epoch: number, files: Record<string, string | null>, message: string, rebase = false): Promise<Result<{ commitSha: string }>> {
    if (!(this.artifacts instanceof RemoteMockArtifacts)) return fail(404, 'NOT_AVAILABLE_IN_NATIVE_MODE');
    const g = this.leaseGuard(id, taskId, epoch);
    if (!g.ok) return g;
    const mock = this.artifacts;
    const fork = g.task.forkName!;
    const branch = g.task.branch!;
    // The branch starts from the claim's base commit (`git checkout -b <branch> <base>`), or from the
    // current main head when the agent asks to rebase.
    if (rebase) await mock.setRef(fork, branch, (await mock.head(this.meta!.repo, 'main'))!);
    else if (!(await mock.head(fork, branch))) await mock.setRef(fork, branch, g.task.baseCommit!);
    return { ok: true, commitSha: await mock.commit(fork, branch, files, message) };
  }

  // ─── Public read ──────────────────────────────────────────────────────────

  async status(): Promise<{
    shard: number | null;
    tasks: Array<Pick<Task, 'id' | 'title' | 'description' | 'status' | 'leaseEpoch' | 'holder' | 'leaseExpiresAt' | 'patchId' | 'mergedCommit' | 'conflicts'>>;
    patches: Array<Record<string, unknown> & { submittedAt: number }>;
    stats: RepoStats;
  }> {
    const tasks = [...this.tasks.values()].map((t) => ({
      id: t.id,
      title: t.title,
      description: t.description,
      status: t.status,
      leaseEpoch: t.leaseEpoch,
      holder: t.holder,
      leaseExpiresAt: t.leaseExpiresAt,
      patchId: t.patchId,
      mergedCommit: t.mergedCommit,
      conflicts: t.conflicts ?? 0,
    }));
    let sybil = 0;
    let collusion = 0;
    for (const p of this.patches.values()) {
      sybil += p.evaluation?.discountedReviews ?? 0;
      collusion += p.evaluation?.excluded.length ?? 0;
    }
    const patches = [...this.patches.values()]
      .sort((a, b) => b.submittedAt - a.submittedAt)
      .slice(0, LIMITS.statusPatchLimit)
      .map((p) => ({
        patchId: p.patchId,
        taskId: p.taskId,
        author: p.author,
        authorFamily: p.authorFamily,
        status: p.status,
        commitSha: p.commitSha,
        baseCommit: p.baseCommit,
        submittedAt: p.submittedAt,
        changedFiles: p.files.map((f) => ({ path: f.path, status: f.status, added: f.added, removed: f.removed })),
        gates: p.gates,
        simHash: p.simHash,
        duplicateOf: p.duplicateOf,
        nearDuplicateOf: p.nearDuplicateOf,
        similar: p.similar,
        reviews: p.reviews.map((r) => ({ reviewerId: r.reviewerId, family: r.family, confidencePercent: r.confidencePercent, reasoning: r.reasoning.slice(0, 400), at: r.at })),
        evaluation: p.evaluation && {
          decision: p.evaluation.decision,
          reasons: p.evaluation.reasons,
          logOdds: p.evaluation.logOdds,
          thresholdLogOdds: p.evaluation.thresholdLogOdds,
          approvals: p.evaluation.approvals,
          approvingFamilies: p.evaluation.approvingFamilies,
          excluded: p.evaluation.excluded,
        },
        mergedCommit: p.mergedCommit,
        mergedVia: p.mergedVia,
        mergeError: p.mergeError,
      }));
    return { shard: this.meta?.shard ?? null, tasks, patches, stats: { ...this.stats, sybilDiscountedReviews: sybil, collusionExcludedReviews: collusion } };
  }

  // ─── Healer ───────────────────────────────────────────────────────────────

  async alarm(): Promise<void> {
    const now = Date.now();
    const writes: Record<string, unknown> = {};
    for (const t of this.tasks.values()) {
      if (t.status === 'claimed' && !t.provisioning && !t.op && (t.leaseExpiresAt ?? 0) <= now) {
        this.reclaim(t);
        writes[`task:${t.id}`] = t;
      }
    }
    for (const p of this.patches.values()) {
      if (p.status === 'evaluating' && p.submittedAt + LIMITS.reviewTimeoutMs <= now) {
        p.status = 'expired';
        p.closedAt = now;
        this.stats.reviewTimeouts++;
        writes[`patch:${p.patchId}`] = p;
        const t = this.tasks.get(p.taskId);
        if (t && t.status === 'submitted' && t.patchId === p.patchId) {
          this.reclaim(t, false);
          writes[`task:${t.id}`] = t;
        }
      }
    }
    if (Object.keys(writes).length > 0) {
      writes.stats = this.stats;
      await this.ctx.storage.put(writes);
    }
    if (this.closedWithBranch().length > 0) await this.cleanupBranches(LIMITS.cleanupPerAlarm);
    await this.scheduleAlarm();
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private reviewGuard(id: AgentIdentity, patchId: string): { ok: true; patch: Patch } | ReturnType<typeof fail> {
    if (id.role !== 'reviewer') return fail(403, 'REVIEWER_ROLE_REQUIRED');
    const patch = this.patches.get(patchId);
    if (!patch) return fail(404, 'PATCH_NOT_FOUND');
    if (patch.status === 'queued') return fail(409, 'PATCH_QUEUED');
    if (TERMINAL_PATCH.has(patch.status)) return fail(409, 'PATCH_TERMINAL', patch.status);
    if (patch.author === id.agentId) return fail(403, 'CANNOT_REVIEW_OWN_PATCH');
    if (patch.reviews.some((r) => r.reviewerId === id.agentId)) return fail(409, 'ALREADY_REVIEWED');
    return { ok: true, patch };
  }

  private leaseGuard(id: AgentIdentity, taskId: string, epoch: number): { ok: true; task: Task & { claimedAt?: number } } | ReturnType<typeof fail> {
    if (id.role !== 'worker') return fail(403, 'WORKER_ROLE_REQUIRED');
    const task = this.tasks.get(taskId);
    if (!task) return fail(404, 'TASK_NOT_FOUND');
    if (task.status !== 'claimed') return fail(409, 'TASK_NOT_CLAIMED', task.status);
    if (task.holder !== id.agentId) return fail(403, 'NOT_LEASE_HOLDER');
    if (task.leaseEpoch !== epoch) return fail(409, 'STALE_LEASE_EPOCH', `current epoch is ${task.leaseEpoch}`);
    if (task.provisioning) return fail(409, 'LEASE_PROVISIONING');
    if (task.op) return fail(409, 'LEASE_BUSY', task.op);
    if ((task.leaseExpiresAt ?? 0) <= Date.now()) return fail(409, 'LEASE_EXPIRED');
    return { ok: true, task };
  }

  private endOp<T extends { ok: false }>(task: Task, epoch: number, r: T): T {
    if (task.leaseEpoch === epoch) task.op = undefined;
    return r;
  }

  /** Return the task to the pool. */
  private reclaim(task: Task & { claimedAt?: number }, countAsHealed = true): void {
    if (countAsHealed) this.stats.leasesReclaimed++;
    Object.assign(task, {
      status: 'available',
      holder: undefined,
      claimedAt: undefined,
      leaseExpiresAt: undefined,
      provisioning: undefined,
      op: undefined,
    });
  }

  private rollbackClaim(task: Task, epoch: number): boolean {
    if (task.leaseEpoch !== epoch || task.status !== 'claimed') return false;
    this.reclaim(task, false);
    return true;
  }

  private readFrom(): { repo: string; remote: string } {
    return this.meta!.read ?? { repo: this.meta!.repo, remote: this.meta!.remote };
  }

  /** Main's head as this shard reads it (its replica, if any), at most once per LIMITS.headCacheMs; shared. */
  private async currentHead(): Promise<string | null> {
    if (this.mainHead && Date.now() - this.mainHead.at < LIMITS.headCacheMs) return this.mainHead.sha;
    this.headInflight ??= this.artifacts
      .head(this.readFrom().repo, 'main')
      .then((sha) => {
        if (sha) this.mainHead = { sha, at: Date.now() };
        return sha;
      })
      .finally(() => (this.headInflight = null));
    return this.headInflight;
  }

  /** The shard's read token for main (memory only), renewed when less than readTokenMinLeftSec remain. */
  private async sharedReadToken(): Promise<MintedToken> {
    const t = this.readToken;
    if (t && Date.parse(t.expiresAt) - Date.now() > LIMITS.readTokenMinLeftSec * 1000) return t;
    this.readTokenInflight ??= this.artifacts
      .mintToken(this.readFrom().repo, 'read', LIMITS.readTokenTtlSec)
      .then((tok) => (this.readToken = tok))
      .finally(() => (this.readTokenInflight = null));
    return this.readTokenInflight;
  }

  private async persistPatch(patch: Patch): Promise<void> {
    const task = this.tasks.get(patch.taskId);
    const writes: Record<string, unknown> = { [`patch:${patch.patchId}`]: patch, stats: this.stats };
    if (task) writes[`task:${task.id}`] = task;
    await this.ctx.storage.put(writes);
  }

  private async scheduleAlarm(): Promise<void> {
    let next = Infinity;
    for (const t of this.tasks.values()) if (t.status === 'claimed' && t.leaseExpiresAt) next = Math.min(next, t.leaseExpiresAt);
    for (const p of this.patches.values()) if (p.status === 'evaluating') next = Math.min(next, p.submittedAt + LIMITS.reviewTimeoutMs);
    if (this.closedWithBranch().length > 0) next = Math.min(next, Date.now() + LIMITS.cleanupDelayMs);
    if (next === Infinity) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 1));
  }
}
