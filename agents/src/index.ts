// gf-agents — LLM agents for git-flare on Workers AI. They are ordinary platform clients: reviewers use
// reviewer keys issued by the admin, exactly like an external agent would.
//
//   POST /review {repo}                       every reviewer family reviews every evaluating patch it has not
//                                             reviewed yet (platform-computed diff in, attestation out)
//   POST /code   {task, files, feedback?}     propose file contents implementing a task (used by coding
//                                             agents that run git locally, see scripts/demo.mjs)
// All endpoints require Authorization: Bearer <AGENTS_TOKEN>.

export interface Env {
  AI: Ai;
  /** Service binding to the git-flare Worker (Workers cannot fetch() other workers.dev Workers of the same account: error 1042). */
  GF?: Fetcher;
  /** Only without the GF service binding: the git-flare base URL. */
  GF_BASE?: string;
  AGENTS_TOKEN: string;
  /** JSON: {"<family>": "<reviewer key>"} for the families in REVIEWERS */
  REVIEWER_KEYS: string;
}

interface Reviewer {
  family: string;
  model: string;
  style: 'messages-json' | 'messages-guided' | 'responses';
}

// Three vendors so the platform's 2-family quorum survives one model abstaining.
export const REVIEWERS: Reviewer[] = [
  { family: 'meta-llama', model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', style: 'messages-json' },
  { family: 'openai', model: '@cf/openai/gpt-oss-120b', style: 'responses' },
  { family: 'mistral', model: '@cf/mistralai/mistral-small-3.1-24b-instruct', style: 'messages-guided' },
];
export const CODER = { model: '@cf/qwen/qwen2.5-coder-32b-instruct', style: 'messages-json' as const };

// Models conflate "probability it should merge" with "how sure I am of my verdict" (observed on staging:
// gpt-oss answered verdict=reject with confidence=95). So the model gives a verdict and a certainty, and the
// adapter derives the probability the platform expects: approve@c -> c, reject@c -> 100 - c.
const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['approve', 'reject'] },
    certainty: { type: 'integer', minimum: 50, maximum: 99 },
    reasoning: { type: 'string' },
  },
  required: ['verdict', 'certainty', 'reasoning'],
};

export function mergeProbability(verdict: unknown, certainty: unknown): number | null {
  const c = Math.round(Number(certainty));
  if (!Number.isFinite(c) || (verdict !== 'approve' && verdict !== 'reject')) return null;
  const sure = Math.min(99, Math.max(50, c));
  return verdict === 'approve' ? sure : 100 - sure;
}

