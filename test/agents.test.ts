import { describe, expect, it } from 'vitest';
import { extractJson, mergeProbability } from '../agents/src/index';

describe('LLM reviewer adapter', () => {
  it('maps verdict + certainty to the probability the platform expects (gpt-oss "reject @95" bug)', () => {
    expect(mergeProbability('approve', 95)).toBe(95);
    expect(mergeProbability('reject', 95)).toBe(5);
    expect(mergeProbability('reject', 50)).toBe(50);
    expect(mergeProbability('approve', 120)).toBe(99);
    expect(mergeProbability('approve', 10)).toBe(50);
    expect(mergeProbability('maybe', 90)).toBeNull();
    expect(mergeProbability('approve', 'x')).toBeNull();
  });
  it('extracts the first JSON object from fenced or chatty model output', () => {
    expect(extractJson('```json\n{"verdict":"approve","certainty":90}\n```')).toEqual({ verdict: 'approve', certainty: 90 });
    expect(extractJson('Sure! {"a":{"b":"}"}} trailing')).toEqual({ a: { b: '}' } });
    expect(extractJson({ verdict: 'reject' })).toEqual({ verdict: 'reject' });
    expect(extractJson('no json here')).toBeNull();
  });
});
