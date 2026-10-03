// Read-only live view of one repository. Every value coming from the API is rendered with textContent / DOM
// nodes: task titles, agent ids, review reasoning and test logs are attacker-controlled strings.
export function renderDashboardHtml(repo: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>git-flare</title>
<style>
  /* Visual language of Cloudflare's dashboard: tokens from @cloudflare/kumo 2.14.0 (MIT), Inter (OFL 1.1). */
  @font-face { font-family:'Inter'; src:url('/fonts/inter.woff2') format('woff2'); font-weight:100 900; font-style:normal; font-display:swap; }
  :root {
    color-scheme: light dark;
    --canvas: light-dark(oklch(98.75% 0 0), oklch(10% 0 0));
    --base: light-dark(#fff, oklch(17% 0 0));
    --recessed: light-dark(oklch(96% 0 0), oklch(15% 0 0));
    --hairline: light-dark(oklch(93.5% 0 0), oklch(26.9% 0 0));
    --line: light-dark(oklch(14.5% 0 0 / .1), oklch(32% 0 0));
    --text: light-dark(oklch(21% .006 285.885), oklch(97% 0 0));
    --strong: light-dark(oklch(14.5% 0 0), oklch(98.5% 0 0));
    --muted: light-dark(oklch(55.6% 0 0), oklch(70.8% 0 0));
    --brand: #f6821f;
    --primary: light-dark(oklch(.5772 .2324 260), color-mix(in oklch, oklch(.5772 .2324 260), black 10%));
    --ok: light-dark(oklch(43.2% .095 166.913), oklch(90.5% .093 164.15));
    --ok-solid: light-dark(oklch(59.6% .145 163.225), oklch(76.5% .177 163.223));
    --ok-tint: light-dark(oklch(96.2% .043 156.7 / .57), oklch(39.3% .096 152.3 / .2));
    --bad: light-dark(oklch(50.5% .213 27.518), oklch(70.4% .191 22.216));
    --bad-tint: light-dark(oklch(93.6% .032 17.7 / .42), oklch(42.9% .176 28.7 / .17));
    --warn: light-dark(oklch(59.7% .144 57.5), oklch(75% .183 55.934));
    --warn-tint: light-dark(oklch(93.1% .107 94.6 / .2), oklch(35.3% .079 65 / .37));
    --info: light-dark(oklch(42.4% .199 265.638), oklch(70.7% .165 254.624));
    --info-tint: light-dark(oklch(93.2% .032 255.6 / .45), oklch(38% .145 265.5 / .22));
    --shadow: light-dark(oklch(0% 0 0 / .08), oklch(0% 0 0 / .3));
    --mono: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  html { -webkit-font-smoothing: antialiased; }
  body { margin:0; padding:20px 24px; background:var(--canvas); color:var(--text); font:14px/1.5 'Inter', -apple-system, system-ui, 'Segoe UI', Roboto, sans-serif; font-feature-settings:'cv11','ss01'; }
  header { display:flex; flex-wrap:wrap; gap:12px; align-items:center; justify-content:space-between; margin-bottom:16px; }
  h1 { font-size:20px; font-weight:600; margin:0; color:var(--strong); display:flex; align-items:center; gap:10px; letter-spacing:-.01em; }
  h1 .logo { color:var(--brand); }
  h2 { font-size:14px; font-weight:600; margin:0 0 12px; color:var(--strong); }
  .muted { color:var(--muted); } .mono { font-family:var(--mono); font-size:12.5px; }
  .foot { margin:16px 2px 4px; font-size:12px; color:var(--muted); }
  .pill { display:inline-flex; align-items:center; padding:1px 8px; border-radius:6px; font-size:12px; font-weight:500; white-space:nowrap; background:var(--recessed); color:var(--text); }
  .tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(104px,1fr)); gap:10px; margin-bottom:16px; }
  .tile { background:var(--base); border:1px solid var(--hairline); border-radius:8px; padding:10px 12px; box-shadow:0 1px 2px var(--shadow); }
  .tile span { font-size:12px; line-height:1.3; display:block; min-height:2.6em; color:var(--muted); }
  .tile b { display:block; font-size:24px; font-weight:600; color:var(--strong); letter-spacing:-.02em; }
  .grid { display:grid; grid-template-columns: 1fr 1.35fr .85fr; gap:16px; align-items:start; }
  .col { display:flex; flex-direction:column; gap:16px; min-width:0; }
  @media (max-width: 1100px) { .grid { grid-template-columns: 1fr; } }
  .card { background:var(--base); border:1px solid var(--hairline); border-radius:8px; padding:16px; min-width:0; box-shadow:0 1px 2px var(--shadow); }
  .row { border-top:1px solid var(--hairline); padding:10px 0; } .row:first-of-type { border-top:0; }
  .s-available,.s-evaluating { color:var(--info); } .s-claimed,.s-queued { color:var(--warn); } .s-merged { color:var(--ok); }
  .s-rejected,.s-duplicate,.s-stale,.s-expired { color:var(--bad); } .s-submitted { color:var(--brand); }
  .pill.s-available,.pill.s-evaluating { background:var(--info-tint); } .pill.s-claimed,.pill.s-queued { background:var(--warn-tint); }
  .pill.s-merged { background:var(--ok-tint); } .pill.s-rejected,.pill.s-duplicate,.pill.s-stale,.pill.s-expired { background:var(--bad-tint); }
  pre { background:var(--recessed); border:1px solid var(--hairline); border-radius:6px; padding:10px; overflow:auto; max-height:180px; white-space:pre-wrap; word-break:break-word; margin:6px 0 0; font-family:var(--mono); font-size:12px; }
  .rev { margin:8px 0 0 0; padding-left:10px; border-left:2px solid var(--hairline); display:flex; gap:8px; align-items:flex-start; }
  .rev .body { min-width:0; }
  .badge { flex:none; vertical-align:middle; }
  .fam { display:inline-flex; align-items:center; gap:5px; }
  .bar { height:6px; background:var(--recessed); border-radius:3px; overflow:hidden; margin-top:6px; } .bar i { display:block; height:100%; background:var(--ok-solid); }
  input, button { font:inherit; }
  input { background:var(--base); color:var(--text); border:1px solid var(--line); border-radius:6px; padding:6px 10px; width:200px; }
  input:focus-visible, button:focus-visible { outline:2px solid var(--primary); outline-offset:1px; }
  button { background:var(--primary); color:#fff; border:0; border-radius:6px; padding:7px 14px; font-weight:500; cursor:pointer; }
  details summary { cursor:pointer; color:var(--muted); }
  textarea { width:100%; min-height:90px; background:var(--recessed); color:var(--text); border:1px solid var(--hairline); border-radius:6px; padding:8px; font-family:var(--mono); font-size:12px; }
</style>
</head>
<body>
<header>
  <div><h1><span><span class="logo">git</span>-flare</span> <span class="pill mono" id="repoPill"></span></h1><div class="muted" id="meta">loading…</div></div>
  <form id="switch"><input id="repoInput" placeholder="repository" aria-label="repository"> <button>Open</button></form>
</header>
<div class="tiles" id="tiles"></div>
<div class="grid">
  <div class="col">
    <div class="card"><h2>Main guard</h2><div id="guard" class="muted">…</div></div>
    <div class="card"><h2>Merge queue</h2><div id="queue" class="muted">…</div></div>
  </div>
  <div class="col"><div class="card"><h2>Patches</h2><div id="patches" class="muted">…</div></div></div>
  <div class="col"><div class="card"><h2>Tasks</h2><div id="tasks" class="muted">…</div></div></div>
</div>
<details class="card" style="margin-top:12px"><summary>SimHash playground</summary>
  <p class="muted">256-bit SimHash of two texts and their Hamming distance (unrelated text ≈ 128 bits; within 14 bits a patch is flagged to reviewers as a near-duplicate).</p>
  <div class="grid" style="grid-template-columns:1fr 1fr"><textarea id="a">function add(a, b) { return a + b; }</textarea><textarea id="b">function add(a, b) {
  return a + b;
}</textarea></div>
  <p><button id="cmp" type="button">Compare</button> <span id="cmpOut" class="mono"></span></p>
</details>
<p class="foot">git-flare is an independent project, not affiliated with or endorsed by Cloudflare. Visual style adapted from Cloudflare's Kumo design tokens (MIT); Inter font (OFL 1.1).</p>
<script>
const REPO = ${JSON.stringify(repo)};
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined && text !== null) e.textContent = String(text); return e; };
const pill = (status) => el('span', 'pill s-' + status, status);
// Model-family badges: generated monograms (no vendor logos: trademarks are not ours to ship). Offline, built as SVG nodes.
const FAMILY_STYLE = { 'meta-llama': ['L', '#4c6ef5'], openai: ['O', '#10a37f'], mistral: ['M', '#f08c00'], qwen: ['Q', '#7048e8'], gemini: ['G', '#1c7ed6'], claude: ['C', '#d9480f'], 'gpt-4o': ['G', '#0ca678'], unknown: ['?', '#868e96'] };
function badge(family) {
  const key = String(family || 'unknown').toLowerCase();
  let [letter, color] = FAMILY_STYLE[key] || [];
  if (!letter) {
    let h = 0; for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    letter = (key.replace(/[^a-z0-9]/g, '')[0] || '?').toUpperCase();
    color = 'hsl(' + (h % 360) + ' 55% 45%)';
  }
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 20 20'); svg.setAttribute('width', '20'); svg.setAttribute('height', '20'); svg.setAttribute('class', 'badge');
  svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', key);
  const c = document.createElementNS(NS, 'circle'); c.setAttribute('cx', '10'); c.setAttribute('cy', '10'); c.setAttribute('r', '10'); c.setAttribute('fill', color);
  const t = document.createElementNS(NS, 'text'); t.setAttribute('x', '10'); t.setAttribute('y', '14'); t.setAttribute('text-anchor', 'middle');
  t.setAttribute('font-size', '11'); t.setAttribute('font-weight', '700'); t.setAttribute('fill', '#fff'); t.setAttribute('font-family', 'system-ui, sans-serif');
  t.textContent = letter;
  const title = document.createElementNS(NS, 'title'); title.textContent = key;
  svg.append(title, c, t);
  return svg;
}
const famLabel = (family) => { const s = el('span', 'fam'); s.append(badge(family), el('span', 'mono', family)); return s; };
const ms = (n) => n === undefined || n === null ? '' : (n >= 1000 ? (n / 1000).toFixed(1) + ' s' : n + ' ms');
document.getElementById('repoPill').textContent = REPO;
document.getElementById('repoInput').value = REPO;
document.getElementById('switch').addEventListener('submit', (e) => { e.preventDefault(); const v = document.getElementById('repoInput').value.trim(); if (v) location.search = '?repo=' + encodeURIComponent(v); });

