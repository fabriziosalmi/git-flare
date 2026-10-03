#!/usr/bin/env node
// Create an Artifacts repository and push a fixture as its first commit on main.
//
//   node scripts/seed-repo.mjs <name> [--namespace gf-staging] [--fixture fixtures/tiny-lib]
//
// Uses the wrangler login of this machine. The write token lives only in this process and reaches git
// through environment variables (never argv or URLs); it expires after 10 minutes.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const arg = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const name = args[0];
const ns = arg('namespace', 'gf-staging');
const fixture = path.resolve(arg('fixture', new URL('../fixtures/tiny-lib', import.meta.url).pathname));
if (!name || name.startsWith('--')) {
  console.error('usage: node scripts/seed-repo.mjs <name> [--namespace gf-staging] [--fixture fixtures/tiny-lib]');
  process.exit(2);
}

const env = { ...process.env };
delete env.XDG_CONFIG_HOME; // wrangler keeps its login under the default config home
const wrangler = (argv) => execFileSync('npx', ['wrangler', ...argv], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

wrangler(['artifacts', 'repos', 'create', name, '--namespace', ns]);
const repo = JSON.parse(wrangler(['artifacts', 'repos', 'get', name, '--namespace', ns, '--json']));
const remote = repo.remote;
const tok = JSON.parse(wrangler(['artifacts', 'repos', 'issue-token', name, '--namespace', ns, '--scope', 'write', '--ttl', '600', '--json']));
const token = tok.plaintext;
if (!remote || !token) throw new Error('unexpected wrangler output (no remote or token)');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-seed-'));
fs.cpSync(fixture, dir, { recursive: true });
const git = (argv) =>
  execFileSync('git', argv, {
    cwd: dir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}` },
  });
git(['init', '--quiet', '-b', 'main']);
git(['add', '-A']);
git(['-c', 'user.name=git-flare seed', '-c', 'user.email=seed@git-flare.invalid', 'commit', '--quiet', '-m', `seed ${path.basename(fixture)}`]);
git(['push', '--quiet', remote, 'HEAD:refs/heads/main']);
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
fs.rmSync(dir, { recursive: true, force: true });
console.log(JSON.stringify({ repo: name, namespace: ns, main: sha }));
