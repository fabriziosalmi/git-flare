import { describe, expect, it } from 'vitest';
import { MLO } from '../src/epistemic/logodds-table';
import { DEFAULT_POLICY, evaluate, milliLogOdds, normalizeFamily, weightBps, type GateResult, type PolicyReview } from '../src/epistemic/policy';

const PASS: GateResult[] = [{ gate: 'non-empty', passed: true, detail: '' }];
const FAIL: GateResult[] = [...PASS, { gate: 'secret-scan', passed: false, detail: 'aws key' }];
const r = (reviewerId: string, family: string, confidencePercent: number): PolicyReview => ({ reviewerId, family, confidencePercent });

describe('log-odds table', () => {
  it('is exact for every percentage (no buckets: 95 and 99 differ, 1 and 5 differ)', () => {
    for (let p = 1; p <= 99; p++) expect(MLO[p]).toBe(Math.round(1000 * Math.log(p / (100 - p))));
    expect(milliLogOdds(95)).toBe(2944);
    expect(milliLogOdds(99)).toBe(4595);
    expect(milliLogOdds(1)).toBe(-4595);
    expect(milliLogOdds(5)).not.toBe(milliLogOdds(1));
  });
  it('rejects out-of-range or fractional confidence', () => {
    for (const bad of [0, 100, 300, -1, 85.5, NaN]) expect(() => milliLogOdds(bad)).toThrow(RangeError);
  });
});

describe('family normalization', () => {
  it('maps case/whitespace variants to one cell and missing family to "unknown"', () => {
    expect(normalizeFamily(' GPT-4o ')).toBe('gpt-4o');
    expect(normalizeFamily('gpt-4o')).toBe('gpt-4o');
    expect(normalizeFamily(undefined)).toBe('unknown');
    expect(normalizeFamily('')).toBe('unknown');
    expect(normalizeFamily(123)).toBe('unknown');
  });
});

describe('merge policy', () => {
  it('a single review never merges, even at 99%', () => {
    expect(evaluate([r('a', 'claude', 99)], PASS).decision).toBe('pending');
  });

  it('ten reviews without a family share one cell and cannot satisfy the family quorum', () => {
    const reviews = Array.from({ length: 10 }, (_, i) => r(`bot${i}`, 'unknown', 99));
    const e = evaluate(reviews, PASS);
    expect(e.decision).toBe('pending');
    expect(e.approvingFamilies).toBe(1);
    expect(e.discountedReviews).toBe(9);
  });

  it('case variants of one family do not count as distinct families', () => {
    const e = evaluate([r('a', 'gpt-4o', 99), r('b', 'GPT-4o ', 99), r('c', ' Gpt-4O', 99)], PASS);
    expect(e.approvingFamilies).toBe(1);
    expect(e.decision).toBe('pending');
  });

  it('merges with 2 approvals from 2 families above threshold', () => {
    const e = evaluate([r('a', 'claude', 95), r('b', 'gemini', 95)], PASS);
    expect(e.logOdds).toBe(5888);
    expect(e.decision).toBe('merge');
  });

  it('two families at 80% are not enough (2 x 1386 < 2944)', () => {
    expect(evaluate([r('a', 'claude', 80), r('b', 'gemini', 80)], PASS).decision).toBe('pending');
  });

  it('a failed platform gate is a veto regardless of reviews', () => {
    const many = Array.from({ length: 12 }, (_, i) => r(`r${i}`, `fam${i}`, 99));
    const e = evaluate(many, FAIL);
    expect(e.decision).toBe('reject');
    expect(e.failedGates).toEqual(['secret-scan']);
  });

  it('without gate results a patch can never merge', () => {
    expect(evaluate([r('a', 'claude', 99), r('b', 'gemini', 99)], []).reasons).toContain('GATES_NOT_RUN');
  });

  it('one hostile reviewer cannot reject; rejection needs the symmetric quorum', () => {
    expect(evaluate([r('griefer', 'gpt-4o', 1)], PASS).decision).toBe('pending');
    expect(evaluate([r('a', 'gpt-4o', 5), r('b', 'claude', 5)], PASS).decision).toBe('reject');
  });

  it('geometric discount inside a family: 100%, 50%, 25%', () => {
    expect([0, 1, 2, 3].map((k) => weightBps(k, 5000))).toEqual([10000, 5000, 2500, 1250]);
    const e = evaluate([r('a', 'gpt', 90), r('b', 'gpt', 90), r('c', 'gpt', 90)], PASS);
    expect(e.breakdown.map((b) => b.weightBps)).toEqual([10000, 5000, 2500]);
  });

  it('is independent of review order', () => {
    const reviews = [r('a', 'gpt', 70), r('b', 'gpt', 90), r('c', 'claude', 60), r('d', 'claude', 99)];
    const x = evaluate(reviews, PASS);
    const y = evaluate([...reviews].reverse(), PASS);
    expect(y.logOdds).toBe(x.logOdds);
    expect(y.decision).toBe(x.decision);
  });

  it('excluded (collusive) reviewers do not count toward quorum', () => {
    const e = evaluate([r('a', 'claude', 99), r('b', 'gemini', 99)], PASS, new Set(['b']), DEFAULT_POLICY);
    expect(e.decision).toBe('pending');
    expect(e.excluded).toEqual([{ reviewerId: 'b', reason: 'COLLUSION_CLUSTER_WITH_AUTHOR' }]);
  });
});