function tiles(d) {
  const q = d.queue || {}, s = d.stats || {};
  const items = [
    ['Claims', s.claims], ['Merged', q.mergedPatches], ['Pushes to main', q.pushes], ['Largest batch', q.largestBatch],
    ['Conflicts', q.conflicts], ['Test runs', q.testRuns], ['Rejected by tests', q.testRejections], ['Rejected by review', s.reviewRejections],
    ['Gate rejections', s.gateRejections], ['Collusion-excluded', s.collusionExcludedReviews], ['Leases healed', s.leasesReclaimed], ['Claim races lost', s.claimRaceLosses],
  ];
  const t = document.getElementById('tiles'); t.replaceChildren();
  for (const [k, v] of items) { const c = el('div', 'tile'); c.append(el('span', 'muted', k), el('b', '', v ?? 0)); t.append(c); }
}

function queue(d) {
  const q = d.queue || {}; const box = document.getElementById('queue'); box.replaceChildren();
  box.append(el('div', '', (q.length || 0) + ' waiting · tests: ' + (q.testRunner || 'none') + (q.bisecting ? ' · bisecting ' + q.bisecting.suspects + ' suspects' : '')));
  if (q.lastError) box.append(el('div', 's-rejected', '! ' + q.lastError));
  for (const p of (q.pending || [])) box.append(el('div', 'mono muted', '⏳ ' + p.patchId + ' (' + p.taskId + ')'));
  if (!(q.recent || []).length) { box.append(el('div', 'muted', 'no rounds yet')); return; }
  for (const r of q.recent) {
    const row = el('div', 'row');
    const head = el('div'); head.append(el('b', '', r.via), el('span', 'muted', ' · ' + r.patches.length + ' patch(es)' + (r.conflicts.length ? ' · ' + r.conflicts.length + ' conflict(s)' : '') + ' · ' + ms(r.ms)));
    row.append(head);
    if (r.test) row.append(el('div', r.test.passed ? 's-merged' : 's-rejected', 'tests ' + (r.test.passed ? 'passed' : 'FAILED') + ' in ' + ms(r.test.ms) + ' · ' + r.test.results.map((x) => (x.phase ? '(install) ' : '') + x.command + ' → ' + x.exitCode).join(', ')));
    if (r.commit) row.append(el('div', 'mono muted', 'main → ' + r.commit.slice(0, 12)));
    if (r.test && !r.test.passed) { const det = el('details'); det.append(el('summary', '', 'test log'), el('pre', 'mono', r.test.logTail)); row.append(det); }
    box.append(row);
  }
}

