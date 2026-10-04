// node --test scripts/conflict-replay.test.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const SCRIPT = path.join(path.dirname(new URL(import.meta.url).pathname), 'conflict-replay.mjs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'conflict-test-'));
const body = Array.from({ length: 14 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

/** main with two merges: a clean overlap of two 1-commit sides, then a real conflict against a 5-commit side. */
function history() {
  const dir = tmp();
  const g = (...x) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...x], { encoding: 'utf8' });
  const write = (p, c) => fs.writeFileSync(path.join(dir, p), c);
  g('init', '-q', '-b', 'main');
  write('A.txt', body);
  write('B.txt', body);
  g('add', '-A');
  g('commit', '-q', '-m', 'base');
  const branch = (name, commits) => {
    g('checkout', '-q', '-b', name, 'main');
    for (const [p, c] of commits) {
      write(p, c);
      g('commit', '-q', '-am', `${name} ${p}`);
    }
    g('checkout', '-q', 'main');
  };
  // merge 1: a changes the top of A.txt, b the bottom: same file, distant hunks (clean), 1 commit per side
  branch('a', [['A.txt', 'top\n' + body]]);
  branch('b', [['A.txt', body + 'bottom\n']]);
  g('merge', '-q', '--no-ff', '-m', 'ma', 'a');
  g('merge', '-q', '--no-ff', '-m', 'mb', 'b');
  const main1 = g('rev-parse', 'HEAD').trim();
  // merge 2: c and d change the same line of B.txt differently (conflict); d has 5 commits
  const b2 = fs.readFileSync(path.join(dir, 'B.txt'), 'utf8');
  branch('c', [['B.txt', b2.replace('line 3\n', 'CCC\n')]]);
  branch('d', [['B.txt', b2.replace('line 3\n', 'DDD\n')], ['A.txt', 'd1\n' + fs.readFileSync(path.join(dir, 'A.txt'), 'utf8')], ['A.txt', 'd2\n' + fs.readFileSync(path.join(dir, 'A.txt'), 'utf8')], ['A.txt', 'd3\n' + fs.readFileSync(path.join(dir, 'A.txt'), 'utf8')], ['A.txt', 'd4\n' + fs.readFileSync(path.join(dir, 'A.txt'), 'utf8')]]);
  g('merge', '-q', '--no-ff', '-m', 'mc', 'c');
  try {
    g('merge', '-q', '-m', 'md', 'd');
  } catch {
    /* conflict on B.txt */
  }
  write('B.txt', b2.replace('line 3\n', 'CCC\nDDD\n'));
  g('add', '-A');
  g('commit', '-q', '-m', 'resolved');
  return { dir, main1 };
}

test('history mode: verdicts, rejection rates and the split by commits on the longer side', () => {
  const { dir } = history();
  const out = path.join(tmp(), 'r.json');
  execFileSync('node', [SCRIPT, '--repo', dir, '--out', out], { encoding: 'utf8' });
  const r = JSON.parse(fs.readFileSync(out, 'utf8'));
  const t = r.total.all;
  assert.deepEqual([t.pairs, t.overlap, t.overlapClean, t.overlapConflict], [2, 2, 1, 1]);
  assert.equal(t.fileLevelRejectPct, 100);
  assert.equal(t.hunkLevelRejectPct, 50);
  // the commits counted per side include merge commits: the first pair has 2 commits on its longer side (the merge of a, then b)
  assert.deepEqual(r.byDivergence['2-3'], { pairs: 1, overlap: 1, overlapConflict: 0, fileLevelRejectPct: 100, hunkLevelRejectPct: 0 });
  assert.deepEqual(r.byDivergence['4-10'], { pairs: 1, overlap: 1, overlapConflict: 1, fileLevelRejectPct: 100, hunkLevelRejectPct: 100 });
  assert.equal(r.byDivergence['1'].pairs + r.byDivergence['>10'].pairs, 0);
  assert.deepEqual(r.topConflictPaths, [{ file: 'B.txt', pairs: 1 }]);
});

test('manifest mode: every pair of committed tasks from one base, and the human baseline', () => {
  const dir = tmp();
  const g = (...x) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...x], { encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'A.txt'), body);
  fs.writeFileSync(path.join(dir, 'B.txt'), body);
  g('add', '-A');
  g('commit', '-q', '-m', 'base');
  const base = g('rev-parse', 'HEAD').trim();
  const tip = (name, file, change) => {
    g('checkout', '-q', '-b', name, base);
    fs.writeFileSync(path.join(dir, file), change);
    g('commit', '-q', '-am', name);
    return g('rev-parse', 'HEAD').trim();
  };
  const t1 = tip('t1', 'A.txt', 'top\n' + body);
  const t2 = tip('t2', 'A.txt', body + 'bottom\n');
  const t3 = tip('t3', 'B.txt', 'x\n' + body);
  const manifest = path.join(tmp(), 'm.json');
  fs.writeFileSync(manifest, JSON.stringify({ base, tasks: [
    { id: 't1', status: 'committed', sha: t1, humanFiles: ['A.txt', 'CHANGES.rst'] },
    { id: 't2', status: 'committed', sha: t2, humanFiles: ['A.txt', 'CHANGES.rst', 'x.py'] },
    { id: 't3', status: 'committed', sha: t3, humanFiles: ['B.txt', 'CHANGES.rst'] },
    { id: 't4', status: 'no-patch', humanFiles: ['A.txt'] },
  ] }));
  const out = path.join(tmp(), 'r.json');
  execFileSync('node', [SCRIPT, '--repo', dir, '--manifest', manifest, '--out', out], { encoding: 'utf8' });
  const r = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.deepEqual([r.total.all.pairs, r.total.all.overlap, r.total.all.overlapClean, r.total.all.disjoint], [3, 1, 1, 2]); // t1-t2 share A.txt (clean); t3 is disjoint from both
  const h = r.humanBaseline;
  assert.deepEqual([h.allTasks.patches, h.allTasks.pairs, h.allTasks.pairsSharingFile, h.allTasks.pairsSharingFileExcludingHotFiles], [4, 6, 5, 3]); // by hand: t1-t2 (A, CHANGES), t1-t3 (CHANGES), t1-t4 (A), t2-t3 (CHANGES), t2-t4 (A) share a file, t3-t4 do not; without CHANGES.rst only the three that share A.txt
  assert.deepEqual([h.sameTasksAsCommittedAgentPatches.patches, h.sameTasksAsCommittedAgentPatches.pairs, h.sameTasksAsCommittedAgentPatches.pairsSharingFile, h.sameTasksAsCommittedAgentPatches.pairsSharingFileExcludingHotFiles], [3, 3, 3, 1]);
});
