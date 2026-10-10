# G1 with 60 distinct footprints per repository — 2026-10-10

The like-for-like check that `../sensitivity/README.md` asked for. Same reference cell as G1 (10 agents, tests 30 s, scale 0.25, 3 reps, 6 waves of
60 tasks, times file of phase 2), but the footprints are those of **60 distinct merged pull requests** per repository instead of the 7-12 issue-linked
ones (`../footprints-distinct/`, rule fixed in `scripts/collect-footprints.mjs` before any count: same window, no bots, 1 to 30 files, distinct file sets,
the 60 most recent of up to 300 that `gh` returned; axios, prettier, eslint, vite, svelte and cli hit that 300 cap).

| Repository | G1 (12 footprints, repeated) | distinct60 (no replacement) | per repetition | distinct60-replace |
|---|---|---|---|---|
| axios | 69.9% | 79.5% | 79.9 / 79.8 / 78.8 | |
| click | 87.7% | 66.6% | 67.4 / 66.5 / 65.8 | 65.0% |
| vite | 58.5% | 30.8% | 33.7 / 25.0 / 33.7 | |
| cli | 59.0% | 23.1% | 21.9 / 21.9 / 25.4 | |
| hono | 51.1% | 17.8% | 9.5 / 23.0 / 20.8 | 22.6% |
| svelte | 48.4% | 16.2% | 15.4 / 19.1 / 14.1 | 18.9% |
| prettier | 59.0% | 16.1% | 16.9 / 16.9 / 14.5 | |
| eslint | 68.5% | 8.1% | 6.6 / 8.1 / 9.5 | |
| **median** | **59%** | **20.45%** (4 of 8 repositories >= 20%) | | 22.6% (3 repositories) |

By the preregistered rule 20.45% is "proceed" (>= 20%), but by 0.45 points; the spread between repetitions of one repository is several points
(hono 9.5 to 23%), so this median cannot tell 18% from 23%. Read it as: **about 20%, with no margin.**

What changes the reading of G1:
- The 59% of G1 was mostly the small population: 60 tasks drawn from 7-12 footprints repeat each footprint 5-8 times. With 60 distinct footprints the median
  is about a third of that. Drawing with replacement *from the distinct population* (the control) changes little (click 65.0 vs 66.6, hono 22.6 vs 17.8, svelte 18.9 vs 16.2).
- The distribution is bimodal, not a typical value: axios (79.5%) and click (66.6%) are dominated by files that many pull requests touch; five repositories are between 8% and 23%.
  A rule for those files (issue #14, levers) addresses the two high ones; what is left in the others is the part a hunk-level merge would have to win.
- Pull requests of the whole window touch protected paths often (`.github/workflows/`): `tasksClosedAtSubmit` per condition is 3 to 30 of 180 tasks (cli 30, svelte 15, the others 3-11).
  Those tasks never reach the queue and are outside the rate.
- Not measured here: the same cell without hot files (human-nohot) on this population, which is the direct measure of what a hot-file rule would take out.

Run health: 45,738 requests, p50 11 ms, p99 139 ms, max 992 ms; one cell voided by a "Network connection lost" fault of the local dev server (rule as in `../sensitivity/README.md`), rerun with the same seed.
Local paths were rewritten as repository paths.