function guardView(d) {
  const g = d.guard; const box = document.getElementById('guard'); box.replaceChildren();
  if (!g) { box.append(el('div', 'muted', 'no data')); return; }
  if (g.state === 'alert' && g.alert) {
    box.append(el('div', 's-rejected', '⚠ ' + g.alert.kind + ': ' + g.alert.detail));
    for (const c of (g.alert.commits || [])) box.append(el('div', 'mono muted', c.id.slice(0, 12) + ' ' + c.author + ' — ' + c.message));
    box.append(el('div', 'muted', 'merges are stopped until an admin accepts or restores main'));
  } else box.append(el('div', 's-merged', '✓ no write outside the merge queue seen (main checked on push events and at every merge round)'));
  if (g.expectedHead) box.append(el('div', 'mono muted', 'expected head ' + g.expectedHead.slice(0, 12)));
  for (const m of (d.mirrors || [])) box.append(el('div', 'mono ' + (m.current ? 'muted' : 's-rejected'), (m.current ? '✓ ' : '… ') + 'replica ' + m.name + ' @ ' + (m.head ? m.head.slice(0, 12) : '?')));
  const c = g.counts || {};
  box.append(el('div', 'muted', (c.events || 0) + ' events · ' + (c.ownPushes || 0) + ' own pushes · ' + (c.foreignPushes || 0) + ' foreign · ' + (c.clones || 0) + ' clones · ' + (c.fetches || 0) + ' fetches · max lag ' + ms(c.maxLagMs)));
  if (!(g.recent || []).length) { box.append(el('div', 'muted', 'no Artifacts events yet (is the repository watched?)')); return; }
  for (const r of [...g.recent].reverse()) {
    const row = el('div', 'mono ' + (r.verdict === 'foreign' ? 's-rejected' : 'muted'));
    row.textContent = (r.verdict === 'own' ? '✓ ' : r.verdict === 'foreign' ? '✗ ' : '· ') + r.type + (r.repo !== REPO ? ' ' + r.repo : '') + (r.after ? ' → ' + r.after : '') + ' (' + ms(r.lagMs) + ')';
    box.append(row);
  }
}

