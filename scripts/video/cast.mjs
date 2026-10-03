#!/usr/bin/env node
// Record a terminal session for the demo video as an asciicast v2 file, from a session script:
//   # comment          shown dimmed
//   $ command          typed on screen, then really executed (sh -c); its output is recorded with real timing
//   @sleep 2           pause
// Output is only colored (keywords), never changed. Commands run with this process's environment, so
// secrets stay in variables and never appear on screen.
//
//   node scripts/video/cast.mjs --session session.txt --out demo.cast [--cols 112] [--rows 30]
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const args = process.argv.slice(2);
const arg = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const SESSION = arg('session');
const OUT = arg('out');
const COLS = Number(arg('cols', '112'));
const ROWS = Number(arg('rows', '30'));
if (!SESSION || !OUT) {
  console.error('usage: node scripts/video/cast.mjs --session <file> --out <file.cast> [--cols N] [--rows N]');
  process.exit(2);
}

const t0 = Date.now();
const events = [];
const emit = (s) => events.push([(Date.now() - t0) / 1000, 'o', s]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const C = { dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', blue: '\x1b[34m', orange: '\x1b[38;5;208m', reset: '\x1b[0m' };

function colorize(line) {
  return line
    .replace(/^(\[\d\d:\d\d:\d\d\])/, `${C.dim}$1${C.reset}`)
    .replace(/\b(merged|approve[ds]?|passed|pass|ok|restored|current)\b/g, `${C.green}$1${C.reset}`)
    .replace(/(?<!\b0 )\b(rejected|reject|FAIL(?:ED)?|ALERT|foreign|stale|conflict)\b/g, `${C.red}$1${C.reset}`)
    .replace(/\b(evaluating|queued|retrying|abstained)\b/g, `${C.yellow}$1${C.reset}`)
    .replace(/\b(p\d_[0-9a-f]{12})\b/g, `${C.blue}$1${C.reset}`);
}

async function run(command) {
  // typed prompt
  emit(`${C.orange}${C.bold}$${C.reset} `);
  for (const ch of command) {
    emit(ch);
    await sleep(18 + Math.random() * 22);
  }
  await sleep(250);
  emit('\r\n');
  await new Promise((resolve) => {
    const p = spawn('sh', ['-c', command], { env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let pending = '';
    const onData = (d) => {
      pending += d.toString();
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const l of lines) emit(colorize(l) + '\r\n');
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.on('close', (code) => {
      if (pending) emit(colorize(pending) + '\r\n');
      if (code !== 0) emit(`${C.red}(exit ${code})${C.reset}\r\n`);
      resolve();
    });
  });
}

for (const raw of fs.readFileSync(SESSION, 'utf8').split('\n')) {
  const line = raw.trimEnd();
  if (!line) continue;
  if (line.startsWith('@sleep ')) await sleep(Number(line.slice(7)) * 1000);
  else if (line.startsWith('# ')) {
    emit(`${C.dim}${line}${C.reset}\r\n`);
    await sleep(900);
  } else if (line.startsWith('$ ')) await run(line.slice(2));
}
await sleep(1500);
const header = { version: 2, width: COLS, height: ROWS, timestamp: Math.floor(t0 / 1000), env: { TERM: 'xterm-256color', SHELL: '/bin/zsh' } };
fs.writeFileSync(OUT, [JSON.stringify(header), ...events.map((e) => JSON.stringify(e))].join('\n') + '\n');
console.error(`recorded ${events.length} events, ${((Date.now() - t0) / 1000).toFixed(1)} s → ${OUT}`);
