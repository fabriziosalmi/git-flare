# Hunk-level merge: is it worth it? (2026-10-04)

Status: exploration, nothing implemented. Covers the issues of the milestone *Hunk-level merge (exploration)*:
measurement (#1), design (#2), starvation of patches that keep conflicting (#4). Agent-patch measurement (#3)
needs real agent runs and is not covered.

## 1. What the merge queue does today

Conflicts are file-level (SPEC §8, step 3): a patch whose paths intersect the paths changed on main since its
base, or taken by an earlier patch of the same round, becomes `stale` (`CONFLICT`). The task returns to the
pool; the agent claims again (base = main's head now), redoes its work on that base, resubmits, and the new
patch goes through review again. Only infrastructure errors count towards `QUEUE.maxAttempts` (3);
`CONFLICT` has no counter, no backoff and no priority for a resubmission
(`src/durable_objects/RepoRegistry.ts`, rounds take the queue in arrival order).

## 2. Measurement (`scripts/conflict-replay.mjs`, `benchmarks/results/2026-10-04/conflict-replay.json`)

Concurrent branches taken from two-parent merge commits (base = merge-base) of seven public repositories:
2,209 pairs with changes on both sides.

| Rule | Pairs rejected |
|---|---|
| File-level (current) | 49.5% |
| Hunk-level (`git merge-tree`) | 18.1% |
| Hunk-level, conflicts confined to dependency/version/changelog files set aside | 12.3% |

63.5% of the pairs that share a path merge cleanly. The conflicts that remain are concentrated: `package.json`
alone is in 138 of the 399 hunk-level conflicts, `History.md` in 75, then changelogs, `__init__.py` version
strings, `AUTHORS`. A first measurement on one author's ten personal repositories gave 40% → 5%; the public
data is the one to trust (many authors), and it shows a smaller gain.

Limits: human patches, not agent patches; merge commits miss squash/rebase workflows, so conflicts are
under-counted; a clean textual merge can still be semantically wrong.

## 3. The argument for hunk-level merging is cost per rejection, not rejection rate

A rejection today costs the agent a full redo plus a new review, in minutes and tokens. A hunk-level merge done
by the registry costs milliseconds and no agent time. So even a modest drop in the rejection rate removes the
expensive part. This is the reason to pursue it, more than the percentages above.

## 4. Starvation (issue #4), by reasoning

The queue behaves like optimistic concurrency control with abort-and-retry, where an abort costs a whole task.
Model (not a measurement): if other patches land on the same path as a Poisson process of rate λ, and a patch
spends W between claim and merge round (work + review + queue), it survives with probability e^(−λW) and needs
e^(λW) attempts on average. With a hot path landing every 10 minutes and W = 20 minutes: about 7 attempts.
Nothing in the current code bounds this, and the same-round rule (the earlier patch wins) gives no priority to
a patch that has already lost. W is the knob: the shorter the window, the better the odds, and a server-side
merge removes the redo entirely.

Consequences:
- Add a conflict counter per task (visible in `/status`) before changing behaviour, so the problem can be seen.
- A resubmission that lost on a path could be queued ahead of new arrivals for that path.
- Past a threshold, stop re-queuing: surface the task for a human or serialize that path.

## 5. Design sketch for an opt-in hunk-level merge

When a patch overlaps `C_main` on a path, instead of marking it `stale`, run a 3-way merge of that path (base
blob from the patch's base commit, main blob, patch blob). Accept if it merges cleanly.

- **Opt-in per repository, and only when the repository declares tests.** The composed-tree test run (§8 step
  3b) is the guard against textually clean but semantically wrong merges. Without tests, keep the file-level rule.
- **Where it runs.** The registry rebuilds trees from blobs, without a working tree, so it needs a diff3 on blobs
  inside the Worker (a small JS implementation; no `git` binary there). The base blob is available because each
  patch carries its base.
- **What stays file-level.** Binary files, mode changes, deletions and file/directory clashes.
- **Same-round interaction.** A path "taken" by an earlier patch of the round must be merged against that
  patch's result, so the merge is sequential within a round: patch k merges on top of the batch so far.
- **Hot files need their own rule.** Hunk-level merging does not fix `package.json` (the biggest source of
  residual conflicts). A structured merge (union of dependency keys, conflict only when the same key gets
  different values) and union merge for append-only changelogs would address most of the rest; each is a
  separate, per-file-type decision.
- **Budget.** Rounds are capped at 32 patches and a 25-patch round took 2.0 s. Re-measure with the merge in the
  path before enabling.
- **Failure mode.** On a failed hunk merge, keep the current behaviour (`stale`, `CONFLICT: <path>`) and add the
  fact that the 3-way merge was tried.

## 6. Suggested order

1. Conflict counter per task, exposed in `/status` (small, makes the problem visible).
2. Agent-patch measurement (#3), to see whether agents are closer to the 49%/18% or to something worse.
3. Hunk-level merge behind a per-repository flag, then hot-file rules if #3 shows `package.json`-like files dominate.

## 7. Harness for the agent-patch measurement (issue #3)

`scripts/agent-replay.mjs` produces patches with coding agents from one base commit, and
`scripts/conflict-replay.mjs --manifest` runs the file-level vs hunk-level comparison on their branches.

```bash
node scripts/agent-replay.mjs tasks --repo <clone> --slug owner/name --since 2026-02-01 --until 2026-08-01 --limit 12 --out tasks.json
node scripts/agent-replay.mjs run   --repo <clone> --tasks tasks.json --out manifest.json   # --agent mock: no network
node scripts/conflict-replay.mjs --repo <clone> --manifest manifest.json --out replay.json
```

- **Tasks** are real issues that existed at the base commit and were closed by a merged pull request in the
  window, whose PR changes code (not only docs). The issue text is the task; the human PR's files are recorded
  for comparison only.
- **Agent** (`llm`): Workers AI through the account REST API. Single-shot, not an agent loop: one call picks up
  to 4 files from the tree and the issue; a file too large for the context (e.g. `src/click/core.py`) is read
  through its outline of definitions and up to 3 line ranges; one call returns search/replace edits. No tool
  use, no tests, no iteration, so its patches are probably smaller and less complete than a full agent's.
  Search/replace edits are used instead of `/code`'s whole-file output (capped at 2,500 tokens) because real
  repositories have files far larger than that.
- **Budget**: every call is counted from the API's token usage, using the per-model neuron rates of the pricing
  page, into a per-UTC-day ledger (`~/.cache/git-flare-neurons.json`) shared by all runs. The run stops before a
  call that could pass `--max-neurons` (default 8,000 of the 10,000 free neurons a day).
- **`mock`** edits one unique line per chosen file, deterministically, and exists to test the plumbing. Its
  numbers measure nothing and must not be reported.
- Not measured here: whether a clean textual merge passes the repository's tests (the risk of hunk-level
  merging). That needs a second step that runs the tests on the composed tree.
- `npm run test:scripts` covers the pair verdict on a temporary repository, edit application, range handling
  and neuron accounting.
