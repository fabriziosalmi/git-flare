import { HOT } from './replay.mjs';

// Pure parts of the queue simulation (scripts/queue-sim.mjs): seeded randomness, footprints, and the metrics computed
// from what the run recorded. Unit-tested in scripts/sim.test.mjs.

/**
 * A name for a cell's repository and agents that two cells started in the same millisecond, in one process or in
 * several, cannot share (they would claim each other's tasks): time, process id and a random part.
 */
export function uniqueName(now = Date.now(), pid = process.pid, rand = Math.random) {
  return `${now.toString(36)}${pid.toString(36)}${Math.floor(rand() * 36 ** 4).toString(36).padStart(4, '0')}`;
}

/** mulberry32: a small seeded generator returning floats in [0, 1): the same seed gives the same run. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A duration in ms: lognormal with the given mean and coefficient of variation (cv 0 = constant). Never below 1 ms. */
export function lognormalMs(rand, mean, cv) {
  if (!(mean > 0)) return 0;
  if (!(cv > 0)) return mean;
  const sigma2 = Math.log(1 + cv * cv);
  const mu = Math.log(mean) - sigma2 / 2;
  const u1 = Math.max(rand(), 1e-12);
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * rand());
  return Math.max(1, Math.exp(mu + Math.sqrt(sigma2) * z));
}

/**
 * The footprints (lists of paths) of agent-replay manifests or tasks files. kind: 'human' (the files of the pull requests that closed
 * the tasks) or 'agent' (the files the agent edited, committed patches only); either with '-nohot' to leave out
 * changelog, version and dependency files (what a rule that merges those structurally would take out of the conflicts).
 * Paths that the API would refuse are dropped, and so are footprints left empty.
 */
export function footprintsOf(manifests, kind) {
  const m = /^(human|agent)(-nohot)?$/.exec(kind);
  if (!m) throw new Error(`unknown footprint kind ${kind}: human, agent, human-nohot or agent-nohot`);
  const out = [];
  for (const manifest of manifests) {
    for (const t of manifest.tasks) {
      let files = m[1] === 'agent' ? (t.status === 'committed' ? t.editedFiles : []) : (t.humanFiles ?? t.pr?.files); // a manifest, or the tasks file of agent-replay
      files = (files ?? []).filter((f) => /^[A-Za-z0-9._/-]{1,200}$/.test(f));
      if (m[2]) files = files.filter((f) => !HOT.test(f));
      if (files.length > 0) out.push(files);
    }
  }
  return out;
}

/** Footprints from the files of real changes: one is drawn uniformly, with replacement. */
export function empiricalSampler(rand, footprints) {
  const usable = footprints.filter((f) => Array.isArray(f) && f.length > 0);
  if (usable.length === 0) throw new Error('no footprint to sample from');
  return () => [...usable[Math.floor(rand() * usable.length)]];
}

/**
 * The footprints in a seeded shuffled order, each used once before any is used again (the sampler above draws with
 * replacement, so a small population repeats a footprint often). Used for the no-replacement sensitivity of G1.
 */
export function shuffledSampler(rand, footprints) {
  const usable = footprints.filter((f) => Array.isArray(f) && f.length > 0);
  if (usable.length === 0) throw new Error('no footprint to sample from');
  let order = [];
  return () => {
    if (order.length === 0) {
      order = usable.map((_, i) => i);
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
    }
    return [...usable[order.pop()]];
  };
}

/**
 * Synthetic footprints: `files` paths ranked by popularity with weight 1 / rank^s (s = 0 is uniform), the number of
 * files per patch drawn from `sizes`, files within a patch distinct.
 */
export function zipfSampler(rand, { files, s = 1, sizes = [1] }) {
  const paths = Array.from({ length: files }, (_, i) => `src/f${String(i + 1).padStart(3, '0')}.py`);
  const weights = paths.map((_, i) => 1 / (i + 1) ** s);
  const total = weights.reduce((a, b) => a + b, 0);
  const one = () => {
    let x = rand() * total;
    for (let i = 0; i < paths.length; i++) {
      x -= weights[i];
      if (x <= 0) return paths[i];
    }
    return paths[paths.length - 1];
  };
  return () => {
    const n = Math.min(sizes[Math.floor(rand() * sizes.length)], paths.length);
    const picked = new Set();
    while (picked.size < n) picked.add(one());
    return [...picked];
  };
}

