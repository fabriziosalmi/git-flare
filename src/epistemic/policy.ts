// Review aggregation and merge/reject policy. Pure, deterministic, integer-only.
//
// Rules (docs/SPEC.md §5):
//   - every confidence p in 1..99 maps to MLO[p] = round(1000 * ln(p / (100 - p)));
//   - reviews are grouped by model family (missing family = shared "unknown" cell); inside a family
//     the strongest review counts 100%, the next discountBps/10000, then squared, and so on;
//   - a failed platform gate rejects immediately; with no gate results the patch can never merge;
//   - MERGE needs >= minApprovals approvals from >= minFamilies distinct families AND aggregate >= +T;
//   - REJECT by reviewers is symmetric: >= minApprovals objections from >= minFamilies families AND <= -T.
import { MLO } from './logodds-table.js';

export interface PolicyReview {
  reviewerId: string;
  family: string;
  confidencePercent: number;
}

export interface GateResult {
  gate: string;
  passed: boolean;
  detail: string;
}

export interface PolicyConfig {
  thresholdPercent: number;
  minApprovals: number;
  minFamilies: number;
  discountBps: number;
}

export const DEFAULT_POLICY: PolicyConfig = Object.freeze({
  thresholdPercent: 95,
  minApprovals: 2,
  minFamilies: 2,
  discountBps: 5000,
});

export interface BreakdownItem {
  reviewerId: string;
  family: string;
  rawLogOdds: number;
  weightBps: number;
  effectiveLogOdds: number;
}

export interface Evaluation {
  decision: 'merge' | 'reject' | 'pending';
  reasons: string[];
  logOdds: number;
  thresholdLogOdds: number;
  approvals: number;
  approvingFamilies: number;
  objections: number;
  objectingFamilies: number;
  discountedReviews: number;
  excluded: Array<{ reviewerId: string; reason: string }>;
  failedGates: string[];
  breakdown: BreakdownItem[];
}

const MAX_DISCOUNT_DEPTH = 30;

export function normalizeFamily(family: unknown): string {
  if (typeof family !== 'string') return 'unknown';
  const f = family.trim().toLowerCase().replace(/\s+/g, ' ');
  return f.length === 0 ? 'unknown' : f;
}

export function milliLogOdds(percent: number): number {
  if (!Number.isInteger(percent) || percent < 1 || percent > 99) {
    throw new RangeError(`confidencePercent must be an integer in 1..99, got ${percent}`);
  }
  return MLO[percent];
}

export function weightBps(rank: number, discountBps: number): number {
  let w = 10000;
  for (let i = 0; i < Math.min(rank, MAX_DISCOUNT_DEPTH); i++) w = Math.floor((w * discountBps) / 10000);
  return w;
}

export function evaluate(
  reviews: readonly PolicyReview[],
  gates: readonly GateResult[],
  excludedReviewers: ReadonlySet<string> = new Set(),
  config: PolicyConfig = DEFAULT_POLICY
): Evaluation {
  const T = milliLogOdds(config.thresholdPercent);
  const reasons: string[] = [];
  const excluded: Evaluation['excluded'] = [];
  const failedGates = gates.filter((g) => !g.passed).map((g) => g.gate);

  const counted: PolicyReview[] = [];
  for (const r of reviews) {
    if (excludedReviewers.has(r.reviewerId)) excluded.push({ reviewerId: r.reviewerId, reason: 'COLLUSION_CLUSTER_WITH_AUTHOR' });
    else counted.push({ ...r, family: normalizeFamily(r.family) });
  }

  // Group by family, rank by |log-odds| desc then reviewerId asc (deterministic), discount geometrically.
  const byFamily = new Map<string, PolicyReview[]>();
  for (const r of counted) {
    const g = byFamily.get(r.family) ?? [];
    g.push(r);
    byFamily.set(r.family, g);
  }
  const breakdown: BreakdownItem[] = [];
  let total = 0;
  let discountedReviews = 0;
  for (const family of [...byFamily.keys()].sort()) {
    const group = byFamily.get(family)!.slice().sort((a, b) => {
      const d = Math.abs(milliLogOdds(b.confidencePercent)) - Math.abs(milliLogOdds(a.confidencePercent));
      return d !== 0 ? d : a.reviewerId < b.reviewerId ? -1 : a.reviewerId > b.reviewerId ? 1 : 0;
    });
    group.forEach((r, rank) => {
      const raw = milliLogOdds(r.confidencePercent);
      const w = weightBps(rank, config.discountBps);
      const eff = Math.trunc((raw * w) / 10000);
      if (rank > 0) discountedReviews++;
      total += eff;
      breakdown.push({ reviewerId: r.reviewerId, family, rawLogOdds: raw, weightBps: w, effectiveLogOdds: eff });
    });
  }

  const approvalsList = counted.filter((r) => r.confidencePercent > 50);
  const objectionsList = counted.filter((r) => r.confidencePercent < 50);
  const approvingFamilies = new Set(approvalsList.map((r) => r.family)).size;
  const objectingFamilies = new Set(objectionsList.map((r) => r.family)).size;

  let decision: Evaluation['decision'] = 'pending';
  if (failedGates.length > 0) {
    decision = 'reject';
    reasons.push(`GATE_FAILED:${failedGates.join(',')}`);
  } else if (gates.length === 0) {
    reasons.push('GATES_NOT_RUN');
  } else if (approvalsList.length >= config.minApprovals && approvingFamilies >= config.minFamilies && total >= T) {
    decision = 'merge';
    reasons.push('QUORUM_AND_THRESHOLD_MET');
  } else if (objectionsList.length >= config.minApprovals && objectingFamilies >= config.minFamilies && total <= -T) {
    decision = 'reject';
    reasons.push('REVIEW_QUORUM_REJECTED');
  } else {
    if (approvalsList.length < config.minApprovals) reasons.push(`NEED_${config.minApprovals}_APPROVALS`);
    if (approvingFamilies < config.minFamilies) reasons.push(`NEED_${config.minFamilies}_FAMILIES`);
    if (total < T) reasons.push('BELOW_THRESHOLD');
  }

  return {
    decision,
    reasons,
    logOdds: total,
    thresholdLogOdds: T,
    approvals: approvalsList.length,
    approvingFamilies,
    objections: objectionsList.length,
    objectingFamilies,
    discountedReviews,
    excluded,
    failedGates,
    breakdown,
  };
}
