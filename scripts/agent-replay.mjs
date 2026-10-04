#!/usr/bin/env node
// Produce patches with coding agents on a real repository, all from one base commit, so that
// scripts/conflict-replay.mjs can measure how often concurrent agent patches collide (issue #3).
//
//   tasks  pick K real issues that existed at the base commit and were closed by a merged PR in a window
//          (the issue text is the task; the human PR's files are recorded for comparison only):
//            node scripts/agent-replay.mjs tasks --repo <clone> --slug owner/name --since 2026-01-01 [--until 2026-03-01] [--limit 12] --out tasks.json
//   run    one agent per task, each in its own worktree at the base commit, one branch per task:
//            node scripts/agent-replay.mjs run --repo <clone> --tasks tasks.json --out manifest.json [--agent llm|mock]
//                 [--model @cf/qwen/qwen2.5-coder-32b-instruct] [--select-model @cf/meta/llama-3.1-8b-instruct-fp8]
//                 [--max-neurons 8000] [--workdir dir]
//
// The `llm` agent calls Workers AI through the account REST API with the local `wrangler login` (as
// scripts/cf-api.mjs). It is a single-shot agent, not an agent loop: a first call picks up to 4 files from the
// repository tree and the issue, a second call returns search/replace edits for them. It cannot read other
// files, run tests or iterate, so its patches are probably smaller and less complete than those of a full
// agent. (agents/src/index.ts `/code` returns whole files capped at 2,500 tokens; search/replace edits are
// used here because real repositories have files far larger than that.)
//
// Workers AI free allocation is 10,000 neurons a day: every call is counted from the API's token usage,
// added to a per-day ledger shared by all runs, and the run stops before a call that would pass --max-neurons.
// `mock` needs no network: it edits one unique line per chosen file (a trailing space), deterministically, to
// test the plumbing.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { cfApi } from './cf-api.mjs';
import { applyEdits, cleanRanges, extractJson, git, ledgerAdd, ledgerRead, lines, neuronsFor, outlineOf } from './lib/replay.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0];
const arg = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const must = (n) => {
  const v = arg(n);
  if (!v) {
    console.error(`missing --${n} (see the header of scripts/agent-replay.mjs)`);
    process.exit(2);
  }
  return v;
};

const CODER = arg('model', '@cf/qwen/qwen2.5-coder-32b-instruct');
const SELECTOR = arg('select-model', '@cf/meta/llama-3.1-8b-instruct-fp8');
const MAX_FILES = 4;
const MAX_FILE_CHARS = 30_000;
const MAX_CONTEXT_CHARS = 48_000;
const MAX_TREE = 1500;
const CODE_TOKENS = 2500;
const MAX_RANGE_LINES = 160;
const MAX_OUTLINE = 700;

// ─── tasks ──────────────────────────────────────────────────────────────────

function gh(args) {
  return JSON.parse(execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 << 20 }));
}

