import type { FileChange } from './epistemic/changeset.js';
import type { Evaluation, GateResult } from './epistemic/policy.js';

export type TaskStatus = 'available' | 'claimed' | 'submitted' | 'merged';
export type PatchStatus = 'evaluating' | 'queued' | 'merged' | 'rejected' | 'duplicate' | 'stale' | 'expired';
export const TERMINAL_PATCH: ReadonlySet<PatchStatus> = new Set(['merged', 'rejected', 'duplicate', 'stale', 'expired']);

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  leaseEpoch: number;
  holder?: string;
  leaseExpiresAt?: number;
  /** True while the claim's workspace credentials are being minted (external I/O in flight). */
  provisioning?: boolean;
  /** Internal operation in flight on this lease (e.g. submit computing the diff). */
  op?: 'submitting';
  baseCommit?: string;
  branch?: string;
  forkName?: string;
  patchId?: string;
  mergedCommit?: string;
  mergedAt?: number;
}

export interface Review {
  reviewerId: string;
  family: string;
  confidencePercent: number;
  reasoning: string;
  at: number;
}

export interface PatchFile {
  path: string;
  status: FileChange['status'];
  binary: boolean;
  added: number;
  removed: number;
  blob?: FileChange['blob'];
}

export const summarizeChanges = (changes: readonly FileChange[]): PatchFile[] =>
  changes.map((c) => ({ path: c.path, status: c.status, binary: c.binary, added: c.added.length, removed: c.removed.length, ...(c.blob ? { blob: c.blob } : {}) }));

export interface Patch {
  patchId: string;
  taskId: string;
  author: string;
  authorFamily: string;
  fork: string;
  commitSha: string;
  baseCommit: string;
  leaseEpoch: number;
  submittedAt: number;
  status: PatchStatus;
  /** Per-file summary kept in memory; the full change (lines) is stored under `pchg:<patchId>` only. */
  files: PatchFile[];
  gates: GateResult[];
  simHash: string;
  /** sha256 of the canonical change: equal means the same change (whitespace and line order aside) */
  canonicalHash?: string;
  duplicateOf?: string;
  /** SimHash within the calibrated threshold of a patch rejected on the same task, but not the same change */
  nearDuplicateOf?: { patchId: string; distance: number };
  similar: Array<{ patchId: string; taskId: string; distance: number }>;
  reviews: Review[];
  evaluation?: Evaluation;
  mergeError?: string;
  mergedCommit?: string;
  mergedVia?: 'fast-forward' | 'batch';
  mergedBatchSize?: number;
  closedAt?: number;
  /** the patch's branch (task/<taskId>/<leaseEpoch>) was deleted from the author's fork after it closed */
  branchDeleted?: boolean;
}

export interface RepoStats {
  claims: number;
  claimRaceLosses: number;
  provisioningFailures: number;
  leasesReclaimed: number;
  submits: number;
  gateRejections: number;
  duplicates: number;
  reviews: number;
  sybilDiscountedReviews: number;
  collusionExcludedReviews: number;
  reviewRejections: number;
  merges: number;
  staleMerges: number;
  reviewTimeouts: number;
  testRejections: number;
  branchesDeleted: number;
}

export const EMPTY_STATS: RepoStats = Object.freeze({
  claims: 0,
  claimRaceLosses: 0,
  provisioningFailures: 0,
  leasesReclaimed: 0,
  submits: 0,
  gateRejections: 0,
  duplicates: 0,
  reviews: 0,
  sybilDiscountedReviews: 0,
  collusionExcludedReviews: 0,
  reviewRejections: 0,
  merges: 0,
  staleMerges: 0,
  reviewTimeouts: 0,
  testRejections: 0,
  branchesDeleted: 0,
});

/** Result envelope shared by the coordinator and the HTTP layer. */
export type Result<T> = ({ ok: true } & T) | { ok: false; status: number; error: string; detail?: string };

export function fail(status: number, error: string, detail?: string): { ok: false; status: number; error: string; detail?: string } {
  return detail === undefined ? { ok: false, status, error } : { ok: false, status, error, detail };
}
