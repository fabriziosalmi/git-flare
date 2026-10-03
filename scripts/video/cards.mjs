#!/usr/bin/env node
// Title, explanation and chart cards for the demo video, rendered to 1920x1080 PNGs with headless Chrome.
// Every number on a card is read from benchmarks/results/ at build time.
//
//   node scripts/video/cards.mjs --out <dir> [--only name,name]
import fs from 'node:fs';
import path from 'node:path';
import { launch } from './chrome.mjs';

const args = process.argv.slice(2);
const arg = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const OUT = arg('out');
const ONLY = arg('only')?.split(',');
if (!OUT) {
  console.error('usage: node scripts/video/cards.mjs --out <dir> [--only a,b]');
  process.exit(2);
}
const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const R = (f, day = '2026-10-02') => JSON.parse(fs.readFileSync(path.join(root, 'benchmarks', 'results', day, f), 'utf8'));
const fmt = (n) => Number(n).toLocaleString('en-US');

// ── data ─────────────────────────────────────────────────────────────────────
const claims = R('claims-load.json');
const claimsBefore = claims.before.run.claims;
// Like for like: the run after the change with as many claims as the run before it; the best run is shown apart.
const claimsSame = claims.after.runs.find((r) => r.claims.attempted === claimsBefore.attempted).claims;
const claimsBest = claims.after.runs.reduce((a, b) => (b.claims.perSec > a.claims.perSec ? b : a)).claims;
const dot = R('do-throughput-v2.json');
const regBefore = dot.registryReviews.before.runs;
const regAfter = dot.registryReviews.after.runs;
const shard1 = dot.claims.runs.filter((r) => r.shards === 1).map((r) => r.steady.aggregatePerSec);
const shard32 = dot.claims.runs.filter((r) => r.shards === 32).map((r) => r.steady.aggregatePerSec);
const art = R('artifacts-load.json');
const step = (label) => art.runs.filter((r) => r.label.startsWith(label)).flatMap((r) => r.steps);
const peak = (label) => Math.max(...step(label).map((s) => s.succeededPerSec));
const fourTokens = art.runs.filter((r) => r.label.startsWith('createToken(read): four')).reduce((a, r) => a + r.steps[0].succeededPerSec, 0);
const artSteps = art.runs.flatMap((r) => r.steps);
const artAttempted = artSteps.reduce((a, s) => a + s.attempted, 0);
const artFailed = artSteps.reduce((a, s) => a + s.failed, 0);
const rep = R('replicas.json');
// Real replicas (run 2); run 1 used four independent repositories: an upper bound, shown as a footnote.
const repMain = rep.run2_realReplicas.mainOnly480InFlight;
const repFour = rep.run2_realReplicas.fourReplicas120InFlightEach.total;
const repBound = { main: rep.run1_independentRepos.oneRepo480InFlight, four: rep.run1_independentRepos.fourRepos120InFlightEach.total };
const pctFail = (x) => Math.round((100 * (x.attempted - x.succeeded)) / x.attempted);
const pctFailExact = (x) => Number(((100 * (x.attempted - x.succeeded)) / x.attempted).toFixed(2));
const linger = R('container-linger.json', '2026-10-03');
const guard = R('guard-staging.json');
const deps = R('deps-tests.json');
const sim = R('simhash-calibration.json');