function tasksCommand() {
  const repo = must('repo');
  const slug = must('slug');
  const since = must('since');
  const until = arg('until', new Date().toISOString().slice(0, 10));
  const limit = Number(arg('limit', '12'));
  const out = must('out');
  const base = git(repo, ['rev-list', '-1', `--before=${since}T00:00:00Z`, 'HEAD']).out.trim();
  if (!base) throw new Error(`no commit before ${since}`);
  const prs = gh(['pr', 'list', '--repo', slug, '--state', 'merged', '--search', `merged:${since}..${until}`, '--limit', '300', '--json', 'number,title,body,mergedAt,files,closingIssuesReferences']);
  const tasks = [];
  const seen = new Set();
  for (const pr of prs.sort((a, b) => a.mergedAt.localeCompare(b.mergedAt))) {
    if (tasks.length >= limit) break;
    if (!(pr.files ?? []).some((f) => !/\.(md|rst|txt)$|^docs?\//i.test(f.path))) continue; // a task that changes code, not only docs
    // Issues the PR closes: GitHub's own links first, then "fixes #N" keywords in the description.
    const nums = [...(pr.closingIssuesReferences ?? []).map((r) => r.number), ...[...(pr.body ?? '').matchAll(/\b(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?)\s+(?:#|https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/issues\/)(\d+)/gi)].map((m) => Number(m[1]))];
    for (const n of [...new Set(nums)]) {
      if (seen.has(n)) continue;
      let issue;
      try {
        issue = gh(['issue', 'view', String(n), '--repo', slug, '--json', 'number,title,body,createdAt,url']);
      } catch {
        continue; // not an issue of this repository
      }
      if (!issue.url.includes('/issues/') || !issue.title || issue.createdAt.slice(0, 10) > since) continue; // the issue has to exist at the base commit
      seen.add(n);
      tasks.push({ id: `i${issue.number}`, issue: { number: issue.number, title: issue.title, body: (issue.body ?? '').slice(0, 6000) }, pr: { number: pr.number, files: pr.files.map((f) => f.path) } });
      break;
    }
  }
  fs.writeFileSync(out, `${JSON.stringify({ slug, base, since, until, tasks }, null, 2)}\n`);
  console.log(`${tasks.length} task(s) at base ${base.slice(0, 12)} → ${out}`);
}

// ─── agents ─────────────────────────────────────────────────────────────────

const SELECT_SYSTEM = `You help locate the code to change for an issue in a repository. You get the issue and the list of
repository files. Return JSON {"files": [paths]} with 1 to ${MAX_FILES} existing paths, copied exactly from the list, that most
likely need to be edited to resolve the issue (source files; a test file only if the issue asks for tests).`;
const SELECT_SCHEMA = { type: 'object', properties: { files: { type: 'array', items: { type: 'string' } } }, required: ['files'] };

const CODE_SYSTEM = `You are an autonomous coding agent resolving an issue in an existing repository. You get the issue and
the full content of the files you may edit. Make the smallest correct change. Return JSON {"message": commit message,
"edits": [{"path", "search", "replace"}]}. "search" is an exact, contiguous excerpt of the current file that occurs exactly
once (include enough surrounding lines to be unique); "replace" is what it becomes. To create a new file use an empty
"search" and the whole content as "replace". Do not touch unrelated code.`;
const CODE_SCHEMA = {
  type: 'object',
  properties: {
    message: { type: 'string' },
    edits: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, search: { type: 'string' }, replace: { type: 'string' } }, required: ['path', 'search', 'replace'] } },
  },
  required: ['message', 'edits'],
};

const VIEW_SYSTEM = `You are reading a large source file to resolve an issue. You get the issue and an outline of the file: its
definitions with their line numbers. Return JSON {"ranges": [{"start": line, "end": line}]} with 1 to 3 line ranges of at
most ${MAX_RANGE_LINES} lines each that contain the code to read and change (a whole function or class body, not just its first line).`;
const VIEW_SCHEMA = { type: 'object', properties: { ranges: { type: 'array', items: { type: 'object', properties: { start: { type: 'integer' }, end: { type: 'integer' } }, required: ['start', 'end'] } } }, required: ['ranges'] };

const budget = { max: Number(arg('max-neurons', '8000')), spentThisRun: 0, calls: 0, stopped: false };

class BudgetStop extends Error {}

/** Models that reject `response_format: json_schema` are asked in the prompt to answer with a JSON object only. */
const TEXT_JSON_MODELS = new Set(['@cf/meta/llama-3.1-8b-instruct-fp8']);

/** One Workers AI call: JSON mode, usage counted into the daily ledger. Throws BudgetStop before a call that could pass the cap. */
async function ai(model, system, user, schema, maxTokens) {
  const estIn = Math.ceil((system.length + user.length) / 3); // chars/3: deliberately pessimistic
  const worst = neuronsFor(model, estIn, maxTokens);
  const day = ledgerRead().spent;
  if (day + worst > budget.max) throw new BudgetStop(`next call could cost ${worst.toFixed(0)} neurons; ${day.toFixed(0)} spent today, cap ${budget.max}`);
  let r;
  for (let attempt = 1; ; attempt++) {
    try {
      const textJson = TEXT_JSON_MODELS.has(model);
      const sys = textJson ? `${system}\nAnswer with the JSON object only, no other text.` : system;
      r = await cfApi('POST', `/ai/run/${model}`, { messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], max_tokens: maxTokens, temperature: 0.1, ...(textJson ? {} : { response_format: { type: 'json_schema', json_schema: schema } }) });
      break;
    } catch (e) {
      if (attempt >= 3 || /401|403|auth/i.test(String(e.message))) throw e;
      await new Promise((res) => setTimeout(res, 2000 * attempt));
    }
  }
  const tin = r.usage?.prompt_tokens ?? estIn;
  const tout = r.usage?.completion_tokens ?? maxTokens;
  const estimated = r.usage?.prompt_tokens === undefined;
  const neurons = neuronsFor(model, tin, tout);
  ledgerAdd(neurons);
  budget.spentThisRun += neurons;
  budget.calls++;
  return { out: extractJson(r.response), tin, tout, neurons, estimated };
}

const SKIP_EXT = /\.(png|jpe?g|gif|ico|svg|woff2?|ttf|eot|pdf|zip|gz|tgz|lock|map|min\.js|snap)$/i;
const treeOf = (repo, ref) => lines(git(repo, ['ls-tree', '-r', '--name-only', ref]).out).filter((p) => !SKIP_EXT.test(p)).slice(0, MAX_TREE);

const hash = (s) => parseInt(createHash('sha256').update(s).digest('hex').slice(0, 8), 16);

const agents = {
  mock: {
    async select(task, tree) {
      const inTree = new Set(tree);
      const files = task.pr.files.filter((f) => inTree.has(f)).slice(0, MAX_FILES);
      return { files: files.length ? files : tree.slice(0, 1), calls: [] };
    },
    async view(task, p, outline, total) {
      const start = 1 + (hash(task.id + p) % Math.max(total - 79, 1));
      return { ranges: [{ start, end: Math.min(start + 79, total) }], calls: [] };
    },
    async edit(task, segments, whole) {
      const edits = [];
      const done = new Set();
      for (const seg of segments) {
        if (done.has(seg.path)) continue;
        const ls = seg.text.split('\n');
        const start = hash(task.id + seg.path) % Math.max(ls.length, 1);
        for (let k = 0; k < ls.length; k++) {
          const l = ls[(start + k) % ls.length];
          if (l.trim() !== '' && whole[seg.path].indexOf(l) === whole[seg.path].lastIndexOf(l) && !l.endsWith(' ')) {
            edits.push({ path: seg.path, search: l, replace: `${l} ` });
            done.add(seg.path);
            break;
          }
        }
      }
      return { message: `mock edit for ${task.id}`, edits, calls: [] };
    },
  },
  llm: {
    async select(task, tree) {
      const user = `ISSUE #${task.issue.number}: ${task.issue.title}\n${task.issue.body}\n\nREPOSITORY FILES:\n${tree.join('\n')}`.slice(0, 40_000);
      const r = await ai(SELECTOR, SELECT_SYSTEM, user, SELECT_SCHEMA, 300);
      const inTree = new Set(tree);
      const files = [...new Set(Array.isArray(r.out?.files) ? r.out.files.filter((f) => typeof f === 'string' && inTree.has(f)) : [])].slice(0, MAX_FILES);
      return { files, calls: [{ step: 'select', model: SELECTOR, tin: r.tin, tout: r.tout, neurons: r.neurons, estimated: r.estimated }] };
    },
    async view(task, p, outline, total) {
      const user = `ISSUE #${task.issue.number}: ${task.issue.title}\n${task.issue.body}\n\nOUTLINE OF ${p} (${total} lines):\n${outline.map((o) => `${o.line}: ${o.text}`).join('\n')}`.slice(0, 40_000);
      const r = await ai(SELECTOR, VIEW_SYSTEM, user, VIEW_SCHEMA, 200);
      return { ranges: Array.isArray(r.out?.ranges) ? r.out.ranges : [], calls: [{ step: 'view', model: SELECTOR, tin: r.tin, tout: r.tout, neurons: r.neurons, estimated: r.estimated }] };
    },
    async edit(task, segments) {
      let user = `ISSUE #${task.issue.number}: ${task.issue.title}\n${task.issue.body}\n\nFILES YOU MAY EDIT (a header says when only part of a file is shown):\n`;
      for (const g of segments) user += `\n--- ${g.path}${g.total ? ` (excerpt: lines ${g.start}-${g.end} of ${g.total})` : ''}\n${g.text}\n`;
      const r = await ai(CODER, CODE_SYSTEM, user, CODE_SCHEMA, CODE_TOKENS);
      return { message: String(r.out?.message ?? `resolve #${task.issue.number}`).slice(0, 200), edits: Array.isArray(r.out?.edits) ? r.out.edits : [], calls: [{ step: 'edit', model: CODER, tin: r.tin, tout: r.tout, neurons: r.neurons, estimated: r.estimated }] };
    },
  },
};

// ─── run ────────────────────────────────────────────────────────────────────

async function runOne(repo, base, task, agent, runId, workdir) {
  const rec = { id: task.id, issue: task.issue.number, humanFiles: task.pr.files, selected: [], editedFiles: [], failedEdits: [], status: 'pending', calls: [] };
  const wt = path.join(workdir, task.id);
  git(repo, ['worktree', 'add', '--detach', '--force', wt, base]);
  try {
    const tree = treeOf(repo, base);
    const sel = await agent.select(task, tree);
    rec.calls.push(...sel.calls);
    rec.selected = sel.files;
    if (sel.files.length === 0) return Object.assign(rec, { status: 'no-files' });
    const segments = [];
    const whole = {};
    let used = 0;
    for (const f of sel.files) {
      const text = fs.readFileSync(path.join(wt, f), 'utf8');
      whole[f] = text;
      const ls = text.split('\n');
      if (text.length <= MAX_FILE_CHARS && used + text.length <= MAX_CONTEXT_CHARS) {
        segments.push({ path: f, text });
        used += text.length;
        continue;
      }
      // A file too large to read whole: the agent sees its outline and picks the ranges to read.
      const v = await agent.view(task, f, outlineOf(text, MAX_OUTLINE), ls.length);
      rec.calls.push(...v.calls);
      for (const r of cleanRanges(v.ranges, ls.length, MAX_RANGE_LINES)) {
        const seg = ls.slice(r.start - 1, r.end).join('\n');
        if (used + seg.length > MAX_CONTEXT_CHARS) {
          rec.failedEdits.push({ path: f, reason: 'no room left in the context' });
          continue;
        }
        segments.push({ path: f, text: seg, start: r.start, end: r.end, total: ls.length });
        used += seg.length;
      }
    }
    if (segments.length === 0) return Object.assign(rec, { status: 'no-context' });
    rec.excerpted = [...new Set(segments.filter((g) => g.total).map((g) => g.path))];
    const ed = await agent.edit(task, segments, whole);
    rec.calls.push(...ed.calls);
    const { applied, failed } = applyEdits(wt, ed.edits);
    rec.failedEdits.push(...failed);
    rec.editedFiles = applied;
    if (applied.length === 0) return Object.assign(rec, { status: 'no-patch' });
    const ident = ['-c', 'user.name=agent-replay', '-c', 'user.email=agent-replay@invalid'];
    git(wt, ['add', '-A']);
    git(wt, [...ident, 'commit', '-q', '-m', ed.message]);
    const sha = git(wt, ['rev-parse', 'HEAD']).out.trim();
    const branch = `agent-replay/${runId}/${task.id}`;
    git(wt, ['branch', branch]);
    rec.shortstat = git(repo, ['diff', '--shortstat', base, sha]).out.trim();
    return Object.assign(rec, { status: 'committed', sha, branch });
  } finally {
    git(repo, ['worktree', 'remove', '--force', wt], [0, 128]);
  }
}

async function runCommand() {
  const repo = must('repo');
  const spec = JSON.parse(fs.readFileSync(must('tasks'), 'utf8'));
  const out = must('out');
  const kind = arg('agent', 'llm');
  const agent = agents[kind];
  if (!agent) throw new Error(`--agent must be llm or mock`);
  if (git(repo, ['cat-file', '-t', spec.base], [0, 128]).out.trim() !== 'commit') throw new Error(`base ${spec.base} is not in ${repo}`);
  const runId = arg('run-id', new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14));
  const workdir = arg('workdir', fs.mkdtempSync(path.join(os.tmpdir(), 'agent-replay-')));
  const rows = [];
  for (const task of spec.tasks) {
    if (budget.stopped) {
      rows.push({ id: task.id, issue: task.issue.number, humanFiles: task.pr.files, status: 'budget-stop', calls: [] });
      continue;
    }
    try {
      const rec = await runOne(repo, spec.base, task, agent, runId, workdir);
      rows.push(rec);
      console.log(`${task.id.padEnd(8)} ${rec.status.padEnd(12)} files=${rec.editedFiles.join(',') || '-'} ${rec.shortstat ?? ''}`);
    } catch (e) {
      if (e instanceof BudgetStop) {
        budget.stopped = true;
        console.log(`${task.id.padEnd(8)} budget-stop   ${e.message}`);
        rows.push({ id: task.id, issue: task.issue.number, humanFiles: task.pr.files, status: 'budget-stop', note: e.message, calls: [] });
      } else {
        console.log(`${task.id.padEnd(8)} error         ${String(e.message).slice(0, 160)}`);
        rows.push({ id: task.id, issue: task.issue.number, humanFiles: task.pr.files, status: 'error', note: String(e.message).slice(0, 300), calls: [] });
      }
    }
  }
  const manifest = {
    runId,
    date: new Date().toISOString().slice(0, 10),
    slug: spec.slug,
    base: spec.base,
    agent: kind,
    ...(kind === 'llm' ? { coder: CODER, selector: SELECTOR, note: 'single-shot: file selection + search/replace edits, no tool use' } : {}),
    neuronsThisRun: Math.round(budget.spentThisRun),
    neuronsToday: Math.round(ledgerRead().spent),
    tasks: rows,
  };
  fs.writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
  const by = rows.reduce((m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {});
  console.log(`${JSON.stringify(by)}; ${manifest.neuronsThisRun} neurons this run (${manifest.neuronsToday} today) → ${out}`);
}

if (cmd === 'tasks') tasksCommand();
else if (cmd === 'run') await runCommand();
else {
  console.error('usage: node scripts/agent-replay.mjs tasks|run ... (see the header of the script)');
  process.exit(2);
}
