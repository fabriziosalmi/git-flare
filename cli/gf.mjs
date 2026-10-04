#!/usr/bin/env node
// gf — command-line client for git-flare. Zero dependencies (Node >= 22, git).
//
// Credentials: agent/admin keys live in ~/.config/gf/config.json (mode 600) or come from GF_KEY /
// GF_ADMIN_KEY / GF_BASE. Short-lived git tokens returned by `claim` are stored in the clone's
// .git/gf/ (mode 600) and handed to git only through environment variables, never argv or URLs.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

const HELP = `gf — git-flare client

Setup
  gf login --base <url> --key <agent-key> [--profile <name>]   store and verify an agent key
  gf login --base <url> --admin-key <key> [--profile <name>]   store and verify the admin key
  gf whoami

Worker
  gf join <repo>                         provision your fork (once per repository)
  gf tasks <repo> [--all]                list available tasks (--all: every task)
  gf claim <repo> <task> [--dir <path>] [--lease <seconds>]
                                         lease a task and clone main into a ready-to-work branch
  gf heartbeat [--extend <seconds>]      extend the lease          (run inside the task clone)
  gf submit [-m <message>]               push HEAD to your fork and submit it   (inside the clone)
  gf release                             give the task back        (inside the clone)

Reviewer
  gf diff <repo> <patch>                 the platform-computed change of a patch
  gf review <repo> <patch> <1-99> [--reason <text>]

Anyone
  gf status <repo> [--json]              tasks, patches and the merge queue

Admin
  gf admin agent add <id> --role worker|reviewer [--family <model family>] [--days <n>]
  gf admin agent revoke <id>             refuse every key of <id> issued so far (new keys work)
  gf admin repo init <repo> --tasks <file.json> [--shards <n>] [--mirrors <n>] [--reset]
  gf admin repo delete <repo>            delete main, every agent fork and all state (irreversible)
  gf admin repo guard <repo> accept|restore
                                         after a main guard alert: keep main's new head, or move main back to
                                         the last head the merge queue produced and revoke its write tokens
  gf admin repo cleanup <repo> [--idle-days <n>] [--dry-run]
                                         delete branches of closed patches and forks idle for n days (default 7)

Global: --profile <name>, --json (machine output), GF_BASE / GF_KEY / GF_ADMIN_KEY override the profile.`;

const configDir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'gf');
const configFile = path.join(configDir, 'config.json');

class GfError extends Error {}
const die = (msg) => {
  throw new GfError(msg);
};

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(configFile, 'utf8'));
  } catch {
    return { current: 'default', profiles: {} };
  }
}

function saveConfig(cfg) {
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.chmodSync(configFile, 0o600);
}

function profile(opts) {
  const cfg = loadConfig();
  const name = opts.profile || process.env.GF_PROFILE || cfg.current || 'default';
  const p = cfg.profiles[name] || {};
  return {
    name,
    base: (process.env.GF_BASE || p.base || '').replace(/\/$/, ''),
    key: process.env.GF_KEY || p.key,
    adminKey: process.env.GF_ADMIN_KEY || p.adminKey,
  };
}