// ── page frame ───────────────────────────────────────────────────────────────
const font = path.join(root, 'src', 'ui', 'fonts', 'inter-latin-wght-normal.woff2');
const page = (body, extra = '') => `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family:'Inter'; src:url('file://${font}') format('woff2'); font-weight:100 900; }
:root { --canvas:oklch(10% 0 0); --base:oklch(17% 0 0); --recessed:oklch(15% 0 0); --hairline:oklch(26.9% 0 0); --text:oklch(97% 0 0); --strong:oklch(98.5% 0 0); --muted:oklch(70.8% 0 0);
  --brand:#f6821f; --primary:color-mix(in oklch, oklch(.5772 .2324 260), black 10%); --ok:oklch(76.5% .177 163.223); --ok-text:oklch(90.5% .093 164.15); --bad:oklch(70.4% .191 22.216); --warn:oklch(75% .183 55.934); --info:oklch(70.7% .165 254.624); }
* { box-sizing:border-box; } html,body { margin:0; width:1536px; height:864px; overflow:hidden; }
body { background:var(--canvas); color:var(--text); font:22px/1.45 'Inter', system-ui, sans-serif; font-feature-settings:'cv11','ss01'; -webkit-font-smoothing:antialiased;
  padding:64px 80px 104px; display:flex; flex-direction:column; justify-content:center; } /* centered above the caption band */
h1 { font-size:46px; font-weight:650; letter-spacing:-.02em; margin:0 0 10px; color:var(--strong); } .kicker { color:var(--brand); font-size:18px; font-weight:600; letter-spacing:.06em; text-transform:uppercase; margin-bottom:10px; }
.sub { color:var(--muted); font-size:24px; margin:0 0 36px; max-width:1200px; }
.card { background:var(--base); border:1px solid var(--hairline); border-radius:12px; padding:26px 30px; }
.grid3 { display:grid; grid-template-columns:repeat(3,1fr); gap:24px; } .grid3 .card { font-size:27px; padding:32px 34px; } .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:28px; }
.big { font-size:64px; font-weight:650; letter-spacing:-.03em; color:var(--strong); line-height:1.05; } .unit { font-size:22px; color:var(--muted); font-weight:500; }
.muted { color:var(--muted); } .ok { color:var(--ok-text); } .bad { color:var(--bad); } .brand { color:var(--brand); }
.mono { font-family:ui-monospace,'SF Mono',Menlo,monospace; }
.foot { position:absolute; left:80px; right:80px; top:24px; color:var(--muted); font-size:16px; display:flex; justify-content:space-between; } /* the bottom is the caption band */
ul.check { list-style:none; padding:0; margin:0; } ul.check li { padding:12px 0 12px 44px; position:relative; border-top:1px solid var(--hairline); font-size:24px; } ul.check li:first-child { border-top:0; }
ul.check li::before { content:'✓'; position:absolute; left:4px; color:var(--ok); font-weight:700; }
ul.dash li::before { content:'–'; color:var(--muted); }
${extra}
</style></head><body>${body}</body></html>`;
const foot = (src) => `<div class="foot"><span><span class="brand">git</span>-flare</span><span class="mono">${src}</span></div>`;

function bars(items, { width = 620, height = 300, max, unit = '' }) {
  const m = max ?? Math.max(...items.map((i) => i.value)) * 1.12;
  const bw = Math.min(150, (width - 40) / items.length - 40);
  return `<svg width="${width}" height="${height + 70}" viewBox="0 0 ${width} ${height + 70}">${items
    .map((it, i) => {
      const h = Math.max(4, (it.value / m) * height);
      const x = 30 + i * ((width - 40) / items.length) + ((width - 40) / items.length - bw) / 2;
      return `<rect x="${x}" y="${height - h + 10}" width="${bw}" height="${h}" rx="6" fill="${it.color}"/>
<text x="${x + bw / 2}" y="${height - h}" fill="#f5f5f5" font-size="30" font-weight="650" text-anchor="middle" font-family="Inter">${it.label ?? fmt(it.value)}${unit}</text>
<text x="${x + bw / 2}" y="${height + 46}" fill="#b4b4b4" font-size="19" text-anchor="middle" font-family="Inter">${it.name}</text>`;
    })
    .join('')}</svg>`;
}