function tasksView(d) {
  const box = document.getElementById('tasks'); box.replaceChildren();
  const counts = {}; for (const t of d.tasks) counts[t.status] = (counts[t.status] || 0) + 1;
  const total = d.tasks.length || 1;
  const sum = el('div'); for (const [k, v] of Object.entries(counts)) { sum.append(pill(k), el('span', 'muted', ' ' + v + '  ')); } box.append(sum);
  const bar = el('div', 'bar'); const fill = el('i'); fill.style.width = Math.round(100 * (counts.merged || 0) / total) + '%'; bar.append(fill); box.append(bar);
  for (const t of d.tasks) {
    const row = el('div', 'row');
    const head = el('div'); head.append(el('span', 'mono', t.id + ' '), pill(t.status)); row.append(head, el('div', '', t.title));
    if (t.holder) row.append(el('div', 'muted mono', t.holder + (t.leaseExpiresAt ? ' · ' + Math.max(0, Math.round((t.leaseExpiresAt - Date.now()) / 1000)) + 's left' : '')));
    if (t.mergedCommit) row.append(el('div', 'muted mono', 'merged ' + t.mergedCommit.slice(0, 12)));
    box.append(row);
  }
}

function patchesView(d) {
  const box = document.getElementById('patches'); box.replaceChildren();
  if (!d.patches.length) { box.append(el('div', 'muted', 'no patches yet')); return; }
  for (const p of d.patches) {
    const row = el('div', 'row');
    const head = el('div'); head.append(pill(p.status), el('span', 'mono', ' ' + p.patchId), el('span', 'muted', ' · ' + p.taskId + ' · ' + p.author + ' '), famLabel(p.authorFamily));
    row.append(head);
    row.append(el('div', 'muted mono', p.changedFiles.map((f) => f.path + ' +' + f.added + '/-' + f.removed).join('  ')));
    const failed = p.gates.filter((g) => !g.passed);
    if (failed.length) row.append(el('div', 's-rejected', 'gates failed: ' + failed.map((g) => g.gate + ' (' + g.detail + ')').join('; ')));
    if (p.evaluation) row.append(el('div', 'muted', 'log-odds ' + p.evaluation.logOdds + ' / ' + p.evaluation.thresholdLogOdds + ' · ' + p.evaluation.approvals + ' approval(s), ' + p.evaluation.approvingFamilies + ' famil' + (p.evaluation.approvingFamilies === 1 ? 'y' : 'ies')));
    for (const r of p.reviews) {
      const rv = el('div', 'rev');
      const body = el('div', 'body');
      const top = el('div'); top.append(el('b', r.confidencePercent > 50 ? 's-merged' : 's-rejected', r.confidencePercent + '% '), el('span', 'mono', r.family));
      body.append(top, el('div', 'muted', r.reasoning || ''));
      rv.append(badge(r.family), body);
      row.append(rv);
    }
    if (p.mergedVia) row.append(el('div', 's-merged', 'merged via ' + p.mergedVia + (p.mergedCommit ? ' → ' + p.mergedCommit.slice(0, 12) : '')));
    if (p.mergeError) { const det = el('details'); det.append(el('summary', 's-rejected', p.mergeError.split('\\n')[0].slice(0, 90)), el('pre', 'mono', p.mergeError)); row.append(det); }
    box.append(row);
  }
}

