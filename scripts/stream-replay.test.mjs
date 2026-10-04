// node --test scripts/stream-replay.test.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const SCRIPT = path.join(path.dirname(new URL(import.meta.url).pathname), 'stream-replay.mjs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'stream-test-'));

test('stream-replay reads the commits of a history in order and reports the rates per window and per variant', () => {
  const dir = tmp();
  const g = (...x) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...x], { encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  let n = 0;
  // each commit touches the listed files: a.txt, a.txt, b.txt, a.txt+b.txt, package.json (hot), package.json
  for (const files of [['a.txt'], ['a.txt'], ['b.txt'], ['a.txt', 'b.txt'], ['package.json'], ['package.json']]) {
    for (const f of files) fs.writeFileSync(path.join(dir, f), `v${++n}\n`);
    g('add', '-A');
    g('commit', '-q', '-m', `c${n}`);
  }
  const out = path.join(tmp(), 'r.json');
  execFileSync('node', [SCRIPT, '--repo', dir, '--window', '1,2', '--out', out], { encoding: 'utf8' });
  const r = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(Object.values(r.repos)[0].commits, 6);
  // all files, k=1: #1 rejected (a), #2 no, #3 rejected (b), #4 no (package.json vs a,b), #5 rejected (package.json): 3 of 5
  assert.deepEqual([r.total.allFiles['1'].rejected, r.total.allFiles['1'].n, r.total.allFiles['1'].rejectPct], [3, 5, 60]);
  // without hot files package.json is dropped: patches #4 and #5 are empty and not counted; #1 and #3 are rejected: 2 of 3 (#1,#2,#3)
  assert.deepEqual([r.total.withoutHotFiles['1'].rejected, r.total.withoutHotFiles['1'].n], [2, 3]);
  // k=2: #2 (b) vs a,a no; #3 (a,b) vs b,a... #1,#2 → yes; #4 (package.json) vs #2,#3 no; #5 yes (package.json in #4): all files 2 of 4
  assert.deepEqual([r.total.allFiles['2'].rejected, r.total.allFiles['2'].n], [2, 4]);
});

test('stream-replay refuses a window that is not a positive integer', () => {
  assert.throws(() => execFileSync('node', [SCRIPT, '--repo', tmp(), '--window', '0'], { stdio: 'pipe' }), /usage/);
  assert.throws(() => execFileSync('node', [SCRIPT, '--repo', tmp(), '--window', '1.5'], { stdio: 'pipe' }), /usage/);
});
