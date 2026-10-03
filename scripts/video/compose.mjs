#!/usr/bin/env node
// Assemble the demo video from video/narration.json: per segment a visual (card PNG, terminal cast, dashboard
// screencast) fitted to its narration, burned-in captions (rendered with headless Chrome), then one MP4 plus an
// .srt file and a chapter list.
//
//   node scripts/video/compose.mjs --narration video/narration.json --build <dir> --out <file.mp4>
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { launch } from './chrome.mjs';

const args = process.argv.slice(2);
const arg = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const NARRATION = arg('narration', 'video/narration.json');
const BUILD = arg('build');
const OUT = arg('out');
if (!BUILD || !OUT) {
  console.error('usage: node scripts/video/compose.mjs --narration <file> --build <dir> --out <file.mp4>');
  process.exit(2);
}
const W = 1920;
const H = 1080;
const FPS = 30;
const BG = '0x0b0b0b';
const ff = (a) => execFileSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y', ...a], { stdio: ['ignore', 'inherit', 'inherit'] });
const probe = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }).trim());
const width = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width', '-of', 'default=nw=1:nk=1', f], { encoding: 'utf8' }).trim());
const PAGE_W = 1536; // CSS width of the recorded dashboard; crops are given in CSS pixels
const { segments } = JSON.parse(fs.readFileSync(NARRATION, 'utf8'));
const durations = JSON.parse(fs.readFileSync(path.join(BUILD, 'audio', 'durations.json'), 'utf8'));
const tmp = path.join(BUILD, 'segments');
fs.mkdirSync(tmp, { recursive: true });

// ── sources: terminal casts and dashboard screencasts rendered once, on their real timeline (no idle compression:
// the from/to of a segment are seconds into the recording) ──────────────────────────────────────────────────
const THEME = '0b0b0b,ededed,262626,f87171,6ee7b7,facc15,60a5fa,c084fc,22d3ee,d4d4d4,525252,fca5a5,a7f3d0,fde68a,93c5fd,d8b4fe,67e8f9,fafafa';
// The terminal sits in a window (title bar, rounded border) above the caption band.
const WIN = { x: 158, y: 24, w: 1604, h: 937, bar: 40 };
const TERM = { x: WIN.x + 1, y: WIN.y + 1 + WIN.bar + 1, w: WIN.w - 2, h: WIN.h - WIN.bar - 3 };
async function windowPng() {
  const png = path.join(BUILD, 'rec', 'terminal-window.png');
  if (fs.existsSync(png)) return png;
  const html = path.join(BUILD, 'rec', 'terminal-window.html');
  fs.writeFileSync(html, `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family:'Inter'; src:url('file://${path.resolve('src/ui/fonts/inter-latin-wght-normal.woff2')}') format('woff2'); font-weight:100 900; }
html,body { margin:0; width:${W}px; height:${H}px; background:oklch(10% 0 0); }
.win { position:absolute; left:${WIN.x}px; top:${WIN.y}px; width:${WIN.w - 2}px; height:${WIN.h - 2}px; border:1px solid #2b2b2b; border-radius:12px; background:#${BG.slice(2)}; overflow:hidden; }
.bar { height:${WIN.bar}px; background:#161616; border-bottom:1px solid #262626; position:relative; font:500 15px/${WIN.bar}px 'Inter', sans-serif; color:#8a8a8a; text-align:center; }
.dots { position:absolute; left:16px; top:14px; display:flex; gap:8px; } .dots i { width:12px; height:12px; border-radius:50%; display:block; }
</style></head><body><div class="win"><div class="bar"><div class="dots"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i></div>git-flare — zsh</div></div></body></html>`);
  const b = await launch({ width: W, height: H, scale: 1 });
  await b.goto(`file://${html}`, 300);
  await b.screenshot(png);
  await b.close();
  return png;
}
async function castVideo(name) {
  const mp4 = path.join(BUILD, 'rec', `${name}.cast.mp4`);
  if (fs.existsSync(mp4)) return mp4;
  const gif = path.join(BUILD, 'rec', `${name}.gif`);
  execFileSync('agg', ['--theme', THEME, '--font-family', 'Menlo', '--font-size', '28', '--line-height', '1.32', '--idle-time-limit', '100000', '--last-frame-duration', '3', '--fps-cap', '30', path.join(BUILD, 'rec', `${name}.cast`), gif], { stdio: 'ignore' });
  ff(['-loop', '1', '-i', await windowPng(), '-i', gif, '-filter_complex', `[1:v]scale=${TERM.w}:${TERM.h}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${TERM.w}:${TERM.h}:(ow-iw)/2:0:color=${BG}[t];[0:v][t]overlay=${TERM.x}:${TERM.y}:shortest=1,fps=${FPS},format=yuv420p`, '-c:v', 'libx264', '-crf', '16', '-preset', 'medium', mp4]);
  return mp4;
}
// Kept at the capture resolution, so a segment can crop a region and still downscale to 1080p.
function dashVideo(name) {
  const mp4 = path.join(BUILD, 'rec', `${name}-dash.mp4`);
  if (fs.existsSync(mp4)) return mp4;
  ff(['-f', 'concat', '-safe', '0', '-i', path.join(BUILD, 'rec', `${name}-dash`, 'frames.txt'), '-vf', `fps=${FPS},format=yuv420p`, '-c:v', 'libx264', '-crf', '14', '-preset', 'medium', mp4]);
  return mp4;
}
// {crop: [x, y, w]} in CSS pixels of the dashboard page; the height follows the 16:9 frame.
function dashFrame(src, crop) {
  const k = width(src) / PAGE_W;
  const even = (n) => 2 * Math.round((n * k) / 2);
  const c = crop ? `crop=${even(crop[2])}:${even((crop[2] * 9) / 16)}:${even(crop[0])}:${even(crop[1])},` : '';
  return `${c}scale=${W}:${H}:flags=lanczos,`;
}

