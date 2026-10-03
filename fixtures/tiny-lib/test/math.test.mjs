import assert from 'node:assert/strict';
import test from 'node:test';
import { add, mul } from '../src/math.mjs';

test('add', () => assert.equal(add(2, 3), 5));
test('mul', () => assert.equal(mul(4, 5), 20));