let last = '';
async function refresh() {
  try {
    const r = await fetch('/api/repos/' + encodeURIComponent(REPO) + '/status');
    const text = await r.text();
    // Re-render only on change: keeps open logs and scroll position stable while nothing moves.
    if (text === last) return;
    last = text;
    const d = JSON.parse(text);
    if (!d.repo) { document.getElementById('meta').textContent = 'repository not initialized'; return; }
    document.getElementById('meta').textContent = d.shards + ' shard(s) · ' + (d.forks ?? 0) + ' agent fork(s) · artifacts: ' + d.mode + ' · updated ' + new Date().toLocaleTimeString();
    tiles(d); guardView(d); queue(d); tasksView(d); patchesView(d);
  } catch (e) { console.error(e); }
}
document.getElementById('cmp').addEventListener('click', async () => {
  const r = await fetch('/api/epistemic/compare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ textA: document.getElementById('a').value, textB: document.getElementById('b').value }) });
  const d = await r.json();
  document.getElementById('cmpOut').textContent = d.ok ? ('distance ' + d.distance + ' bits · ' + (d.nearDuplicate ? 'near-duplicate' : 'different')) : (d.error + ' ' + (d.detail || ''));
});
refresh(); setInterval(refresh, 3000);
</script>
</body>
</html>`;
}