// ── captions: sentence chunks, timed by the narration's own words ──────────────────────────────────────────
// One line each (at most MAX characters): sentences, long ones cut at commas, then into even word runs.
const MAX = 84;
function evenSplit(p) {
  const words = p.split(' ');
  const n = Math.ceil(p.length / MAX);
  const out = [];
  let cur = '';
  for (const w of words) {
    if (cur && (cur + ' ' + w).length > p.length / n + 8) {
      out.push(cur);
      cur = w;
    } else cur = cur ? cur + ' ' + w : w;
  }
  if (cur) out.push(cur);
  return out;
}
function chunks(text) {
  const out = [];
  let short = false; // the last chunk is a whole, very short sentence: it joins the next one
  for (const sentence of text.match(/[^.!?;]+[.!?;]*\s*/g).map((s) => s.trim()).filter(Boolean)) {
    let cur = short ? out.pop() : '';
    const before = out.length;
    for (const part of sentence.split(/(?<=[,:]) /)) {
      if (cur && (cur + ' ' + part).length > MAX) {
        out.push(cur);
        cur = part;
      } else cur = cur ? cur + ' ' + part : part;
    }
    if (cur) out.push(cur);
    short = out.length === before + 1 && sentence.length < 24 && cur === sentence;
  }
  return out.flatMap((c) => (c.length > MAX ? evenSplit(c) : [c]));
}
// A position in the narration text (0..1) → the moment it is spoken: the start of the Whisper word at the same
// relative position of the transcript (same words, give or take spelling). Without words: proportional.
function speechClock(audio) {
  const words = audio.words ?? [];
  if (!words.length) return (f) => 0.15 + f * (audio.seconds - 0.2);
  const total = words.reduce((a, w) => a + w.word.length + 1, 0);
  let acc = 0;
  const at = words.map((w) => {
    const p = { f: acc / total, t: w.start };
    acc += w.word.length + 1;
    return p;
  });
  return (f) => at.reduce((b, p) => (Math.abs(p.f - f) < Math.abs(b.f - f) ? p : b)).t;
}
function cues(text, audio) {
  const cs = chunks(text);
  const clock = speechClock(audio);
  const total = cs.reduce((a, c) => a + c.length + 1, 0);
  let acc = 0;
  const pos = cs.map((c) => {
    const f = acc / total;
    acc += c.length + 1;
    return f;
  });
  const end = audio.words?.length ? Math.min(audio.seconds, audio.words.at(-1).end + 0.4) : audio.seconds;
  return cs.map((c, i) => ({ text: c, start: i === 0 ? 0.05 : clock(pos[i]), end: i + 1 < cs.length ? clock(pos[i + 1]) : end }));
}
const captionHtml = (text) => `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family:'Inter'; src:url('file://${path.resolve('src/ui/fonts/inter-latin-wght-normal.woff2')}') format('woff2'); font-weight:100 900; }
html,body { margin:0; width:1536px; height:864px; background:transparent; }
.c { position:absolute; left:50%; bottom:22px; transform:translateX(-50%); white-space:nowrap; padding:8px 20px; border-radius:10px;
  background:rgba(10,10,10,.8); color:#f5f5f5; font:500 26px/1.35 'Inter', sans-serif; text-align:center; -webkit-font-smoothing:antialiased; }
</style></head><body><div class="c">${text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</div></body></html>`;

