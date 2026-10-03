#!/usr/bin/env node
// Cross-checks src/git/objects.ts against the real git binary. Run: node scripts/verify-git-objects.mjs
// Exits non-zero on the first mismatch.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { composeTree, makeCommit, makeObject, makeTree, writePack } from '../src/git/objects.ts';

const enc = new TextEncoder();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-objects-'));
// Work on a shared clone so no object is ever written into this repository's .git.
const repoRoot = path.join(tmp, 'clone');
const git = (args, opts = {}) => execFileSync('git', args, { encoding: 'utf8', ...opts }).trim();
let failures = 0;
const check = (name, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `\n  got      ${actual}\n  expected ${expected}`}`);
};

try {
  git(['clone', '-q', '--shared', '--no-checkout', new URL('..', import.meta.url).pathname, repoRoot]);
  git(['init', '-q', tmp]);
  const blob = await makeObject('blob', enc.encode('hello\n'));
  check('blob hash', blob.hash, execFileSync('git', ['hash-object', '--stdin'], { input: 'hello\n', encoding: 'utf8' }).trim());
  check('empty tree', (await makeTree([])).hash, '4b825dc642cb6eb9a060e54bf8d69288fbee4904');

  // Write the blob into the scratch repo so mktree can reference it.
  execFileSync('git', ['-C', tmp, 'hash-object', '-w', '--stdin'], { input: 'hello\n' });
  const sub = await makeTree([{ name: 'x.txt', type: 'blob', mode: '100644', hash: blob.hash }]);
  execFileSync('git', ['-C', tmp, 'mktree'], { input: `100644 blob ${blob.hash}\tx.txt\n` });
  // Ordering trap: "a.b" (file), "a" (dir) and "a-b" (file): git compares the dir as "a/".
  const items = [
    { name: 'a.b', type: 'blob', mode: '100644', hash: blob.hash },
    { name: 'a', type: 'tree', mode: '040000', hash: sub.hash },
    { name: 'a-b', type: 'blob', mode: '100755', hash: blob.hash },
    { name: 'Z', type: 'blob', mode: '100644', hash: blob.hash },
  ];
  const tree = await makeTree(items);
  const mktreeInput = `100644 blob ${blob.hash}\ta.b\n040000 tree ${sub.hash}\ta\n100755 blob ${blob.hash}\ta-b\n100644 blob ${blob.hash}\tZ\n`;
  check('tree hash + entry order', tree.hash, execFileSync('git', ['-C', tmp, 'mktree'], { input: mktreeInput, encoding: 'utf8' }).trim());

  const when = { name: 'git-flare', email: 'queue@git-flare.invalid', time: 1790000000 };
  const commit = await makeCommit({ tree: tree.hash, parents: [], author: when, committer: when, message: 'batch merge\n\nGit-Flare-Patch: p0_abc' });
  const env = { ...process.env, GIT_AUTHOR_NAME: when.name, GIT_AUTHOR_EMAIL: when.email, GIT_AUTHOR_DATE: `${when.time} +0000`, GIT_COMMITTER_NAME: when.name, GIT_COMMITTER_EMAIL: when.email, GIT_COMMITTER_DATE: `${when.time} +0000` };
  check('commit hash', commit.hash, execFileSync('git', ['-C', tmp, 'commit-tree', tree.hash], { input: 'batch merge\n\nGit-Flare-Patch: p0_abc\n', encoding: 'utf8', env }).trim());

  // Pack: index it into a fresh repo and read every object back.
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-pack-'));
  git(['init', '-q', fresh]);
  const pack = await writePack([blob, sub, tree, commit]);
  const packPath = path.join(fresh, 'test.pack');
  fs.writeFileSync(packPath, pack);
  execFileSync('git', ['-C', fresh, 'index-pack', packPath], { encoding: 'utf8' });
  const verify = git(['-C', fresh, 'verify-pack', '-v', packPath.replace(/\.pack$/, '.idx')]);
  check('pack verifies (4 objects, no errors)', (verify.match(/^[0-9a-f]{40} (blob|tree|commit) /gm) ?? []).length, 4);
  fs.rmSync(fresh, { recursive: true, force: true });

  // composeTree on this repository's real HEAD tree vs git's own index + write-tree.
  const head = git(['-C', repoRoot, 'rev-parse', 'HEAD^{tree}']);
  const readTree = async (hash) =>
    git(['-C', repoRoot, 'ls-tree', hash])
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [meta, name] = line.split('\t');
        const [mode, type, h] = meta.split(' ');
        return { name, type, mode, hash: h };
      });
  const newBlob = git(['-C', repoRoot, 'hash-object', '-w', '--stdin'], { input: 'export const added = true;\n' });
  const updates = [
    { path: 'src/git/added-by-verify.ts', blob: { hash: newBlob, mode: '100644' } },
    { path: 'brand/new/dir/file.txt', blob: { hash: newBlob, mode: '100644' } },
    { path: 'LICENSE', blob: null },
    { path: 'README.md', blob: { hash: newBlob, mode: '100755' } },
  ];
  const composed = await composeTree(readTree, head, updates);
  const idx = path.join(tmp, 'index');
  const ienv = { ...process.env, GIT_INDEX_FILE: idx };
  execFileSync('git', ['-C', repoRoot, 'read-tree', head], { env: ienv });
  execFileSync('git', ['-C', repoRoot, 'update-index', '--add', '--cacheinfo', `100644,${newBlob},src/git/added-by-verify.ts`], { env: ienv });
  execFileSync('git', ['-C', repoRoot, 'update-index', '--add', '--cacheinfo', `100644,${newBlob},brand/new/dir/file.txt`], { env: ienv });
  execFileSync('git', ['-C', repoRoot, 'update-index', '--force-remove', 'LICENSE'], { env: ienv });
  execFileSync('git', ['-C', repoRoot, 'update-index', '--cacheinfo', `100755,${newBlob},README.md`], { env: ienv });
  check('composeTree == git write-tree on the real repo tree', composed.root, git(['-C', repoRoot, 'write-tree'], { env: ienv }));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
if (failures > 0) process.exit(1);