async function api(base, key, method, p, body) {
  if (!base) die('no base URL: run `gf login --base <url> ...` or set GF_BASE');
  let res;
  for (let attempt = 1; ; attempt++) {
    try {
      res = await fetch(`${base}${p}`, {
        method,
        headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      break;
    } catch (e) {
      // Retry only failures that happen before the request is sent (no connection was made), so a retried
      // submit can never be applied twice. Anything else is reported as is.
      const code = e?.cause?.code ?? e?.cause?.errors?.[0]?.code;
      const beforeSend = ['UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code);
      if (!beforeSend || attempt >= 4) die(`cannot reach ${base}: ${e.message}${code ? ` (${code})` : ''}`);
      await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
    }
  }
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    die(`${method} ${p}: HTTP ${res.status} (not JSON)`);
  }
  if (!res.ok || json.ok === false) die(`${method} ${p}: ${json.error ?? `HTTP ${res.status}`}${json.detail ? ` — ${json.detail}` : ''}`);
  return json;
}

function git(args, { cwd, token, input } = {}) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  if (token) Object.assign(env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}` });
  try {
    return execFileSync('git', args, { cwd, env, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    die(`git ${args[0]} failed: ${(e.stderr || e.message || '').toString().trim().split('\n').slice(-3).join(' | ')}`);
  }
}

// ── fork credentials ─────────────────────────────────────────────────────────
// /join returns a write token for the agent's own fork (about one per hour); claims carry no fork credential.
// The token is cached per profile and repository (0600) and refreshed when less than `minLeftMs` remain.

// Keyed by the agent key (hashed), not the profile name: several agents may share one profile via GF_KEY.
const forkCacheFile = (p, repo) => path.join(configDir, 'forks', `${createHash('sha256').update(`${p.base}\n${p.key}`).digest('hex').slice(0, 24)}__${repo}.json`);

async function forkCredentials(p, repo, minLeftMs = 15 * 60_000) {
  const f = forkCacheFile(p, repo);
  try {
    const c = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (Date.parse(c.tokenExpiresAt) - Date.now() > minLeftMs) return c;
  } catch {
    /* no cache yet */
  }
  const r = await api(p.base, p.key, 'POST', `/api/repos/${repo}/join`);
  const c = { name: r.fork.name, remote: r.fork.remote, token: r.fork.token, tokenExpiresAt: r.fork.tokenExpiresAt };
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  fs.writeFileSync(f, JSON.stringify(c), { mode: 0o600 });
  return c;
}

// ── task clone state ─────────────────────────────────────────────────────────

function gitDir(cwd = process.cwd()) {
  try {
    return path.resolve(cwd, execFileSync('git', ['rev-parse', '--git-dir'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  } catch {
    return null;
  }
}

function writeTaskState(dir, state, forkToken) {
  const d = path.join(dir, '.git', 'gf');
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(d, 'task.json'), JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.writeFileSync(path.join(d, 'fork-token'), forkToken, { mode: 0o600 });
}

function readTaskState() {
  const g = gitDir();
  const f = g && path.join(g, 'gf', 'task.json');
  if (!f || !fs.existsSync(f)) die('not inside a gf task clone (run `gf claim <repo> <task>` first)');
  const state = JSON.parse(fs.readFileSync(f, 'utf8'));
  const token = fs.readFileSync(path.join(g, 'gf', 'fork-token'), 'utf8').trim();
  return { state, token, root: path.dirname(g), file: f };
}

// ── output helpers ───────────────────────────────────────────────────────────

let JSON_OUT = false;
const out = (human, data) => {
  if (JSON_OUT) console.log(JSON.stringify(data ?? human, null, 2));
  else console.log(human);
};

function table(rows, cols) {
  if (rows.length === 0) return '(none)';
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)));
  const line = (vals) => vals.map((v, i) => String(v ?? '').padEnd(w[i])).join('  ').trimEnd();
  return [line(cols), line(w.map((n) => '-'.repeat(n))), ...rows.map((r) => line(cols.map((c) => r[c])))].join('\n');
}

const ago = (ms) => (ms === undefined ? '' : `${Math.max(0, Math.round((ms - Date.now()) / 1000))}s`);

// ── commands ─────────────────────────────────────────────────────────────────

const commands = {
  async login(pos, opts) {
    if (!opts.base) die('--base is required');
    const base = opts.base.replace(/\/$/, '');
    const key = opts.key;
    const adminKey = opts['admin-key'];
    if (!key && !adminKey) die('--key or --admin-key is required');
    const who = await api(base, key ?? adminKey, 'GET', '/api/whoami');
    const cfg = loadConfig();
    const name = opts.profile || 'default';
    cfg.profiles[name] = { ...(cfg.profiles[name] || {}), base, ...(key ? { key } : {}), ...(adminKey ? { adminKey } : {}) };
    cfg.current = name;
    saveConfig(cfg);
    out(who.admin ? `logged in as admin on ${base} (profile ${name})` : `logged in as ${who.agentId} (${who.role}, ${who.modelFamily}) on ${base} (profile ${name})`, who);
  },

  async whoami(pos, opts) {
    const p = profile(opts);
    const who = await api(p.base, p.key ?? p.adminKey, 'GET', '/api/whoami');
    out(who.admin ? `admin @ ${p.base}` : `${who.agentId} (${who.role}, ${who.modelFamily}) @ ${p.base}`, who);
  },

  async join([repo], opts) {
    if (!repo) die('usage: gf join <repo>');
    const p = profile(opts);
    const c = await forkCredentials(p, repo, Infinity); // always asks the server: provisions the fork if needed
    out(`fork ready: ${c.name}`, { ok: true, fork: { name: c.name, remote: c.remote, tokenExpiresAt: c.tokenExpiresAt } });
  },

  async tasks([repo], opts) {
    if (!repo) die('usage: gf tasks <repo> [--all]');
    const p = profile(opts);
    const s = await api(p.base, undefined, 'GET', `/api/repos/${repo}/status`);
    const tasks = s.tasks.filter((t) => opts.all || t.status === 'available');
    out(table(tasks.map((t) => ({ task: t.id, status: t.status, title: t.title, holder: t.holder ?? '', lease: t.leaseExpiresAt ? ago(t.leaseExpiresAt) : '' })), ['task', 'status', 'title', 'holder', 'lease']), tasks);
  },

  async claim([repo, taskId], opts) {
    if (!repo || !taskId) die('usage: gf claim <repo> <task> [--dir <path>] [--lease <seconds>]');
    const p = profile(opts);
    const dir = path.resolve(opts.dir || `${repo}-${taskId}`);
    if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) die(`${dir} exists and is not empty`);
    const fork = await forkCredentials(p, repo);
    const body = { taskId, ...(opts.lease ? { leaseMs: Number(opts.lease) * 1000 } : {}) };
    const c = await api(p.base, p.key, 'POST', `/api/repos/${repo}/claim`, body);
    try {
      git(['clone', '--quiet', '--no-checkout', c.main.remote, dir], { token: c.main.readToken });
      git(['checkout', '--quiet', '-b', c.branch, c.baseCommit], { cwd: dir });
      git(['remote', 'add', 'fork', c.fork.remote], { cwd: dir });
    } catch (e) {
      await api(p.base, p.key, 'POST', `/api/repos/${repo}/release`, { taskId, leaseEpoch: c.leaseEpoch }).catch(() => {});
      throw e;
    }
    const state = { base: p.base, profile: p.name, repo, taskId, leaseEpoch: c.leaseEpoch, branch: c.branch, baseCommit: c.baseCommit, leaseExpiresAt: c.leaseExpiresAt, forkRemote: c.fork.remote, mainRemote: c.main.remote, tokenExpiresAt: fork.tokenExpiresAt };
    writeTaskState(dir, state, fork.token);
    out(`claimed ${taskId} (epoch ${c.leaseEpoch}, lease ${ago(c.leaseExpiresAt)})\n  clone:  ${dir}\n  branch: ${c.branch} @ ${c.baseCommit.slice(0, 12)}\nedit, commit, then: cd ${path.relative(process.cwd(), dir) || '.'} && gf submit`, { ...state, dir });
  },

  async heartbeat(pos, opts) {
    const { state, file } = readTaskState();
    const p = { ...profile({ ...opts, profile: opts.profile || state.profile }), base: state.base };
    const r = await api(p.base, p.key, 'POST', `/api/repos/${state.repo}/heartbeat`, { taskId: state.taskId, leaseEpoch: state.leaseEpoch, ...(opts.extend ? { extendMs: Number(opts.extend) * 1000 } : {}) });
    state.leaseExpiresAt = r.leaseExpiresAt;
    fs.writeFileSync(file, JSON.stringify(state, null, 2), { mode: 0o600 });
    out(`lease extended: ${ago(r.leaseExpiresAt)} left`, r);
  },

  async submit(pos, opts) {
    const task = readTaskState();
    const { state, root } = task;
    let token = task.token;
    const p = { ...profile({ ...opts, profile: opts.profile || state.profile }), base: state.base };
    if (Date.parse(state.tokenExpiresAt) - Date.now() < 5 * 60_000) {
      // The fork token is the agent's, not the lease's: refresh it from /join when it is about to expire.
      const fork = await forkCredentials(p, state.repo, 5 * 60_000);
      writeTaskState(root, { ...state, tokenExpiresAt: fork.tokenExpiresAt }, fork.token);
      token = fork.token;
    }
    if (opts.message) {
      git(['add', '-A'], { cwd: root });
      const staged = git(['diff', '--cached', '--name-only'], { cwd: root });
      if (staged) git(['commit', '--quiet', '-m', opts.message], { cwd: root });
    }
    if (git(['status', '--porcelain'], { cwd: root })) die('uncommitted changes: commit them or use `gf submit -m "<message>"`');
    const sha = git(['rev-parse', 'HEAD'], { cwd: root });
    if (sha === state.baseCommit) die('no commit on top of the base: nothing to submit');
    git(['push', '--quiet', '--force', 'fork', `HEAD:refs/heads/${state.branch}`], { cwd: root, token });
    const r = await api(p.base, p.key, 'POST', `/api/repos/${state.repo}/submit`, { taskId: state.taskId, leaseEpoch: state.leaseEpoch, commitSha: sha });
    const failed = r.gates.filter((g) => !g.passed);
    const lines = [`submitted ${sha.slice(0, 12)} as ${r.patchId}: ${r.status}`, `  ${r.changedFiles} file(s) changed; gates: ${failed.length ? `FAILED ${failed.map((g) => `${g.gate} (${g.detail})`).join('; ')}` : 'passed'}`];
    if (r.duplicateOf) lines.push(`  duplicate of ${r.duplicateOf}`);
    if (r.status === 'evaluating') lines.push('  waiting for reviewers (2 approvals from 2 model families), then the merge queue');
    out(lines.join('\n'), r);
  },

  async release(pos, opts) {
    const { state } = readTaskState();
    const p = { ...profile({ ...opts, profile: opts.profile || state.profile }), base: state.base };
    const r = await api(p.base, p.key, 'POST', `/api/repos/${state.repo}/release`, { taskId: state.taskId, leaseEpoch: state.leaseEpoch });
    out(`released ${state.taskId}`, r);
  },

  async diff([repo, patchId], opts) {
    if (!repo || !patchId) die('usage: gf diff <repo> <patch>');
    const p = profile(opts);
    const r = await api(p.base, p.key, 'GET', `/api/repos/${repo}/patches/${patchId}/diff`);
    const lines = [`${r.patch.patchId} on ${r.patch.taskId} by ${r.patch.author} — ${r.patch.status}`, `base ${r.patch.baseCommit.slice(0, 12)} → ${r.patch.commitSha.slice(0, 12)}`];
    for (const c of r.patch.changes) {
      lines.push(`\n=== ${c.path} (${c.status}${c.binary ? ', binary' : ''}${c.modeChange ? `, mode ${c.modeChange}` : ''})`);
      if (c.hunks) lines.push(c.hunks);
      else {
        for (const l of c.removed) lines.push(`- ${l}`);
        for (const l of c.added) lines.push(`+ ${l}`);
      }
      if (c.strings?.length) lines.push(`[binary; printable strings]`, ...c.strings);
    }
    out(lines.join('\n'), r);
  },

  async review([repo, patchId, confidence], opts) {
    if (!repo || !patchId || !confidence) die('usage: gf review <repo> <patch> <1-99> [--reason <text>]');
    const p = profile(opts);
    const r = await api(p.base, p.key, 'POST', `/api/repos/${repo}/attest`, { patchId, confidencePercent: Number(confidence), ...(opts.reason ? { reasoning: opts.reason } : {}) });
    const e = r.evaluation;
    out(`${patchId}: ${r.status} — log-odds ${e.logOdds}/${e.thresholdLogOdds}, ${e.approvals} approval(s) from ${e.approvingFamilies} famil${e.approvingFamilies === 1 ? 'y' : 'ies'}${e.reasons.length ? ` (${e.reasons.join(', ')})` : ''}`, r);
  },

  async status([repo], opts) {
    if (!repo) die('usage: gf status <repo>');
    const p = profile(opts);
    const s = await api(p.base, undefined, 'GET', `/api/repos/${repo}/status`);
    if (JSON_OUT) return out('', s);
    const q = s.queue;
    const lines = [
      `${s.repo} — ${s.shards} shard(s), ${s.forks} fork(s), artifacts: ${s.mode}`,
      '',
      table(s.tasks.map((t) => ({ task: t.id, status: t.status, holder: t.holder ?? '', epoch: t.leaseEpoch, conflicts: t.conflicts ?? 0, merged: t.mergedCommit ? t.mergedCommit.slice(0, 12) : '' })), ['task', 'status', 'holder', 'epoch', 'conflicts', 'merged']),
      '',
      table(s.patches.slice(0, 20).map((x) => ({ patch: x.patchId, task: x.taskId, author: x.author, status: x.status, reviews: x.reviews.length, note: x.mergeError ? x.mergeError.split('\n')[0].slice(0, 60) : x.mergedVia ?? '' })), ['patch', 'task', 'author', 'status', 'reviews', 'note']),
      '',
      `merge queue: ${q.length} waiting · ${q.pushes} push(es), ${q.mergedPatches} merged, largest batch ${q.largestBatch}, ${q.conflicts} conflict(s) · tests: ${q.testRunner}, ${q.testRuns} run(s), ${q.testRejections} rejected${q.lastError ? `\n  ! ${q.lastError}` : ''}`,
      s.guard
        ? s.guard.state === 'alert'
          ? `main guard: ALERT — ${s.guard.alert.kind}: ${s.guard.alert.detail}`
          : `main guard: ok — no write outside the merge queue seen (${s.guard.counts.events} Artifacts event(s), ${s.guard.counts.ownPushes} own push(es), ${s.guard.counts.foreignPushes} foreign)`
        : '',
      ...(s.mirrors?.length ? [`read replicas: ${s.mirrors.map((m) => `${m.name.split('--').pop()} ${m.current ? 'current' : 'behind'}`).join(', ')}`] : []),
    ];
    out(lines.join('\n'));
  },

  async admin([area, verb, ...rest], opts) {
    const p = profile(opts);
    if (!p.adminKey) die('admin commands need an admin key: `gf login --admin-key ...` or GF_ADMIN_KEY');
    if (area === 'agent' && verb === 'add') {
      const [agentId] = rest;
      if (!agentId || !opts.role) die('usage: gf admin agent add <id> --role worker|reviewer [--family <model family>] [--days <n>]');
      const r = await api(p.base, p.adminKey, 'POST', '/api/agents', { agentId, role: opts.role, ...(opts.family ? { modelFamily: opts.family } : {}), ...(opts.days ? { ttlDays: Number(opts.days) } : {}) });
      return out(`${r.agentId} (${r.role}, ${r.modelFamily})\nkey: ${r.apiKey}\nshare it with the agent only; it is shown once`, r);
    }
    if (area === 'repo' && verb === 'init') {
      const [repo] = rest;
      if (!repo || !opts.tasks) die('usage: gf admin repo init <repo> --tasks <file.json> [--shards <n>] [--mirrors <n>] [--reset]');
      const tasks = JSON.parse(fs.readFileSync(opts.tasks, 'utf8'));
      const r = await api(p.base, p.adminKey, 'POST', `/api/repos/${repo}/init`, { tasks, ...(opts.shards ? { shards: Number(opts.shards) } : {}), ...(opts.mirrors ? { mirrors: Number(opts.mirrors) } : {}), ...(opts.reset ? { reset: true } : {}) });
      return out(`${repo}: ${r.tasks} task(s) on ${r.shards} shard(s) (${r.tasksPerShard.join('/')})${r.mirrors ? `, ${r.mirrors} read replica(s)` : ''}`, r);
    }
    if (area === 'agent' && verb === 'revoke') {
      const [agentId] = rest;
      if (!agentId) die('usage: gf admin agent revoke <id>');
      const r = await api(p.base, p.adminKey, 'POST', `/api/agents/${encodeURIComponent(agentId)}/revoke`);
      return out(`revoked every key of ${agentId} issued up to ${new Date(r.revokedThrough * 1000).toISOString()} (effective everywhere within ${r.propagationSec}s)`, r);
    }
    if (area === 'repo' && verb === 'delete') {
      const [repo] = rest;
      if (!repo) die('usage: gf admin repo delete <repo>');
      let total = 0;
      for (;;) {
        const r = await api(p.base, p.adminKey, 'DELETE', `/api/repos/${repo}`);
        total += r.deletedForks;
        if (r.done) return out(`${repo} deleted (${total} fork(s))`, { ok: true, repo, deletedForks: total });
        if (!JSON_OUT) console.error(`  ${total} fork(s) deleted, ${r.remainingForks} to go`);
      }
    }
    if (area === 'repo' && verb === 'guard') {
      const [repo, action] = rest;
      if (!repo || !['accept', 'restore'].includes(action)) die('usage: gf admin repo guard <repo> accept|restore');
      const r = await api(p.base, p.adminKey, 'POST', `/api/repos/${repo}/guard`, { action });
      return out(`${repo}: main ${action === 'restore' ? 'restored to' : 'accepted at'} ${r.head.slice(0, 12)}${action === 'restore' ? `, ${r.revokedWriteTokens} write token(s) revoked` : ''}; merges resume`, r);
    }
    if (area === 'repo' && verb === 'cleanup') {
      const [repo] = rest;
      if (!repo) die('usage: gf admin repo cleanup <repo> [--idle-days <n>] [--dry-run]');
      const r = await api(p.base, p.adminKey, 'POST', `/api/repos/${repo}/cleanup`, { ...(opts['idle-days'] ? { idleDays: Number(opts['idle-days']) } : {}), ...(opts['dry-run'] ? { dryRun: true } : {}) });
      return out(
        `${repo}${r.dryRun ? ' (dry run)' : ''}: ${r.branches.deleted} branch(es) deleted (${r.branches.alreadyGone} already gone, ${r.branches.remaining} left); ` +
          `forks idle ≥ ${r.forks.idleDays} day(s): ${r.forks.idle}, deleted ${r.forks.deleted}, kept ${r.forks.kept}`,
        r
      );
    }
    die('usage: gf admin agent add|revoke ... | gf admin repo init|delete|cleanup|guard ...');
  },
};

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      base: { type: 'string' },
      key: { type: 'string' },
      'admin-key': { type: 'string' },
      profile: { type: 'string' },
      dir: { type: 'string' },
      lease: { type: 'string' },
      extend: { type: 'string' },
      message: { type: 'string', short: 'm' },
      reason: { type: 'string' },
      role: { type: 'string' },
      family: { type: 'string' },
      days: { type: 'string' },
      tasks: { type: 'string' },
      shards: { type: 'string' },
      mirrors: { type: 'string' },
      'idle-days': { type: 'string' },
      'dry-run': { type: 'boolean' },
      reset: { type: 'boolean' },
      all: { type: 'boolean' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  JSON_OUT = Boolean(values.json);
  const [cmd, ...rest] = positionals;
  if (!cmd || values.help || cmd === 'help') return console.log(HELP);
  const fn = commands[cmd];
  if (!fn) die(`unknown command ${cmd}\n\n${HELP}`);
  await fn(rest, values);
}

main().catch((e) => {
  if (e instanceof GfError) {
    if (JSON_OUT) console.error(JSON.stringify({ ok: false, error: e.message }));
    else console.error(`gf: ${e.message}`);
    process.exit(1);
  }
  console.error(e);
  process.exit(2);
});
