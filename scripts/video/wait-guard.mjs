#!/usr/bin/env node
// For the demo video: poll the repository status until the main guard raises an alert; print how long it took.
// Usage: GF_BASE=<url> node scripts/video/wait-guard.mjs <repo> [--timeout 60]
const repo = process.argv[2];
const base = process.env.GF_BASE;
const limit = Number(process.argv.includes('--timeout') ? process.argv[process.argv.indexOf('--timeout') + 1] : 60) * 1000;
const t0 = Date.now();
process.stdout.write('waiting for the main guard');
for (;;) {
  const s = await (await fetch(`${base}/api/repos/${repo}/status`)).json();
  if (s.guard?.state === 'alert') {
    console.log(`\nALERT after ${((Date.now() - t0) / 1000).toFixed(1)} s: ${s.guard.alert.kind}: ${s.guard.alert.detail}`);
    if (s.queue?.lastError) console.log(`merge queue stopped: ${s.queue.lastError.slice(0, 90)}`);
    break;
  }
  if (Date.now() - t0 > limit) {
    console.log('\nno alert within the time limit');
    process.exit(1);
  }
  process.stdout.write('.');
  await new Promise((r) => setTimeout(r, 1000));
}
