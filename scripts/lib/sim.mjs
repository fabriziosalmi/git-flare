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