function lines(series, { width = 760, height = 360, xmax, ymax }) {
  const px = (x) => 70 + (x / xmax) * (width - 100);
  const py = (y) => 20 + height - (y / ymax) * height;
  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => `<line x1="70" x2="${width - 30}" y1="${py(f * ymax)}" y2="${py(f * ymax)}" stroke="#333"/><text x="60" y="${py(f * ymax) + 6}" fill="#9a9a9a" font-size="16" text-anchor="end" font-family="Inter">${fmt(Math.round(f * ymax))}</text>`).join('');
  const xt = [0, 25000, 50000, 75000, 100000].map((x) => `<text x="${px(x)}" y="${height + 50}" fill="#9a9a9a" font-size="16" text-anchor="middle" font-family="Inter">${x / 1000}k</text>`).join('');
  const paths = series
    .map((s) => `<polyline fill="none" stroke="${s.color}" stroke-width="4" points="${s.points.map(([x, y]) => `${px(x)},${py(y)}`).join(' ')}"/>${s.points.map(([x, y]) => `<circle cx="${px(x)}" cy="${py(y)}" r="5" fill="${s.color}"/>`).join('')}<text x="${px(s.points.at(-1)[0]) + (s.labelDx ?? 0)}" y="${py(s.points.at(-1)[1]) + (s.labelDy ?? -14)}" fill="${s.color}" font-size="18" font-weight="600" text-anchor="${s.anchor ?? 'end'}" font-family="Inter">${s.name}</text>`)
    .join('');
  return `<svg width="${width}" height="${height + 70}" viewBox="0 0 ${width} ${height + 70}">${grid}${xt}${paths}</svg>`;
}