/** The q-quantile (0..1) of numbers by linear interpolation; null for no data. */
export function quantile(xs, q) {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

const round1 = (x) => (x === null ? null : Math.round(x * 10) / 10);

/**
 * What a run produced. `patches`: every patch submitted, with the times the server recorded (claimedAt, submittedAt,
 * queuedAt, closedAt, from /status) and its outcome status ('merged', 'stale' for a conflict, anything else counts as
 * another rejection) and `attempt` (1 for the first patch of a task). `wallMs`: how long the run lasted.
 *
 * rejectionPerSubmission = stale / (merged + stale): the share of submissions the queue sent back as a conflict.
 * firstAttemptRejectionPct is the same for first attempts only (a freshly made patch), the figure comparable with the
 * curve measured on history. landings of a patch = merged patches whose close falls within its own window
 * (claimedAt, closedAt], not counting itself.
 */
export function summarizeRun({ patches, wallMs }) {
  const decided = patches.filter((p) => p.status === 'merged' || p.status === 'stale');
  const merged = decided.filter((p) => p.status === 'merged');
  const stale = decided.filter((p) => p.status === 'stale');
  const first = decided.filter((p) => p.attempt === 1);
  const timed = decided.filter((p) => [p.claimedAt, p.submittedAt, p.queuedAt, p.closedAt].every((t) => typeof t === 'number'));
  const mergeEntries = merged.filter((p) => typeof p.closedAt === 'number').map((p) => ({ id: p.patchId, at: p.closedAt }));
  const landings = timed.map((p) => mergeEntries.filter((m) => m.id !== p.patchId && m.at > p.claimedAt && m.at <= p.closedAt).length); // by identity: patches of one batch can close in the same millisecond
  const attemptsByTask = new Map();
  for (const p of patches) attemptsByTask.set(p.taskId, Math.max(attemptsByTask.get(p.taskId) ?? 0, p.attempt));
  const attemptsHistogram = {};
  for (const n of attemptsByTask.values()) attemptsHistogram[n] = (attemptsHistogram[n] ?? 0) + 1;
  const col = (ps, f) => ps.map(f).filter((x) => typeof x === 'number' && x >= 0);
  const mergedTimed = timed.filter((p) => p.status === 'merged');
  return {
    submissions: patches.length,
    merged: merged.length,
    stale: stale.length,
    other: patches.length - decided.length,
    rejectionPerSubmissionPct: decided.length ? round1((100 * stale.length) / decided.length) : null,
    firstAttemptRejectionPct: first.length ? round1((100 * first.filter((p) => p.status === 'stale').length) / first.length) : null,
    tasks: attemptsByTask.size,
    attemptsPerTask: attemptsHistogram,
    maxAttempts: attemptsByTask.size ? Math.max(...attemptsByTask.values()) : 0,
    windowMs: { p50: round1(quantile(col(timed, (p) => p.closedAt - p.claimedAt), 0.5)), p90: round1(quantile(col(timed, (p) => p.closedAt - p.claimedAt), 0.9)), p99: round1(quantile(col(timed, (p) => p.closedAt - p.claimedAt), 0.99)) },
    partsMs: {
      work: round1(quantile(col(mergedTimed, (p) => p.submittedAt - p.claimedAt), 0.5)),
      review: round1(quantile(col(mergedTimed, (p) => p.queuedAt - p.submittedAt), 0.5)),
      queueAndTests: round1(quantile(col(mergedTimed, (p) => p.closedAt - p.queuedAt), 0.5)),
    },
    landingsPerWindow: { mean: landings.length ? round1(landings.reduce((a, b) => a + b, 0) / landings.length) : null, p50: round1(quantile(landings, 0.5)), p90: round1(quantile(landings, 0.9)) },
    throughputPerMin: wallMs > 0 ? round1((60000 * merged.length) / wallMs) : null,
    wallMs: Math.round(wallMs),
  };
}

/**
 * G1 as written in the note (section 13) before any grid result: `rates` are the rejection per submission (percent) of
 * the repositories at the reference scenario. The median (the mean of the two middle values for an even number) is read
 * against the thresholds: 20% or more -> 'proceed'; from 10% (included) to 20% -> 'cheap-levers'; under 10% -> 'stop',
 * unless at least 3 repositories are at 20% or more, which keeps the project open on the middle branch.
 */
export function g1Decision(rates) {
  if (rates.length === 0) throw new Error('G1 needs at least one repository');
  const s = [...rates].sort((a, b) => a - b);
  const mid = s.length >> 1;
  const median = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  const atLeast20 = rates.filter((r) => r >= 20).length;
  let branch;
  let reason;
  if (median >= 20) {
    branch = 'proceed';
    reason = `median ${median}% is 20% or more`;
  } else if (median >= 10) {
    branch = 'cheap-levers';
    reason = `median ${median}% is from 10% to under 20%`;
  } else if (atLeast20 >= 3) {
    branch = 'cheap-levers';
    reason = `median ${median}% is under 10%, but ${atLeast20} repositories are at 20% or more: the project stays open`;
  } else {
    branch = 'stop';
    reason = `median ${median}% is under 10% and only ${atLeast20} repositories are at 20% or more`;
  }
  return { median, repositories: rates.length, atLeast20, branch, reason };
}

// ─── Phase 2: the times of the simulation, measured (formulas fixed in the note, section 13, before the measurement) ───

const Z90 = 1.2815515655446004; // the 90th percentile of the standard normal distribution

/** The median of numbers (null for none). */
export const median = (xs) => quantile(xs, 0.5);

/**
 * The coefficient of variation of the lognormal distribution with the given median and 90th percentile:
 * sigma = ln(p90 / p50) / z90 and cv = sqrt(exp(sigma^2) - 1). 0 when the 90th percentile does not exceed the median.
 */
export function lognormalCv(p50, p90) {
  if (!(p50 > 0) || !(p90 > p50)) return 0;
  const sigma = Math.log(p90 / p50) / Z90;
  return Math.sqrt(Math.exp(sigma * sigma) - 1);
}

/** When a patch is queued: the second smallest of the successful review latencies (two families have attested). null with fewer than two. */
export function quorumLatency(latencies) {
  const ok = latencies.filter((x) => typeof x === 'number' && x >= 0).sort((a, b) => a - b);
  return ok.length >= 2 ? ok[1] : null;
}

/**
 * The work, review and rebase times of the queue simulation, as fixed in the note:
 *   workMs   = the median time the agent took for a task (taskMs.p50), workCv from the lognormal fit of its median and 90th percentile
 *   rebaseMs = the median latency of the agent's edit call (a rebase is the same single-shot edit)
 *   reviewMs = the median over sampled patches of the quorum latency of the three reviewer families
 * `quorumMs` needs at least `minReviewSamples` patches.
 */
export function buildPhase2Times({ taskMs, editMs, quorumMs, minReviewSamples = 5 }) {
  if (!taskMs || !(taskMs.p50 > 0)) throw new Error('taskMs.p50 is needed: run the agent pilot first');
  if (!editMs || editMs.length === 0) throw new Error('no edit call latency: the pilot recorded no call times');
  if (!quorumMs || quorumMs.length < minReviewSamples) throw new Error(`the reviewer latency needs at least ${minReviewSamples} patches, got ${quorumMs?.length ?? 0}`);
  return {
    workMs: Math.round(taskMs.p50),
    workCv: Math.round(lognormalCv(taskMs.p50, taskMs.p90) * 100) / 100,
    reviewMs: Math.round(median(quorumMs)),
    rebaseMs: Math.round(median(editMs)),
    derived: { taskP50Ms: Math.round(taskMs.p50), taskP90Ms: Math.round(taskMs.p90), editCalls: editMs.length, reviewSamples: quorumMs.length },
  };
}

/**
 * The files of a `git diff` as the platform presents a change to a reviewer: [{path, status, added: [], removed: [], binary,
 * hunks}] with status 'added', 'deleted' or 'modified' and `hunks` the text from the first @@ line on.
 */
export function changesFromDiff(diff) {
  const out = [];
  for (const block of diff.split(/^diff --git /m).slice(1)) {
    const head = /^a\/(.+?) b\/(.+)\n/.exec(block);
    if (!head) continue;
    const at = block.search(/^@@ /m);
    out.push({
      path: head[2],
      status: /^new file mode/m.test(block) ? 'added' : /^deleted file mode/m.test(block) ? 'deleted' : 'modified',
      added: [],
      removed: [],
      binary: /^Binary files /m.test(block) || /^GIT binary patch/m.test(block),
      ...(at >= 0 ? { hunks: block.slice(at).trimEnd() } : {}),
    });
  }
  return out;
}

/** The body of a review call for each model style, as agents/src/index.ts `ask` builds it. */
export function reviewInput(style, system, schema, text) {
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: text },
  ];
  if (style === 'responses') return { input: messages, reasoning: { effort: 'low' } };
  if (style === 'messages-guided') return { messages, guided_json: schema, max_tokens: 400, temperature: 0.1 };
  return { messages, response_format: { type: 'json_schema', json_schema: schema }, max_tokens: 400, temperature: 0.1 };
}
