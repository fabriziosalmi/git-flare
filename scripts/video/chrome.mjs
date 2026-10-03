// Headless Chrome over the DevTools protocol, for the demo video: screenshots of HTML cards and screencasts of
// the live dashboard. No dependencies: Chrome's own binary and Node's global WebSocket.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export async function launch({ width = 1536, height = 864, scale = 1.25, dark = true, transparent = false } = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-chrome-'));
  const proc = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--disable-gpu', `--window-size=${width},${height}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    proc.stderr.on('data', (d) => {
      buf += d;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
      if (m) resolve(m[1]);
    });
    proc.on('exit', (c) => reject(new Error(`chrome exited (${c}): ${buf.slice(-400)}`)));
  });
  const port = new URL(wsUrl).port;
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message}`));
      else resolve(msg.result);
    } else if (msg.method) for (const fn of listeners.get(msg.method) ?? []) fn(msg.params);
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const i = ++id;
      pending.set(i, { resolve, reject });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const on = (method, fn) => listeners.set(method, [...(listeners.get(method) ?? []), fn]);
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] });
  if (transparent) await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });

  async function goto(url, settleMs = 1500) {
    const loaded = new Promise((r) => on('Page.loadEventFired', r));
    await send('Page.navigate', { url });
    await loaded;
    await new Promise((r) => setTimeout(r, settleMs));
  }
  async function screenshot(out) {
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(out, Buffer.from(data, 'base64'));
  }
  async function evaluate(expression) {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    return r.result?.value;
  }
  /**
   * Record full-resolution screenshots (JPEG) at a fixed interval until stop() is called. Page.startScreencast
   * would deliver frames at CSS-pixel size only; captureScreenshot honours the device scale factor.
   */
  async function screencast(dir, { everyMs = 500 } = {}) {
    fs.mkdirSync(dir, { recursive: true });
    const frames = [];
    let running = true;
    const loop = (async () => {
      while (running) {
        const t = Date.now() / 1000;
        const { data } = await send('Page.captureScreenshot', { format: 'jpeg', quality: 90 });
        const file = path.join(dir, `f${String(frames.length).padStart(6, '0')}.jpg`);
        fs.writeFileSync(file, Buffer.from(data, 'base64'));
        frames.push({ file, t });
        const wait = everyMs - (Date.now() / 1000 - t) * 1000;
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }
    })();
    return {
      async stop() {
        running = false;
        await loop;
        const end = Date.now() / 1000;
        // ffmpeg concat list: each frame lasts until the next one
        const lines = [];
        frames.forEach((f, i) => {
          const next = frames[i + 1]?.t ?? end;
          lines.push(`file '${f.file}'`, `duration ${Math.max(0.04, next - f.t).toFixed(3)}`);
        });
        if (frames.length) lines.push(`file '${frames.at(-1).file}'`);
        fs.writeFileSync(path.join(dir, 'frames.txt'), lines.join('\n') + '\n');
        return { frames: frames.length, seconds: frames.length ? end - frames[0].t : 0, list: path.join(dir, 'frames.txt') };
      },
    };
  }
  async function close() {
    ws.close();
    const exited = new Promise((r) => proc.once('exit', r));
    proc.kill('SIGTERM');
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  return { goto, screenshot, screencast, evaluate, send, close };
}