// The architecture diagram, whole or with one step of the narration lit (the rest dimmed).
const ARCH_STEPS = {
  agents: ['agents', 'e-aw', 'worker'],
  shards: ['worker', 'e-ws', 'shards'],
  push: ['agents', 'e-push', 'artifacts'],
  diff: ['shards', 'artifacts'],
  review: ['agents', 'e-aw', 'worker', 'e-ws', 'shards'],
  queue: ['worker', 'e-wr', 'registry'],
  land: ['registry', 'e-rt', 'tests', 'e-ra', 'artifacts'],
  guard: ['artifacts', 'e-aq', 'queues', 'e-qr', 'registry'],
};
function architecture(step) {
  const lit = new Set(ARCH_STEPS[step] ?? []);
  const n = (id, body) => `<g id="${id}" class="n${lit.has(id) ? ' on' : ''}">${body}</g>`;
  const box = (x, y, w, h, stroke = '#444') => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="oklch(17% 0 0)" stroke="${stroke}"/>`;
  return page(`<div class="kicker">How it works</div><h1 style="margin-bottom:6px">One writer of main, everything else in parallel</h1>
<svg class="${step ? 'focus' : ''}" width="1260" height="619" viewBox="-4 -92 1384 680" style="display:block;margin:0 auto" font-family="Inter">
<defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#8a8a8a"/></marker>
<marker id="aw" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#f2f2f2"/></marker></defs>
<g font-size="20">
${n('agents', `${box(0, 40, 250, 230)}
<text x="125" y="78" fill="#f6821f" font-weight="650" text-anchor="middle" font-size="22">Agents</text>
<text x="125" y="116" fill="#eee" text-anchor="middle">LLM coders</text><text x="125" y="146" fill="#eee" text-anchor="middle">LLM reviewers</text>
<text x="125" y="176" fill="#9a9a9a" text-anchor="middle" font-size="17">Workers AI</text><text x="125" y="226" fill="#eee" text-anchor="middle" class="mono">gf CLI + git</text>`)}
${n('worker', `${box(320, 110, 210, 90)}
<text x="425" y="148" fill="#fff" font-weight="650" text-anchor="middle">Worker</text><text x="425" y="176" fill="#9a9a9a" text-anchor="middle" font-size="16">auth · rate limits</text>`)}
${n('shards', `${box(600, 0, 360, 150)}
<text x="780" y="38" fill="#fff" font-weight="650" text-anchor="middle">Task shards</text><text x="780" y="66" fill="#9a9a9a" text-anchor="middle" font-size="16">Durable Objects × N</text>
<text x="780" y="102" fill="#eee" text-anchor="middle" font-size="18">leases · fencing epochs</text><text x="780" y="130" fill="#eee" text-anchor="middle" font-size="18">server-side diff · gates · reviews</text>`)}
${n('registry', `${box(600, 190, 360, 190, '#f6821f')}
<text x="780" y="228" fill="#f6821f" font-weight="650" text-anchor="middle">Registry</text><text x="780" y="256" fill="#9a9a9a" text-anchor="middle" font-size="16">one Durable Object per repository</text>
<text x="780" y="294" fill="#eee" text-anchor="middle" font-size="18">merge queue — sole writer of main</text><text x="780" y="322" fill="#eee" text-anchor="middle" font-size="18">review graph · main guard</text><text x="780" y="350" fill="#eee" text-anchor="middle" font-size="18">read replicas in sync</text>`)}
${n('artifacts', `${box(1040, 0, 336, 280)}
<text x="1208" y="38" fill="#fff" font-weight="650" text-anchor="middle">Artifacts</text>
<text x="1208" y="84" fill="#eee" text-anchor="middle">main</text><text x="1208" y="124" fill="#eee" text-anchor="middle">read replicas</text><text x="1208" y="164" fill="#eee" text-anchor="middle">one fork per agent</text>
<text x="1208" y="214" fill="#9a9a9a" text-anchor="middle" font-size="16">git-compatible repositories</text>`)}
${n('tests', `${box(1040, 330, 336, 130)}
<text x="1208" y="368" fill="#fff" font-weight="650" text-anchor="middle">Test container</text><text x="1208" y="398" fill="#eee" text-anchor="middle" font-size="18">project's own tests</text><text x="1208" y="426" fill="#9a9a9a" text-anchor="middle" font-size="16">no internet · npm read-only</text>`)}
${n('queues', `${box(600, 430, 360, 100)}
<text x="780" y="468" fill="#fff" font-weight="650" text-anchor="middle">Queues</text><text x="780" y="498" fill="#9a9a9a" text-anchor="middle" font-size="16">Artifacts events → main guard</text>`)}
</g>
<g stroke="#8a8a8a" stroke-width="2.5" fill="none" marker-end="url(#a)">
${n('e-aw', '<path d="M250,155 L318,155"/>')}${n('e-ws', '<path d="M530,140 L598,90"/>')}${n('e-wr', '<path d="M530,170 L598,260"/>')}
${n('e-ra', '<path d="M960,300 L1038,230"/>')}${n('e-rt', '<path d="M960,340 L1038,390"/>')}
${n('e-push', '<path d="M250,120 C640,-150 920,-150 1038,40"/><text x="780" y="-30" fill="#9a9a9a" stroke="none" font-size="16" text-anchor="middle">git push to the agent\'s own fork</text>')}
${n('e-aq', '<path d="M1040,250 C985,300 985,450 962,480"/>')}${n('e-qr', '<path d="M780,430 L780,382"/>')}
</g>
</svg>`, `svg.focus .n { opacity:.22; } svg.focus .n.on { opacity:1; } svg.focus g.n.on > rect { stroke:#f6821f; stroke-width:2; } svg.focus g.n.on > path { stroke:#f2f2f2; marker-end:url(#aw); }`);
}

// ── cards ────────────────────────────────────────────────────────────────────
const CARDS = {
  title: page(`<div style="height:100%;display:flex;flex-direction:column;justify-content:center;padding-bottom:40px">
<div style="font-size:128px;font-weight:700;letter-spacing:-.045em;line-height:1"><span class="brand">git</span>-flare</div>
<div style="font-size:38px;color:var(--strong);margin-top:22px;max-width:1150px;letter-spacing:-.01em">A merge fabric for many coding agents working on one repository.</div>
<div style="font-size:24px;color:var(--muted);margin-top:28px">Workers · Durable Objects · Artifacts · Containers · Queues · Workers AI</div></div>`),

  problem: page(`<div class="kicker">The problem</div><h1>Many agents, one repository: three things break</h1>
<p class="sub">Point a swarm of coding agents at a single Git repository and the tools built for a few humans give way.</p>
<div class="grid3">
<div class="card" data-s="coordination"><div class="brand" style="font-weight:650;font-size:28px;margin-bottom:12px">Coordination</div><div>Agents race for the same work and collide on every push to main.</div></div>
<div class="card" data-s="review"><div class="brand" style="font-weight:650;font-size:28px;margin-bottom:12px">Review</div><div>Ten copies of one model agreeing are not ten independent opinions.</div></div>
<div class="card" data-s="trust"><div class="brand" style="font-weight:650;font-size:28px;margin-bottom:12px">Trust</div><div>On Artifacts, as on plain Git, any write token can push to main — or rewrite it.</div></div>
</div>${foot('every measurement in this video: benchmarks/results/')}`),

  architecture: architecture(),

  sandbox: page(`<div class="kicker">The project's tests</div><h1>Tests run offline and leave nothing behind</h1>
<p class="sub">A Cloudflare Container per repository, started with internet disabled. Dependencies come from a read-only npm proxy; the tests run as an unprivileged user.</p>
<div class="grid3s"><div class="card" data-s="probe"><div class="muted" style="font-size:17px;margin-bottom:8px">Probe test, submitted as an ordinary patch</div>
<ul class="check"><li>no internet (example.com, 1.1.1.1)</li><li>proxy refuses writes (405)</li><li>dependencies read-only</li><li>npm cache out of reach · not root</li></ul></div>
<div class="card" data-s="root"><div class="muted" style="font-size:17px;margin-bottom:8px">Same probe, tests deliberately run as root</div>
<div style="font-size:23px;margin-top:6px">it rewrote <span class="mono">node_modules/ms</span>, broke another test in the same run and was <span class="bad">rejected</span></div></div>
<div class="card" data-s="linger"><div class="muted" style="font-size:17px;margin-bottom:8px">A test leaves a process and files behind</div>
<div style="font-size:23px;margin-top:6px">one run later: <span class="ok">both gone</span> (${linger.fixed.passed}/${linger.fixed.checks} checks)</div>
<div class="muted" style="font-size:19px;margin-top:14px">cleanup broken on purpose: <span class="bad">caught</span></div></div></div>
${foot('deps-tests.json · 2026-10-03/container-linger.json')}`, `.grid3s { display:grid; grid-template-columns:repeat(3,1fr); gap:22px; } .grid3s ul.check li { font-size:21px; padding:9px 0 9px 36px; }`),

  'scale-claims': page(`<div class="kicker">Scale · real Artifacts</div><h1>Claims stopped calling Artifacts</h1>
<p class="sub">No 429 among the statuses we recorded: past a few hundred operations per second the control plane queues and latency grows. So a claim now makes no per-claim Artifacts call.</p>
<div class="grid2" style="align-items:center"><div class="card" style="padding-bottom:10px">${bars(
    [
      { name: 'before', value: claimsBefore.perSec, color: '#6b6b6b' },
      { name: 'after', value: claimsSame.perSec, color: '#f6821f' },
    ],
    { width: 600, height: 300, unit: '/s' }
  )}</div>
<div><div class="big">${(claimsSame.perSec / claimsBefore.perSec).toFixed(1)}×</div><div class="muted" style="margin:6px 0 22px">claims per second, a ${fmt(claimsBefore.attempted)}-claim run of each design (before: head + 2 tokens per claim), 16 shards, one client</div>
<div style="font-size:22px">provisioning p95 <span class="bad">${(claimsBefore.serverProvisioningMs.p95 / 1000).toFixed(1)} s</span> → <span class="ok">${(claimsSame.serverProvisioningMs.p95 / 1000).toFixed(2)} s</span></div>
<div style="font-size:22px;margin-top:8px">a ${fmt(claimsBest.attempted)}-claim run: <span class="ok">${fmt(claimsBest.perSec)} claims/s</span>, p95 ${claimsBest.serverProvisioningMs.p95} ms</div>
<div class="muted" style="font-size:18px;margin-top:20px">Artifacts, one repository: ${fmt(peak('createToken(read): one'))} token mints/s · ~${fmt(Math.round(fourTokens))}/s over four · ${fmt(peak('readTree'))}–${fmt(peak('git GET info/refs: one'))} reads or git requests/s · ${artFailed} failures in ${fmt(artAttempted)} operations</div></div></div>
${foot('claims-load.json · artifacts-load.json')}`),

  'scale-objects': page(`<div class="kicker">Scale · Durable Objects</div><h1>The coordination layer stays flat</h1>
<div class="grid2" style="margin-top:30px;align-items:start"><div class="card" data-s="reviews"><div class="muted" style="font-size:18px">recording a review vs. size of the approval graph (reviews/s)</div>${lines(
    [
      { name: 'earlier build', color: '#ef4444', points: regBefore.map((r) => [r.edges, r.reviewsPerSec]), anchor: 'start', labelDx: 12, labelDy: 6 },
      { name: 'now', color: '#f6821f', points: regAfter.map((r) => [r.edges, r.reviewsPerSec]), labelDy: -16 },
    ],
    { width: 640, height: 330, xmax: 100000, ymax: 1500 }
  )}<div class="muted" style="font-size:16px">approval edges</div></div>
<div style="display:flex;flex-direction:column;gap:24px">
<div class="card" data-s="claims"><div class="big">~${fmt(Math.round(shard1.reduce((a, b) => a + b, 0) / shard1.length))}<span class="unit"> claims/s</span></div><div class="muted">one task shard, agent known to the shard</div></div>
<div class="card" data-s="claims"><div class="big">${fmt(Math.min(...shard32))}–${fmt(Math.max(...shard32))}<span class="unit"> claims/s</span></div><div class="muted">32 shards in parallel, in two of three runs (the third: 2,875/s)</div></div>
<div class="card" data-s="reviews"><div style="font-size:24px">reviews: <span class="bad">${regBefore[0].reviewsPerSec} → ${regBefore.at(-1).reviewsPerSec}/s</span> at ${fmt(regBefore.at(-1).edges)} edges before; <span class="ok">${fmt(Math.min(...regAfter.map((r) => r.reviewsPerSec)))}–${fmt(Math.max(...regAfter.map((r) => r.reviewsPerSec)))}/s</span> up to ${fmt(regAfter.at(-1).edges)} now</div></div>
</div></div>${foot('do-throughput-v2.json · bench Worker, Artifacts mocked')}`),

  'scale-replicas': page(`<div class="kicker">Scale · read replicas</div><h1>Clones spread over replicas of main</h1>
<p class="sub">One Artifacts repository answers 5xx when hundreds of agents clone at once. The merge queue keeps replicas at main's head; each shard reads from its own.</p>
<div class="grid2"><div class="card">${bars(
    [
      { name: 'main alone', value: pctFail(repMain), label: `${pctFail(repMain)}%`, color: '#ef4444' },
      { name: 'four replicas', value: repFour.failedPct, label: `${Math.round(repFour.failedPct)}%`, color: '#f6821f' },
    ],
    { width: 600, height: 240, max: 40 }
  )}<div class="muted" style="font-size:18px">clones failed (2,000 clones, 480 in flight)</div></div>
<div class="card">${bars(
    [
      { name: 'main alone', value: repMain.succeededPerSec, color: '#6b6b6b' },
      { name: 'four replicas', value: repFour.aggregatePerSec, color: '#f6821f' },
    ],
    { width: 600, height: 240, max: 180 }
  )}<div class="muted" style="font-size:18px">successful clones per second</div></div></div>
<div class="muted" style="font-size:17px;margin-top:14px">An upper bound, with four independent repositories instead of replicas: ${pctFail(repBound.main)}% → ${pctFailExact(repBound.four)}% failed, ${repBound.main.succeededPerSec} → ${repBound.four.aggregatePerSec} clones/s.</div>${foot('replicas.json')}`),

  limits: page(`<div class="kicker">Not solved yet</div><h1>What we say plainly</h1>
<div class="card" style="margin-top:30px;max-width:1250px"><ul class="check dash">
<li data-s="l1">Conflicts are detected per file; semantic breakage across files is caught only by the project's tests.</li>
<li data-s="l2">Test dependencies: npm only (no pip, cargo, … yet).</li>
<li data-s="l3">One registry per repository: about a thousand reviews recorded per second; merges about 12 patches per second.</li>
<li data-s="l4">Onboarding is bounded by fork creation: a few seconds per agent, once.</li>
<li data-s="l5">Near-duplicates are textual (SimHash, ${sim.decision.threshold}-bit threshold calibrated on public repositories): flagged for reviewers, not closed.</li>
</ul></div>${foot('README.md · docs/SPEC.md')}`),

  dx: page(`<div class="kicker">Try it</div><h1>Five commands from zero to a submitted patch</h1>
<div class="grid2" style="margin-top:30px"><div class="card mono" style="font-size:24px;line-height:1.9">
<div><span class="brand">$</span> gf login --base &lt;url&gt; --key &lt;agent-key&gt;</div>
<div><span class="brand">$</span> gf join tiny-lib</div><div><span class="brand">$</span> gf claim tiny-lib T1</div>
<div><span class="brand">$</span> git commit -am "T1"</div><div><span class="brand">$</span> gf submit</div></div>
<div class="card" style="font-size:22px"><div style="font-weight:650;margin-bottom:12px">Run the whole platform</div>
<div class="mono" style="font-size:20px;line-height:1.8">npm ci &amp;&amp; npm test<br>npx wrangler deploy --env staging<br>node scripts/demo.mjs …</div>
<div class="muted" style="margin-top:18px;font-size:19px">Local mode needs no Cloudflare account: Artifacts and the test runner are mocked.</div></div></div>${foot('README.md')}`),

  close: page(`<div style="height:100%;display:flex;flex-direction:column;justify-content:center;padding-bottom:40px">
<div style="font-size:96px;font-weight:700;letter-spacing:-.045em;line-height:1"><span class="brand">git</span>-flare</div>
<div style="font-size:38px;color:var(--strong);margin-top:22px">Many agents. One main. Nothing merged that the platform did not check.</div>
<div style="font-size:26px;color:var(--muted);margin-top:34px" class="mono">github.com/fabriziosalmi/git-flare</div>
<div style="font-size:22px;color:var(--muted);margin-top:14px">Every measurement in this video comes from a script in the repository, with its raw output.</div></div>`),
};

for (const st of Object.keys(ARCH_STEPS)) CARDS[`architecture.${st}`] = architecture(st);
// Cards narrated part by part: <card>.<step> lights the elements marked data-s="<step>" and dims the rest.
const STEPS = { problem: ['coordination', 'review', 'trust'], sandbox: ['probe', 'root', 'linger'], 'scale-objects': ['claims', 'reviews'], limits: ['l1', 'l2', 'l3', 'l4', 'l5'] };
for (const [name, steps] of Object.entries(STEPS)) {
  for (const st of steps) CARDS[`${name}.${st}`] = CARDS[name].replace('</style>', `[data-s] { opacity:.25; } [data-s~="${st}"] { opacity:1; }\n</style>`);
}

fs.mkdirSync(OUT, { recursive: true });
const browser = await launch({ dark: true });
for (const [name, html] of Object.entries(CARDS)) {
  if (ONLY && !ONLY.includes(name.split('.')[0])) continue;
  const file = path.join(OUT, `${name}.html`);
  fs.writeFileSync(file, html);
  await browser.goto(`file://${file}`, 600);
  await browser.screenshot(path.join(OUT, `${name}.png`));
  console.error(`card ${name}`);
}
await browser.close();