// ── segments ───────────────────────────────────────────────────────────────────────────────────────────────
const browser = await launch({ transparent: true });
const parts = [];
const srt = [];
const chapters = [];
let clock = 0;
let n = 0;
for (const seg of segments) {
  const audio = durations[seg.id];
  if (!audio) throw new Error(`no narration audio for ${seg.id}`);
  const L = audio.seconds + (seg.pad ?? 0.9);
  const vis = path.join(tmp, `${seg.id}.visual.mp4`);
  const v = seg.visual;
  if (v.card) {
    // A card, or a card in steps: {steps: [[variant, "phrase"], …]} shows cards/<card>.<variant>.png (the plain card
    // for a null variant) from the moment the phrase is spoken, cross-fading. Cards hold still: a slow zoom
    // (zoompan) rounds its window to whole pixels every frame and the picture visibly trembles.
    const frames = Math.ceil(L * FPS);
    const still = `scale=${W}:${H}:flags=lanczos,fps=${FPS},format=yuv420p`;
    const clock = speechClock(audio);
    const shots = [{ png: `${v.card}.png`, t: 0 }, ...(v.steps ?? []).map(([variant, phrase]) => {
      const i = seg.text.indexOf(phrase);
      if (i < 0) throw new Error(`${seg.id}: step phrase not in the text: ${phrase}`);
      return { png: variant ? `${v.card}.${variant}.png` : `${v.card}.png`, t: clock(i / seg.text.length) };
    })];
    const X = 0.3; // cross-fade
    const inputs = shots.flatMap((sh, i) => {
      const d = (shots[i + 1]?.t ?? L) - sh.t + X;
      return ['-loop', '1', '-framerate', String(FPS), '-t', d.toFixed(3), '-i', path.join(BUILD, 'cards', sh.png)];
    });
    let graph = '[0:v]settb=AVTB,fps=' + FPS + '[s0]';
    for (let i = 1; i < shots.length; i++) graph += `;[${i}:v]settb=AVTB,fps=${FPS}[i${i}];[s${i - 1}][i${i}]xfade=transition=fade:duration=${X}:offset=${(shots[i].t - X / 2).toFixed(3)}[s${i}]`;
    ff([...inputs, '-filter_complex', `${graph};[s${shots.length - 1}]${still}[v]`, '-map', '[v]', '-frames:v', String(frames), '-c:v', 'libx264', '-crf', '16', '-preset', 'medium', vis]);
  } else {
    const src = v.cast ? await castVideo(v.cast) : dashVideo(v.dash);
    const total = probe(src);
    const from = v.from ?? 0;
    const to = Math.min(v.to ?? total, total);
    const span = to - from;
    const speed = Math.max(1, span / L); // speed up long footage; never slow it down
    const shown = span / speed;
    const freeze = Math.max(0, L - shown);
    const frame = v.dash ? dashFrame(src, v.crop) : '';
    ff(['-ss', String(from), '-t', String(span), '-i', src, '-vf', `${frame}setpts=PTS/${speed.toFixed(4)},tpad=stop_mode=clone:stop_duration=${freeze.toFixed(3)},fps=${FPS},format=yuv420p`, '-t', L.toFixed(3), '-an', '-c:v', 'libx264', '-crf', '16', '-preset', 'medium', vis]);
  }
  // captions for this segment
  const cs = cues(seg.text, audio);
  const inputs = ['-i', vis, '-i', audio.file];
  let graph = `[0:v]fade=t=in:st=0:d=0.35,fade=t=out:st=${(L - 0.35).toFixed(3)}:d=0.35[v0]`;
  cs.forEach((c, i) => {
    const html = path.join(tmp, `${seg.id}.cap${i}.html`);
    const png = path.join(tmp, `${seg.id}.cap${i}.png`);
    fs.writeFileSync(html, captionHtml(c.text));
    inputs.push('-i', png);
    graph += `;[v${i}][${i + 2}:v]overlay=0:0:enable='between(t,${c.start.toFixed(3)},${c.end.toFixed(3)})'[v${i + 1}]`;
    srt.push({ start: clock + c.start, end: clock + c.end, text: c.text });
  });
  for (let i = 0; i < cs.length; i++) {
    await browser.goto(`file://${path.join(tmp, `${seg.id}.cap${i}.html`)}`, 150);
    await browser.screenshot(path.join(tmp, `${seg.id}.cap${i}.png`));
  }
  const out = path.join(tmp, `${String(n++).padStart(2, '0')}-${seg.id}.mp4`);
  ff([...inputs, '-filter_complex', `${graph};[1:a]apad,atrim=0:${L.toFixed(3)},afade=t=out:st=${(L - 0.3).toFixed(3)}:d=0.3[a]`, '-map', `[v${cs.length}]`, '-map', '[a]', '-c:v', 'libx264', '-crf', '17', '-preset', 'medium', '-r', String(FPS), '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-t', L.toFixed(3), out]);
  if (seg.chapter) chapters.push({ t: clock, title: seg.chapter });
  parts.push(out);
  clock += L;
  console.error(`${seg.id.padEnd(16)} ${L.toFixed(1)} s (${v.card ? `card ${v.card}` : v.cast ? `terminal ${v.cast}` : `dashboard ${v.dash}`})`);
}
await browser.close();

const list = path.join(tmp, 'concat.txt');
fs.writeFileSync(list, parts.map((p) => `file '${p}'`).join('\n') + '\n');
const joined = path.join(tmp, 'joined.mp4');
ff(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', joined]);
ff(['-i', joined, '-c:v', 'copy', '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', OUT]);
const ts = (s) => {
  const ms = Math.round(s * 1000);
  const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
  const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
  const sec = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
  return `${h}:${m}:${sec},${String(ms % 1000).padStart(3, '0')}`;
};
fs.writeFileSync(OUT.replace(/\.mp4$/, '.srt'), srt.map((c, i) => `${i + 1}\n${ts(c.start)} --> ${ts(c.end)}\n${c.text}\n`).join('\n'));
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
fs.writeFileSync(OUT.replace(/\.mp4$/, '.chapters.txt'), chapters.map((c) => `${mmss(c.t)} ${c.title}`).join('\n') + '\n');
console.error(`\n${OUT}: ${clock.toFixed(1)} s (${mmss(clock)})`);
