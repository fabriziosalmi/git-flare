# Hunk-level merge: is it worth it? (2026-10-04, revised 2026-10-05)

Status: exploration, nothing implemented. Covers the issues of the milestone *Hunk-level merge (exploration)*:
measurement (#1), design (#2), starvation of patches that keep conflicting (#4). Agent-patch measurement (#3)
needs real agent runs and is not covered.

**Revised 2026-10-05** after a critical review. §1 and §3 said that a conflict makes the agent redo its work;
the SPEC says it re-claims and rebases, and what the code guarantees is a new patch that is reviewed again, so
the cost argument is rewritten and flagged as unmeasured. §2 now splits the rejection rates by how far the two
sides had diverged: the averages were dominated by branches that lived days. §9 adds the quantity that decides
the rejection rate of a queue (landings during a patch's window) and the levers besides a hunk-level merge.

## 1. What the merge queue does today

Conflicts are file-level (SPEC §8, step 3): a patch whose paths intersect the paths changed on main since its
base, or taken by an earlier patch of the same round, becomes `stale` (`CONFLICT`). The task returns to the
pool; the agent claims again (base = main's head now) and rebases (SPEC §8 step 3), then resubmits. The
resubmission is a new patch with `reviews: []` (`RepoCoordinator.ts`), so it goes through review again. Only infrastructure errors count towards `QUEUE.maxAttempts` (3);
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

**The averages hide the regime that matters.** A patch of an agent lives minutes; the branches of these merge
commits lived much longer. Split by the number of commits on the longer side of the pair since the fork (merge
commits included):

| Commits on the longer side | Pairs | File-level rejects | Hunk-level rejects |
|---|---|---|---|
| 1 | 80 | 27.5% | 5.0% |
| 2–3 | 508 | 21.5% | 3.7% |
| 4–10 | 667 | 42.0% | 9.7% |
| more than 10 | 954 | 71.5% | 32.6% |

For short-lived sides the file-level rule still rejects about a fifth to a quarter of the pairs and a hunk-level
rule 4–5%, a gain of about five times; the 49.5% and 18.1% above are driven by the long-lived branches and
should not be quoted for agents. The first row has few pairs and a wide margin.

Limits: human patches, not agent patches; merge commits miss squash/rebase workflows, so conflicts are
under-counted; a clean textual merge can still be semantically wrong.

## 3. What a rejection costs (not measured)

A conflicted patch costs: the agent's rebase (mechanical when the hunks do not overlap, model calls when they
do), a new submission, a new review (reviewers of at least two families, each an LLM call, because the
resubmission is a new patch), and the latency of all of it. Which part dominates has not been measured. A
hunk-level merge by the registry removes all of it for the share of conflicts that are textually clean (most of
them for short-lived sides, §2) and costs milliseconds. How much that is worth depends on the cost above, so
measuring it is a prerequisite (issue #3).

## 4. Starvation (issue #4), by reasoning

The queue behaves like optimistic concurrency control with abort-and-retry, where an abort costs a rebase, a new submission and a new review.
Model (not a measurement): if other patches land on the same path as a Poisson process of rate λ, and a patch
spends W between claim and merge round (work + review + queue), it survives with probability e^(−λW) and needs
e^(λW) attempts on average. With a hot path landing every 10 minutes and W = 20 minutes: about 7 attempts.
Nothing in the current code bounds this, and the same-round rule (the earlier patch wins) gives no priority to
a patch that has already lost. W is the knob: the shorter the window, the better the odds, and a server-side
merge removes the rejection.

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

1. Done: conflict counter per task, exposed in `/status`.
2. Measure what decides the rate of the queue (§9): scripted workers on a staging deployment with footprints
   sampled from real pull requests, varying the number of agents and the duration of the tests, using the counter.
3. Measure the risk of the idea: do textually clean merges of real concurrent work pass the tests?
   (`scripts/semantic-replay.mjs`)
4. Reframe the agent-patch measurement (#3) around footprints (files per patch, share of hot files), because an
   agent's footprint is what decides how often patches meet.
5. Only then a hunk-level merge behind a per-repository flag, with hot-file rules if `package.json`-like files
   dominate; or one of the cheaper levers of §9, depending on what 2 and 3 show.

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

## 8. Pilot on `pallets/click` (2026-10-04): a lower bound, not a measurement

12 real tasks (issues that existed at base `5590ef46e3c8`, closed by a merged PR between 2026-02-01 and
2026-08-01), `llm` agent of §7: file selection with Llama 3.1 8B, edits with Qwen2.5-Coder 32B. Results in
`benchmarks/results/2026-10-04/agent-replay-click/` (`pilot1`, `diag1`; the SHAs are of local branches that are
not in the public repository).

| | |
|---|---|
| Patches produced | 6 of 12 (5,987 neurons, all measured from the API's token usage) |
| Why not | 5 × "search text not found", 1 × a file that does not exist |
| Pairs of the 6 patches that share a file | 0 of 15 (so 0% with either rule) |
| Human PRs for the same 12 tasks | 55 of 66 pairs share a file (23 once changelog, version and dependency files are set aside); median 4 files per PR |
| Human PRs for the 6 tasks the agent finished | 10 of 15 (3 without those files) |

**The 0% says nothing about agents in general.** Every agent patch touches exactly one file, with 1 to 10 lines
changed; patches of one file rarely meet by construction. The agent also does not know the project's convention
of a changelog entry and tests in every change, which the human PRs follow. The collision rate depends on the
patch footprint (how many files, which ones), not only on the merge rule, and this agent's footprint is a floor.

### Why half of the edits fail (`diag1`: the 4 "not found" tasks re-run with the failure recorded)

The re-run is not deterministic (temperature 0.1): it produced 1 patch and 3 failures. The 3 failures:

| Task | Kind | What happened |
|---|---|---|
| #3121 | `whitespace` | the search text equals the file's once whitespace is collapsed: indentation differs |
| #2836 | `absent` | an edit to `src/click/core.py`, a file that was not among the four shown; the search text is invented |
| #2879 | `absent` | an edit to `parser.py` of a class that lives in another file; invented |

So one failure in three is fixable with whitespace-tolerant matching, and two in three are the model editing
code it was not shown, which comes from the file selection: against the source files the human PRs changed, the
8B selector found 4 of 13 (31%), and the right file in 4 of 11 tasks. `core.py`, the hot file, is chosen often
(6 of 12 tasks) but not in the tasks that need it.

### Not done, in order of cost-effectiveness

1. A stronger selector. Its prompt is about 2,000 tokens: with Llama 3.3 70B that is on the order of 50
   neurons per call (rates in `NEURON_RATES`), against 8 for the 8B model.
2. Whitespace-tolerant matching of the search text.
3. One retry that shows the model the real excerpt when a search text is not found, which is what an agent
   with tools gets for free.
4. An agent with tools (reads the repository, runs the tests, iterates), which is what the footprint question
   actually needs; its cost is not known and has to be measured on a few tasks first.

None of these changes the harness's accounting or the measurement script.

## 9. What decides the rate of a queue, and the other levers

A patch is rejected when a file it touches was touched by **any** of the patches that landed after its base
(SPEC §8 step 3), so the pair rates of §2 are not the rate of the queue. Taking the non-merge commits of each
repository as a stream of patches (`scripts/stream-replay.mjs`, `benchmarks/results/2026-10-04/stream-replay.json`;
express, flask, requests, fastify, hono, commander.js, click; 15,843 patches), the file-level rule rejects a patch
by the number k of patches that landed during its window:

| k | 1 | 2 | 4 | 8 | 16 |
|---|---|---|---|---|---|
| All files | 30.7% | 40.5% | 51.2% | 62.3% | 71.7% |
| Without dependency, version and changelog files | 23.2% | 31.5% | 41.0% | 52.5% | 63.8% |

The low end overstates concurrency (consecutive commits of one pull request or one author share files without
being concurrent); the growth with k is what counts. k is roughly (number of agents) × (time from claim to merge
round) / (time to make a patch). The time from claim to merge round includes the wait for the round: rounds are
serial, a round runs the repository's tests on the composed tree, and a failing batch is bisected. A longer test
suite therefore lengthens the window, raises k and the rejection rate with it. The registry's 12 patches/s are
irrelevant until there are thousands of agents; what limits is the duration of tests and reviews, and the
window W has never been measured in git-flare.

Levers besides a hunk-level merge, none measured:
- **Prevention.** Claims do not declare paths. A scheduler could avoid assigning at the same time tasks that
  are likely to touch the same files, which acts directly on k.
- **Review reuse.** If a mechanical rebase leaves the canonical diff identical (the canonical hash exists
  already), the approvals could carry over, which removes the re-review, the part of §3 that is a model call.
  The composed-tree tests stay as the guard.
- **Structured rules for hot files** (§5): `package.json`, changelogs.

## 10. Do textually clean merges pass the tests? (`click`, `jinja`, `markupsafe`, 2026-10-05)

`scripts/semantic-replay.mjs` takes every two-parent merge commit of a repository whose two sides share a path
and merge cleanly with `git merge-tree` (the pairs a file-level rule rejects and a hunk-level rule would accept),
builds the merged tree and runs the repository's tests on it. A control group of pairs with no common path
(accepted by both rules) goes through the same steps. Results, with the repository HEAD, versions and test
command recorded: `benchmarks/results/2026-10-05/semantic-replay-{click,jinja,markupsafe}.json`.

| Repository (history) | Clean-but-overlapping: ok / semantic / preexisting | 95% upper bound | Control: ok / semantic / preexisting |
|---|---|---|---|
| `pallets/click` (whole) | 78 / 0 / 83 | 4.7% | 129 / 0 / 71 |
| `pallets/jinja` (since 2022) | 20 / 0 / 0 | 16.1% | 15 / 0 / 1 |
| `pallets/markupsafe` (since 2022) | 28 / 0 / 0 | 12.1% | 26 / 0 / 0 |
| **Pooled, pairs that could be judged** | **126 judged, 0 semantic** | **3.0%** | **170 judged, 0 semantic** (2.2%) |

`semantic` means both parents pass alone and the merged tree fails twice; `preexisting` means a parent already
fails in this environment (old commits that need old dependencies). The pooled interval treats pairs as
independent. Test command: `PYTHONPATH=src python -m pytest -q -x -p no:cacheprovider -p no:warnings` (with
`tests` added for `jinja` and `markupsafe`; about 4 s per run for `click`), Python 3.12.12, pytest 9.1.1, current
dependencies; each result file records the exact command and versions.

**What it says.** No textually clean merge broke the tests in 126 judged pairs, against a control that did not
either: the semantic-conflict rate of a clean-but-overlapping pair is below about 3% in these repositories
(95%). The cost of being wrong is also bounded by the design: git-flare runs the declared tests on the composed
tree before `main` moves, so a semantic conflict would turn into a rejection after a test run (what a conflict
costs today, plus the run), not into a broken `main`; that is why §5 makes the merge opt-in only for repositories
with declared tests.

**What it does not say.** The three repositories are small Python libraries of the same maintainers and workflow,
with fast suites (`click`: 4 s): it says nothing about large or polyglot code bases, or about repositories whose
tests are slow or thin. Survivorship: a history only holds merges that were accepted, and a semantic conflict
caught by continuous integration before the merge was fixed on the branch, so it does not appear. Tests catch
only what they cover. The merged tree is the one `git merge-tree` produces, not the one the person committed.
Dropping `preexisting` pairs leans the sample towards recent history (for `click`, 83 of 161).

**`flask` was tried and left out.** In one modern environment 1,274 of the 1,275 commits tested failed, for
dependency reasons: the history needs old Werkzeug and Jinja (`Markup` from `jinja2`, `url_quote` from
`werkzeug.urls`) and old pytest internals; with pytest 8 only the latest of ten sampled commits passed. Its
history cannot be judged with one environment. `itsdangerous` did not run in a first sample (0 of 10) and was not
pursued. A fair measurement of such repositories needs an environment per era, which this script does not do.

## 11. Plan to completion and decision gates (fixed 2026-10-05, before the phase-3 data)

The plan is tracked in the milestone *Hunk-level merge (exploration)*. The gates are written **before** the
queue-level data exist so that the decision does not follow the result; they are not to be moved after it.

| Phase | Output | Issue |
|---|---|---|
| 0 | Pending work closed, issues opened | #12–#15 |
| 1 | Workers AI agent v2 (stronger selector, whitespace-tolerant search, one retry with the real excerpt) and a table of **footprints** (files per patch, share of hot files) of human pull requests and agent patches on `pallets/click` and `honojs/hono` | #3 |
| 2 | Cost of a rejection (rebase, re-review, latency) and the distribution of the claim-to-merge window W | #12 |
| 3 | Queue-level simulation on staging: rejection vs number of agents and test duration | #13 |
| **G1** | Is anything worth building? | |
| 4 | Choice of lever, with a decision record | #14 |
| **G2** | Which lever (owner decides) | |
| 5 | Implementation: pure 3-way merge tested differentially against git, registry integration, per-repository opt-in only with declared tests, bench of the round | #2 |
| 6 | A/B on staging, same load as phase 3 with the lever on and off | #13 |
| **G3** | Stay available (opt-in) or withdraw | |
| 7 | Closure: README, final note, issues and milestone closed | |

**G1.** Reference scenario: 10 agents, tests of 30 seconds, footprints from real pull requests. Rejection per patch
with the file-level rule: under 10% → build nothing, close #2, #3 and #4 with the data; from 10% to 20% → cheap
levers only (conflict policy #4, review reuse), no hunk-level merge; 20% or more → go on to phase 4.

**G2.** The lever that removes the most expensive part of a rejection (as measured in phase 2) at the lowest
complexity; more than one lever may be chosen, each as its own pull request.

**G3.** At the reference scenario, lever on against lever off, **all** of: rejection per patch down by at least 40%
relative; **zero** patches that pass the composed-tree tests and still break `main`; round latency up by at most
50%; CI green. If one fails, the lever stays off or is withdrawn. Whatever the outcome it stays opt-in per
repository and only for repositories with declared tests.

Decisions of 2026-10-05: staging may be used for phases 2, 3 and 6 (the cost of each series is estimated from the
price list first, and confirmation is asked above 5 USD); the second repository for footprints is `honojs/hono`;
validation of the semantic risk on a non-Python repository is postponed; nothing public about these findings until
that is decided.
