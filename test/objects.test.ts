// Git object encoding inside workerd. Expected hashes were produced by the real git binary
// (hash-object / mktree / commit-tree); scripts/verify-git-objects.mjs re-checks against git directly.
import { describe, expect, it } from 'vitest';
import { changedPaths, pathsOverlap } from '../src/git/diff';
import { composeTree, makeCommit, makeObject, makeTree, writePack, type TreeItem } from '../src/git/objects';
import { MockArtifacts } from '../src/artifacts/client';

const enc = new TextEncoder();
const BLOB = 'ce013625030ba8dba906f756967f9e9ca394464a';

describe('git objects', () => {
  it('blob, empty tree, entry ordering trap, commit match git byte for byte', async () => {
    expect((await makeObject('blob', enc.encode('hello\n'))).hash).toBe(BLOB);
    expect((await makeTree([])).hash).toBe('4b825dc642cb6eb9a060e54bf8d69288fbee4904');
    const sub = await makeTree([{ name: 'x.txt', type: 'blob', mode: '100644', hash: BLOB }]);
    expect(sub.hash).toBe('9fa6a6d71d42445400aef1e5fda85a9cd64eb517');
    const trap = await makeTree([
      { name: 'a.b', type: 'blob', mode: '100644', hash: BLOB },
      { name: 'a', type: 'tree', mode: '040000', hash: sub.hash },
      { name: 'a-b', type: 'blob', mode: '100755', hash: BLOB },
      { name: 'Z', type: 'blob', mode: '100644', hash: BLOB },
    ]);
    expect(trap.hash).toBe('74a26f474d9758945372552f335e4f6d1c315c83');
    const who = { name: 'q', email: 'q@x', time: 1790000000 };
    expect((await makeCommit({ tree: trap.hash, parents: [], author: who, committer: who, message: 'm' })).hash).toBe('b23f468abe4a3907e527e42741fc35d863597c43');
  });

  it('rejects invalid entries', async () => {
    await expect(makeTree([{ name: 'a/b', type: 'blob', mode: '100644', hash: BLOB }])).rejects.toThrow();
    await expect(makeTree([{ name: 'x', type: 'blob', mode: '100644', hash: BLOB }, { name: 'x', type: 'blob', mode: '100644', hash: BLOB }])).rejects.toThrow();
    await expect(makeTree([{ name: 'x', type: 'blob', mode: '100600', hash: BLOB }])).rejects.toThrow();
  });

  it('pack: header, object count, valid SHA-1 trailer', async () => {
    const blob = await makeObject('blob', enc.encode('hello\n'));
    const tree = await makeTree([{ name: 'h', type: 'blob', mode: '100644', hash: blob.hash }]);
    const pack = await writePack([blob, tree]);
    expect(new TextDecoder().decode(pack.subarray(0, 4))).toBe('PACK');
    const view = new DataView(pack.buffer, pack.byteOffset);
    expect(view.getUint32(4)).toBe(2);
    expect(view.getUint32(8)).toBe(2);
    const sum = new Uint8Array(await crypto.subtle.digest('SHA-1', pack.subarray(0, pack.length - 20)));
    expect([...sum]).toEqual([...pack.subarray(pack.length - 20)]);
  });

  it('composeTree: add in new dirs, modify, delete with pruning, only touched dirs rewritten', async () => {
    const store = new Map<string, TreeItem[]>();
    const put = async (items: TreeItem[]) => {
      const t = await makeTree(items);
      store.set(t.hash, items);
      return t.hash;
    };
    const lonely = await put([{ name: 'only.txt', type: 'blob', mode: '100644', hash: BLOB }]);
    const untouched = await put([{ name: 'keep.txt', type: 'blob', mode: '100644', hash: BLOB }]);
    const root = await put([
      { name: 'lonely', type: 'tree', mode: '40000', hash: lonely },
      { name: 'untouched', type: 'tree', mode: '40000', hash: untouched },
      { name: 'README.md', type: 'blob', mode: '100644', hash: BLOB },
    ]);
    const newBlob = (await makeObject('blob', enc.encode('new\n'))).hash;
    const out = await composeTree(async (h) => store.get(h) ?? null, root, [
      { path: 'lonely/only.txt', blob: null },
      { path: 'deep/er/file.ts', blob: { hash: newBlob, mode: '100644' } },
      { path: 'README.md', blob: { hash: newBlob, mode: '100755' } },
    ]);
    const expected = await makeTree([
      { name: 'README.md', type: 'blob', mode: '100755', hash: newBlob },
      { name: 'deep', type: 'tree', mode: '40000', hash: (await makeTree([{ name: 'er', type: 'tree', mode: '40000', hash: (await makeTree([{ name: 'file.ts', type: 'blob', mode: '100644', hash: newBlob }])).hash }])).hash },
      { name: 'untouched', type: 'tree', mode: '40000', hash: untouched },
    ]);
    expect(out.root).toBe(expected.hash);
    expect(out.objects.map((o) => o.hash)).not.toContain(untouched);
    await expect(composeTree(async (h) => store.get(h) ?? null, root, [{ path: 'README.md/x', blob: { hash: newBlob, mode: '100644' } }])).rejects.toThrow(/path conflict/);
  });
});

describe('conflict detection helpers', () => {
  it('pathsOverlap: same file and file/directory clashes', () => {
    expect(pathsOverlap(['a/b.ts'], new Set(['a/b.ts']))).toBe('a/b.ts');
    expect(pathsOverlap(['a/b.ts'], new Set(['a']))).toBe('a/b.ts');
    expect(pathsOverlap(['a'], new Set(['a/b.ts']))).toBe('a');
    expect(pathsOverlap(['a/b.ts'], new Set(['a/c.ts', 'ab/b.ts']))).toBeNull();
  });
  it('changedPaths lists files changed between two commits, reading trees only', async () => {
    const m = new MockArtifacts();
    await m.ensureRepo('r');
    const a = await m.commit('r', 'main', { 'x/one.ts': '1', 'x/two.ts': '2', 'top.md': 't' }, 'a');
    const b = await m.commit('r', 'main', { 'x/two.ts': '22', 'y/new.ts': 'n', 'top.md': null }, 'b');
    expect([...(await changedPaths(m.reader('r'), a, b))].sort()).toEqual(['top.md', 'x/two.ts', 'y/new.ts']);
    expect((await changedPaths(m.reader('r'), a, a)).size).toBe(0);
  });
});
