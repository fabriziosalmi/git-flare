// Minimal Cloudflare REST client for operator scripts. Credentials come from the local `wrangler login`
// (`wrangler auth token`), live only in this process and are never printed.
import { execFileSync } from 'node:child_process';

let cached = null;

function credentials() {
  if (cached) return cached;
  const env = { ...process.env };
  delete env.XDG_CONFIG_HOME; // wrangler keeps its login under the default config home
  const run = (args) => execFileSync('npx', ['wrangler', ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const { token } = JSON.parse(run(['auth', 'token', '--json']));
  const who = run(['whoami', '--json']);
  const accountId = JSON.parse(who).accounts?.[0]?.id ?? JSON.parse(who).account?.id;
  if (!token || !accountId) throw new Error('could not read wrangler credentials (run `npx wrangler login`)');
  cached = { token, accountId };
  return cached;
}

export async function cfApi(method, path, body) {
  const { token, accountId } = credentials();
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({ success: false, errors: [{ message: `HTTP ${res.status}` }] }));
  if (!json.success) throw new Error(`${method} ${path}: ${(json.errors ?? []).map((e) => e.message).join('; ') || res.status}`);
  return json.result;
}

/** Like cfApi, for endpoints that answer with bytes (screenshots, audio). */
export async function cfRaw(method, path, body) {
  const { token, accountId } = credentials();
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${new TextDecoder().decode(bytes.subarray(0, 300))}`);
  return { bytes, type: res.headers.get('content-type') ?? '' };
}
