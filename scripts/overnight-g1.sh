#!/usr/bin/env bash
# The overnight run of phase 2 and G1 (docs/spikes/hunk-merge-2026-10-04.md section 13), in the order the note fixes:
#
#   0. wait for the daily Workers AI allowance to reset (00:00 UTC), so the 10,000 free neurons are all there
#   1. the agent pilot on honojs/hono (agent-replay, Workers AI)          → work and rebase times
#   2. the reviewer latency on the patches of that pilot                   → review time
#   3. the phase-2 times file, COMMITTED AND PUSHED to a results branch BEFORE any G1 cell runs
#   4. G1: the reference cell for each of the eight repositories (queue-sim-g1.mjs, scale 0.25)
#   5. the decision, written next to the results; the G1 results are committed to the results branch locally and NOT pushed
#
# Run it detached (it can take a couple of hours) and keep the machine awake and on power:
#   WORK=/private/tmp/git-flare-night START_UTC=202610060005 nohup caffeinate -i scripts/overnight-g1.sh > night.log 2>&1 &
# DRY=1 prints what it would do without doing it. A failed step stops the run and says which one; what was produced stays.
set -euo pipefail

REPO=${REPO:-$(cd "$(dirname "$0")/.." && pwd)}      # a checkout with node_modules and .dev.vars.dev: the local server runs from it
WORK=${WORK:?set WORK to a directory for the run (clones, results, a copy of the code)}
START_UTC=${START_UTC:?set START_UTC as YYYYMMDDHHMM (UTC): the run starts once the clock reaches it}
DRY=${DRY:-0}
PILOT_CAP=${PILOT_CAP:-8000}       # neurons the pilot may use today
REVIEW_CAP=${REVIEW_CAP:-9800}     # neurons the day may reach with the reviewer calls on top
DAY=$(date -u -j -f %Y%m%d%H%M "$START_UTC" +%Y-%m-%d 2>/dev/null || date -u -d "${START_UTC:0:8} ${START_UTC:8:2}:${START_UTC:10:2}" +%Y-%m-%d)

cd "$REPO"                   # npx finds the local wrangler from here (scripts/cf-api.mjs asks it for the login token)
CODE=$WORK/code              # a worktree of the commit that holds the scripts: the code does not move under the run
RES=$WORK/results
LOG=$RES/night.log
mkdir -p "$RES"

say() { echo "[$(date -u +%H:%M:%SZ)] $*" | tee -a "$LOG"; }
run() { say "+ $*"; if [ "$DRY" = 1 ]; then return 0; fi; "$@"; }
step() { say "=== $1"; }
fail() { say "FAILED: $1"; echo "FAILED: $1" > "$RES/STATUS"; exit 1; }

step "0. wait for $START_UTC UTC"
if [ "$DRY" != 1 ]; then
  while [ "$(date -u +%Y%m%d%H%M)" -lt "$START_UTC" ]; do sleep 30; done
fi
say "started; neurons spent today (UTC) before the run:"
run node --input-type=module -e "import {ledgerRead} from '$CODE/scripts/lib/replay.mjs'; console.log(Math.round(ledgerRead().spent))"

step "1. agent pilot on honojs/hono"
run node "$CODE/scripts/agent-replay.mjs" run --repo "$WORK/hono" --tasks "$WORK/tasks-hono.json" --agent llm --run-id hono-pilot --max-neurons "$PILOT_CAP" --out "$RES/pilot-hono.manifest.json" || fail "agent pilot"

step "2. reviewer latency"
run node "$CODE/scripts/review-latency.mjs" --repo "$WORK/hono" --manifest "$RES/pilot-hono.manifest.json" --tasks "$WORK/tasks-hono.json" --max-patches 8 --max-neurons "$REVIEW_CAP" --out "$RES/review-latency.json" || fail "reviewer latency"

