#!/usr/bin/env node
// Record one scene of the demo video: a terminal session (scripts/video/cast.mjs) and, at the same time, a
// screencast of the live dashboard in headless Chrome. Both are real: the session runs against the deployment.
//
//   GF_BASE=<url> node scripts/video/record.mjs --name demo --session <file> --repo <repo> --out <dir> [--tail 20]
//     [--focus <task id> --focus-sec 10]
//
// --focus scrolls the dashboard to that task's patch at the end (its reviews and their reasoning), for the camera.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { launch } from './chrome.mjs';

const args = process.argv.slice(2);
const arg = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const NAME = arg('name');
const SESSION = arg('session');
const REPO = arg('repo');
const OUT = arg('out');
const TAIL = Number(arg('tail', '20'));
const BASE = process.env.GF_BASE;
if (!NAME || !SESSION || !REPO || !OUT || !BASE) {
  console.error('usage: GF_BASE=<url> node scripts/video/record.mjs --name <scene> --session <file> --repo <repo> --out <dir> [--tail s]');
  process.exit(2);
}
const here = path.dirname(new URL(import.meta.url).pathname);
const FOCUS = arg('focus');
const browser = await launch({ scale: 2 }); // 3072x1728 frames: crisp after scaling to 1080p, and room to crop
await browser.goto(`${BASE}/?repo=${encodeURIComponent(REPO)}`, 3000);
// The session file may say {repo}; the recorded session names the real repository.
const session = path.join(OUT, `${NAME}.session.txt`);
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(session, fs.readFileSync(SESSION, 'utf8').replaceAll('{repo}', REPO));
const cast = await browser.screencast(path.join(OUT, `${NAME}-dash`));
const t0 = Date.now();
await new Promise((resolve, reject) => {
  const p = spawn('node', [path.join(here, 'cast.mjs'), '--session', session, '--out', path.join(OUT, `${NAME}.cast`), '--cols', arg('cols', '108'), '--rows', arg('rows', '27')], { stdio: ['ignore', 'inherit', 'inherit'] });
  p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`cast exited ${c}`))));
});
const sessionSec = (Date.now() - t0) / 1000;
await new Promise((r) => setTimeout(r, TAIL * 1000));
let focusAt = null;
if (FOCUS) {
  focusAt = (Date.now() - t0) / 1000;
  const found = await browser.evaluate(`(() => {
    const row = [...document.querySelectorAll('#patches .row')].find((r) => r.firstChild?.textContent.includes(' · ${FOCUS} · '));
    if (!row) return false;
    window.scrollTo({ top: row.getBoundingClientRect().top + window.scrollY - 16, behavior: 'instant' });
    return true;
  })()`);
  if (!found) console.error(`${NAME}: no patch of task ${FOCUS} on the dashboard`);
  await new Promise((r) => setTimeout(r, Number(arg('focus-sec', '10')) * 1000));
}
const res = await cast.stop();
await browser.close();
console.error(`${NAME}: session ${sessionSec.toFixed(1)} s, dashboard ${res.frames} frames over ${res.seconds.toFixed(1)} s${focusAt === null ? '' : `, focus on ${FOCUS} from ${focusAt.toFixed(1)} s`}`);
