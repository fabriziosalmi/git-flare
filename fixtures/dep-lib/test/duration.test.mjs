import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toMs } from '../src/duration.mjs';

test('toMs', () => {
  assert.equal(toMs('2s'), 2000);
  assert.equal(toMs('1h'), 3_600_000);
});