step "3. the phase-2 times, committed and pushed before G1"
run node "$CODE/scripts/phase2-times.mjs" --pilot "$RES/pilot-hono.manifest.json" --reviews "$RES/review-latency.json" --out "$RES/phase2-times.json" || fail "phase-2 times (too few committed tasks or reviewed patches?)"
BRANCH=results/phase2-times-$DAY
OUTDIR=benchmarks/results/$DAY/phase2
if [ "$DRY" != 1 ]; then
  git -C "$REPO" worktree prune
  rm -rf "$WORK/results-wt"
  git -C "$REPO" fetch -q origin main
  git -C "$REPO" worktree add -q -B "$BRANCH" "$WORK/results-wt" origin/main
  mkdir -p "$WORK/results-wt/$OUTDIR"
  cp "$RES/phase2-times.json" "$RES/pilot-hono.manifest.json" "$RES/review-latency.json" "$WORK/results-wt/$OUTDIR/"
  git -C "$WORK/results-wt" add "$OUTDIR"
  git -C "$WORK/results-wt" commit -q -m "Phase-2 times, measured: agent pilot on hono and reviewer latency, before G1 runs

The work, review and rebase times of the queue simulation by the formulas fixed in the note (section 13): the median
task time of the Workers AI agent on honojs/hono, the median latency of its edit call, and the median quorum latency of
the three reviewer families. Committed and pushed before any G1 cell is run; scripts/overnight-g1.sh.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>" || fail "commit of the times"
  git -C "$WORK/results-wt" push -q -u origin "$BRANCH" || fail "push of the times (the order 'times first, then G1' could not be recorded)"
  say "times pushed to $BRANCH: $(git -C "$WORK/results-wt" rev-parse --short HEAD)"
else
  say "+ (dry) commit and push $OUTDIR to $BRANCH"
fi

step "4. G1: the reference cell for the eight repositories"
# the local server runs from the code snapshot (node_modules shared with the checkout, the dev keys copied), so the checkout stays free
if [ "$DRY" != 1 ]; then
  ln -sfn "$REPO/node_modules" "$CODE/node_modules"
  cp "$REPO/.dev.vars.dev" "$CODE/.dev.vars.dev"
fi
ADMIN_KEY=$(grep '^ADMIN_KEY=' "$REPO/.dev.vars.dev" | cut -d= -f2-)
export GF_ADMIN_KEY=$ADMIN_KEY
if [ "$DRY" != 1 ]; then
  pkill -f wrangler 2>/dev/null || true; pkill -f workerd 2>/dev/null || true; sleep 2
  (cd "$CODE" && nohup npm run dev > "$RES/wrangler-dev.log" 2>&1 &)
  for i in $(seq 1 60); do curl -sf -m 2 http://localhost:8787/api/health > /dev/null && break; sleep 2; done
  curl -sf -m 3 http://localhost:8787/api/health > /dev/null || fail "the local server did not start"
fi
run node "$CODE/scripts/queue-sim-g1.mjs" --times "$RES/phase2-times.json" --footprints-dir "$CODE/benchmarks/results/2026-10-05/footprints" --out-dir "$RES/g1" --scale 0.25 --reps 3 --parallel 3 || fail "G1"
if [ "$DRY" != 1 ]; then pkill -f wrangler 2>/dev/null || true; pkill -f workerd 2>/dev/null || true; fi

step "5. the decision (results stay local)"
if [ "$DRY" != 1 ]; then
  node -e "const r=require('$RES/g1/g1.json'); console.log(JSON.stringify(r.decision,null,2)); console.log(r.perRepo.map(x=>x.repo+' '+x.rejectionPerSubmissionPct+'% (first attempts '+x.firstAttemptRejectionPct+'%)').join('\n'))" | tee -a "$LOG" > "$RES/DECISION.txt"
  mkdir -p "$WORK/results-wt/benchmarks/results/$DAY/g1"
  cp -R "$RES/g1/." "$WORK/results-wt/benchmarks/results/$DAY/g1/"
  git -C "$WORK/results-wt" add "benchmarks/results/$DAY/g1"
  git -C "$WORK/results-wt" commit -q -m "G1 results: the reference cell for eight repositories (local, not pushed)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>" || fail "commit of the G1 results"
  say "G1 results committed locally on $BRANCH (not pushed)"
fi
echo "DONE" > "$RES/STATUS"
say "done"
