# Each fix of the pre-publication review, re-introduced on purpose: the named test file must fail.
# Run from anywhere: python3 benchmarks/results/2026-10-03/mutations.py (restores every file it touches).
import subprocess, sys, shutil
import os
R=os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..') + '/'
M=[
 ('diff uses the multiset diff', 'src/git/diff.ts', "const { added, removed, hunks, cost } = lineDiff(x.text, y.text, Math.min(2000, editBudget));", "const { added, removed } = (await import('../epistemic/changeset.js')).lineMultisetDiff(x.text, y.text); const hunks = ''; const cost = 0;", 'test/units.test.ts'),
 ('binary-content gate off', 'src/gates.ts', "passed: opaque.length === 0,", "passed: true,", 'test/units.test.ts'),
 ('secret scan ignores binary strings', 'src/gates.ts', "for (const line of [...newLines(f), ...(f.strings ?? [])])", "for (const line of newLines(f))", 'test/units.test.ts'),
 ('no-symlinks gate off', 'src/gates.ts', "passed: links.length === 0,", "passed: true,", 'test/units.test.ts'),
 ('mode-only changes skipped', 'src/git/diff.ts', "a.type === b.type && a.mode === b.mode) continue;", "a.type === b.type) continue;", 'test/units.test.ts'),
 ('moved lines not cancelled in SimHash input', 'src/epistemic/changeset.ts', "      if (c > 0) {\n        removed.set(l, c - 1);\n        continue;\n      }", "      if (false) {\n        removed.set(l, c - 1);\n        continue;\n      }", 'test/units.test.ts'),
 ('body buffered whole', 'src/validation.ts', "    if (size > maxBytes) {\n      await reader!.cancel();\n      throw new ValidationError('body', `exceeds ${maxBytes} bytes`);\n    }", "", 'test/units.test.ts'),
 ('guard ignores rollbacks between rounds', 'src/durable_objects/RepoRegistry.ts', "if (this.inRound || this.guard.alert || this.guard.expectedHead !== expected || !head || head === expected) return false;", "return false;", 'test/coordinator.test.ts'),
 ('fast-forward back', 'src/durable_objects/RepoRegistry.ts', "    // 3. Land: one commit composed from the reviewed blobs on top of the head the tests ran on.\n", "    if (batch.length === 1 && (await (await import('../git/diff.js')).isAncestor(this.artifacts.reader(batch[0].fork), head, batch[0].commitSha))) {\n      const e = batch[0];\n      const res = await this.artifacts.fastForward(repo, e.fork, head, e.commitSha);\n      if (res.ok) {\n        this.landed([e], 'fast-forward', e.commitSha);\n        outcomes.push({ patchId: e.patchId, shard: e.shard, status: 'merged', mergedCommit: e.commitSha, via: 'fast-forward', batchSize: 1, at: Date.now() });\n        done.add(e.patchId);\n      }\n      return this.finishRound(outcomes, done);\n    }\n", 'test/coordinator.test.ts'),
 # second pass
 ('binary gate trusts the extension (no signature check)', 'src/gates.ts', "ext.test(f.path) && sig(f.magic ?? '')", "ext.test(f.path)", 'test/units.test.ts'),
 ('gates scan every reported line, not only new content', 'src/gates.ts', "for (const line of [...newLines(f), ...(f.strings ?? [])])", "for (const line of [...f.added, ...(f.strings ?? [])])", 'test/units.test.ts'),
 ('eval heuristic ignores binary strings', 'src/gates.ts', "const lines = [...(SCRIPT_FILE.test(f.path) ? newLines(f) : []), ...(f.strings ?? [])];", "const lines = [...(SCRIPT_FILE.test(f.path) ? newLines(f) : [])];", 'test/units.test.ts'),
 ('tab not printable in binary strings', 'src/git/diff.ts', "((c >= 0x20 && c < 0x7f) || c === 0x09)", "(c >= 0x20 && c < 0x7f)", 'test/units.test.ts'),
 ('secrets past the display caps not kept', 'src/git/diff.ts', "const m = extra < 1000 ? run.match(re) : null;", "const m = extra < 0 ? run.match(re) : null;", 'test/units.test.ts'),
 ('binary judged on old or new content', 'src/git/diff.ts', "        if (y.binary) {\n          push({ path, status: 'modified', binary: true,", "        if (y.binary || x.binary) {\n          push({ path, status: 'modified', binary: true,", 'test/units.test.ts'),
 ('composeTree applies updates in their order', 'src/git/objects.ts', "for (const u of [...updates.filter((x) => !x.blob), ...updates.filter((x) => x.blob)]) {", "for (const u of updates) {", 'test/units.test.ts'),
 ('an emptied directory cannot become a file', 'src/git/objects.ts', "if (!u.blob || !child || !emptied(child)) throw", "if (true) throw", 'test/units.test.ts'),
 ('changedPaths ignores mode changes', 'src/git/diff.ts', "if (x && y && x.hash === y.hash && x.type === y.type && x.mode === y.mode) continue; // a mode change is a change", "if (x && y && x.hash === y.hash && x.type === y.type) continue;", 'test/units.test.ts'),
 ('no mark for a missing final newline', 'src/epistemic/changeset.ts', "  else lines[lines.length - 1] += NO_EOL;\n", "", 'test/units.test.ts'),
 ('restore revokes only on main', 'src/durable_objects/RepoRegistry.ts', "for (const r of this.watched()) revokedWriteTokens +=", "for (const r of [repo]) revokedWriteTokens +=", 'test/coordinator.test.ts'),
]
import sys as _sys
ONLY = _sys.argv[1:]  # optional: run only the mutations whose name contains one of these words
for name, f, a, b, test in M:
    if ONLY and not any(w in name for w in ONLY):
        continue
    src = open(R+f).read()
    assert src.count(a) == 1, (name, src.count(a))
    shutil.copy(R+f, R + '.mutation.bak')
    open(R+f, 'w').write(src.replace(a, b))
    try:
        r = subprocess.run(['npx', 'vitest', 'run', test], cwd=R, capture_output=True, text=True, timeout=600)
        out = r.stdout + r.stderr
        line = [l for l in out.splitlines() if 'Tests ' in l]
        killed = r.returncode != 0
        print(f"{'KILLED ' if killed else 'SURVIVED'} {name}: {line[-1].strip() if line else out[-200:]}", flush=True)
    finally:
        shutil.copy(R + '.mutation.bak', R+f)
if os.path.exists(R + '.mutation.bak'):
    os.remove(R + '.mutation.bak')
