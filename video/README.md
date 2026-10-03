# The demo video

Everything in the video is made with this repository's scripts. The narration is Deepgram Aura-2 on Workers AI,
and Whisper (also on Workers AI) transcribes it back to time the captions and catch mispronounced words. The
terminal and dashboard scenes are real runs against the staging deployment, recorded while they happened.
Nothing is edited after recording: footage is only cut, cropped, sped up or held on its last frame.

The finished video and its captions are attached to the GitHub release
[`demo-video`](https://github.com/fabriziosalmi/git-flare/releases/tag/demo-video); the captions are also in
[`git-flare-demo.srt`](git-flare-demo.srt).

| File | What it is |
| --- | --- |
| [`narration.json`](narration.json) | the script: per segment, the narration text and what is on screen |
| [`sessions/`](sessions) | the terminal sessions of the two live scenes (`{repo}` is replaced at recording time) |
| [`scripts/video/`](../scripts/video) | the pipeline (below) |

The recorded run is `benchmarks/results/2026-10-02/demo-gfdemo-980.json`.

## Build

You need Node 22+, Chrome, `ffmpeg` and [`agg`](https://github.com/asciinema/agg), plus a `wrangler login` on
the account (the narration and the repository setup call the Cloudflare API with it).

```bash
B=/tmp/gf-video                                        # build directory
export GF_BASE=https://<git-flare url> GF_AGENTS=https://<gf-agents url>
export GF_ADMIN_KEY=... GF_AGENTS_TOKEN=...             # from your environment, never on screen
R=gfdemo-$RANDOM

# 1. a fresh repository, its two read replicas, and the event subscriptions of the main guard
node scripts/seed-repo.mjs $R
echo '[]' > $B-tasks.json && node cli/gf.mjs admin repo init $R --tasks $B-tasks.json --shards 4 --mirrors 2
node scripts/watch-repo.mjs $R --mirrors 2             # then wait a minute: new subscriptions start late

# 2. the two live scenes: a terminal session and, at the same time, the dashboard in headless Chrome
node scripts/video/record.mjs --name demo  --session video/sessions/demo.txt  --repo $R --out $B/rec --tail 20 --focus R2 --focus-sec 12
node scripts/video/record.mjs --name guard --session video/sessions/guard.txt --repo $R --out $B/rec --tail 15

# 3. title and data cards (numbers read from benchmarks/results/), narration, assembly
node scripts/video/cards.mjs --out $B/cards
node scripts/video/tts.mjs --narration video/narration.json --out $B/audio
node scripts/video/compose.mjs --narration video/narration.json --build $B --out $B/git-flare.mp4
```

`gf` must be on the `PATH` for the sessions (for example a shim that runs `node cli/gf.mjs "$@"`). A new run
gives new patch ids and timings: check the `from`/`to` of the live segments in `narration.json` against the new
recordings (`record.mjs` prints when the focus scroll starts) and the narration against what happened.

`compose.mjs` writes the MP4 plus `.srt` captions and a `.chapters.txt` list.

| Script | Does |
| --- | --- |
| `cast.mjs` | runs a session script for real and records it as an asciicast (keywords colored, output unchanged) |
| `record.mjs` | a scene: `cast.mjs` plus full-resolution screenshots of the dashboard every 0.5 s |
| `tamper.mjs` | the attacker of the guard scene: a write token minted with wrangler, a push to main |
| `wait-guard.mjs` | polls the repository status until the main guard raises its alert |
| `cards.mjs` | the cards, rendered from HTML in headless Chrome; the architecture card also in steps |
| `tts.mjs` | narration per segment (Aura-2) and its word timestamps (Whisper), cached by text |
| `compose.mjs` | fits each visual to its narration, burns in the captions, joins, normalizes loudness |
| `chrome.mjs` | the headless Chrome driver (DevTools protocol) the others share |