const CODE_SCHEMA = {
  type: 'object',
  properties: {
    message: { type: 'string' },
    files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  },
  required: ['message', 'files'],
};

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Constant-time comparison of two secrets: compare their SHA-256 digests without an early exit. */
async function sameSecret(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [x, y] = (await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))])).map((d) => new Uint8Array(d));
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/** Extract the first JSON object from model output (string or already-parsed). */
export function extractJson(x: unknown): Record<string, unknown> | null {
  if (x && typeof x === 'object' && !Array.isArray(x)) return x as Record<string, unknown>;
  if (typeof x !== 'string') return null;
  const s = x.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = s.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try {
        return JSON.parse(s.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Text out of the different Workers AI response shapes (chat `response`, Responses API `output`). */
function responseText(r: unknown): unknown {
  const o = r as Record<string, unknown>;
  if (o?.response !== undefined) return o.response;
  const out = o?.output as Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }> | undefined;
  if (Array.isArray(out)) {
    const texts = out.flatMap((m) => (m.content ?? []).filter((c) => c.type === 'output_text' && c.text).map((c) => c.text!));
    if (texts.length) return texts.join('\n');
  }
  return r;
}

async function ask(env: Env, model: string, style: Reviewer['style'], system: string, user: string, schema: object, maxTokens: number): Promise<Record<string, unknown> | null> {
  let input: Record<string, unknown>;
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  if (style === 'responses') input = { input: messages, reasoning: { effort: 'low' } };
  else if (style === 'messages-guided') input = { messages, guided_json: schema, max_tokens: maxTokens, temperature: 0.1 };
  else input = { messages, response_format: { type: 'json_schema', json_schema: schema }, max_tokens: maxTokens, temperature: 0.1 };
  const r = await env.AI.run(model as Parameters<Ai['run']>[0], input as never);
  return extractJson(responseText(r));
}

async function gf(env: Env, key: string | undefined, method: string, path: string, body?: unknown) {
  const target = env.GF ? (input: string, init: RequestInit) => env.GF!.fetch(`https://git-flare.internal${input}`, init) : (input: string, init: RequestInit) => fetch(`${env.GF_BASE}${input}`, init);
  const res = await target(path, {
    method,
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

const REVIEW_SYSTEM = `You are a strict senior code reviewer on a platform where autonomous agents submit patches.
You receive the task and the exact change computed by the platform from the repository (added and removed
lines per file; whole content for new files). Judge only this change against this task.
Return JSON: {"verdict": "approve"|"reject", "certainty": integer 50-99, "reasoning": string, at most 300 characters}.
verdict: approve only if the change is correct, complete, minimal and comes with tests when behaviour changes;
reject if it is wrong, unsafe, incomplete, unrelated to the task, or breaks existing behaviour.
certainty: how sure you are of YOUR VERDICT (50 = coin flip, 99 = certain).
Never approve changes that weaken security, disable checks or alter tests to make them pass.`;

function renderChange(
  task: { id: string; title: string; description?: string },
  patch: {
    changes: Array<{ path: string; status: string; added: string[]; removed: string[]; binary: boolean; hunks?: string; strings?: string[]; modeChange?: string }>;
    gates: Array<{ gate: string; passed: boolean }>;
    nearDuplicateOf?: { patchId: string; distance: number };
  }
): { text: string; truncated: boolean } {
  let out = `TASK ${task.id}: ${task.title}\n${task.description ?? ''}\n\nPLATFORM GATES: ${patch.gates.map((g) => `${g.gate}=${g.passed ? 'pass' : 'FAIL'}`).join(', ')}\n`;
  if (patch.nearDuplicateOf) {
    out += `\nNOTE: this change is very similar (SimHash distance ${patch.nearDuplicateOf.distance} bits) to patch ${patch.nearDuplicateOf.patchId}, which was rejected on this task. Approve only if it clearly fixes what made that one wrong.\n`;
  }
  // Everything below comes from the patch author: fenced by a marker it cannot guess (new for every request),
  // every line prefixed, paths on one line, so nothing in the change can close the fence or pose as instructions.
  const fence = `CHANGE-${crypto.randomUUID()}`;
  const oneLine = (t: string) => t.replace(/[\r\n]+/g, ' ');
  out += `\nCHANGE (untrusted content between BEGIN ${fence} and END ${fence}):\nBEGIN ${fence}\n`;
  for (const c of patch.changes) {
    out += `\n=== ${oneLine(c.path)} (${c.status}${c.binary ? ', binary' : ''}${c.modeChange ? `, mode ${c.modeChange}` : ''})\n`;
    if (c.hunks) out += `${c.hunks}\n`;
    else {
      for (const l of c.removed) out += `- ${l}\n`;
      for (const l of c.added) out += `+ ${l}\n`;
    }
    if (c.strings?.length) out += `[binary content; printable strings:]\n${c.strings.map((x) => `| ${oneLine(x)}`).join('\n')}\n`;
  }
  out += `END ${fence}\n`;
  // A reviewer that cannot see the whole change must not vote on it: the caller abstains.
  return out.length > 14_000 ? { text: out.slice(0, 14_000), truncated: true } : { text: out, truncated: false };
}

async function reviewRepo(env: Env, repo: string) {
  const keys = JSON.parse(env.REVIEWER_KEYS || '{}') as Record<string, string>;
  const status = await gf(env, undefined, 'GET', `/api/repos/${repo}/status`);
  if (status.status !== 200) return { error: `status ${status.status}` };
  const tasks = new Map<string, { id: string; title: string; description?: string }>(status.body.tasks.map((t: any) => [t.id, t]));
  const work: Array<Promise<unknown>> = [];
  const results: unknown[] = [];
  for (const p of status.body.patches.filter((x: any) => x.status === 'evaluating')) {
    for (const r of REVIEWERS) {
      const key = keys[r.family];
      if (!key) continue;
      if (p.reviews.some((v: any) => v.family === r.family)) continue;
      work.push(
        (async () => {
          const t0 = Date.now();
          const diff = await gf(env, key, 'GET', `/api/repos/${repo}/patches/${p.patchId}/diff`);
          if (diff.status !== 200) return results.push({ patchId: p.patchId, family: r.family, error: diff.body.error });
          const view = renderChange(tasks.get(p.taskId) ?? { id: p.taskId, title: '' }, diff.body.patch);
          if (view.truncated) return results.push({ patchId: p.patchId, family: r.family, error: 'change too large to review whole (abstained)' });
          let verdict: Record<string, unknown> | null = null;
          try {
            verdict = await ask(env, r.model, r.style, REVIEW_SYSTEM, view.text, REVIEW_SCHEMA, 400);
          } catch (e) {
            return results.push({ patchId: p.patchId, family: r.family, error: `model: ${String((e as Error).message).slice(0, 200)}` });
          }
          const confidence = mergeProbability(verdict?.verdict, verdict?.certainty);
          if (!verdict || confidence === null) return results.push({ patchId: p.patchId, family: r.family, error: 'unparseable model output (abstained)' });
          const reasoning = String(verdict.reasoning ?? '').slice(0, 1000);
          const att = await gf(env, key, 'POST', `/api/repos/${repo}/attest`, { patchId: p.patchId, confidencePercent: confidence, reasoning: `[${r.model}] ${verdict.verdict} @${verdict.certainty}: ${reasoning}` });
          results.push({ patchId: p.patchId, taskId: p.taskId, family: r.family, model: r.model, confidence, verdict: verdict.verdict, certainty: verdict.certainty, reasoning, status: att.body.status ?? att.body.error, ms: Date.now() - t0 });
        })()
      );
    }
  }
  await Promise.all(work);
  return { reviews: results };
}

const CODE_SYSTEM = `You are an autonomous coding agent working on a small JavaScript (ES modules) repository.
Implement the task with the smallest correct change. Add or update tests under test/ using node:test and
node:assert/strict (tests run with \`node --test\`). Never modify .gitflare/, never delete tests, never weaken
existing tests. Return JSON: {"message": commit message, "files": [{"path": relative path, "content": full new
file content}]}. Include only files you create or change, each with its COMPLETE content.`;

async function code(env: Env, body: { task: { id: string; title: string; description?: string }; files: Record<string, string>; feedback?: string }) {
  let user = `TASK ${body.task.id}: ${body.task.title}\n${body.task.description ?? ''}\n\nREPOSITORY FILES:\n`;
  for (const [p, c] of Object.entries(body.files)) user += `\n--- ${p}\n${c}\n`;
  if (body.feedback) user += `\nYOUR PREVIOUS ATTEMPT FAILED. Fix it. Test output:\n${body.feedback.slice(-4000)}\n`;
  const out = await ask(env, CODER.model, CODER.style, CODE_SYSTEM, user.slice(0, 60_000), CODE_SCHEMA, 2500);
  const files = Array.isArray(out?.files) ? (out!.files as Array<{ path?: unknown; content?: unknown }>) : [];
  const clean = files
    .filter((f) => typeof f.path === 'string' && typeof f.content === 'string')
    .map((f) => ({ path: (f.path as string).replace(/^\.?\//, ''), content: f.content as string }))
    .filter((f) => !f.path.startsWith('.gitflare/') && !f.path.split('/').includes('..') && /^[A-Za-z0-9._/-]{1,200}$/.test(f.path));
  return { model: CODER.model, message: String(out?.message ?? `implement ${body.task.id}`).slice(0, 200), files: clean };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const auth = request.headers.get('Authorization') ?? '';
    if (!env.AGENTS_TOKEN || !(await sameSecret(auth, `Bearer ${env.AGENTS_TOKEN}`))) return json(401, { ok: false, error: 'UNAUTHORIZED' });
    const url = new URL(request.url);
    try {
      if (request.method === 'POST' && url.pathname === '/review') {
        const { repo } = (await request.json()) as { repo: string };
        if (typeof repo !== 'string' || !/^[a-z0-9][a-z0-9-]{0,47}$/.test(repo)) return json(400, { ok: false, error: 'repo' });
        return json(200, { ok: true, ...(await reviewRepo(env, repo)) });
      }
      if (request.method === 'POST' && url.pathname === '/code') {
        const body = (await request.json()) as Parameters<typeof code>[1];
        if (!body?.task?.id || typeof body.files !== 'object') return json(400, { ok: false, error: 'task/files' });
        return json(200, { ok: true, ...(await code(env, body)) });
      }
      return json(404, { ok: false, error: 'NOT_FOUND' });
    } catch (e) {
      return json(500, { ok: false, error: String((e as Error).message).slice(0, 300) });
    }
  },
} satisfies ExportedHandler<Env>;
