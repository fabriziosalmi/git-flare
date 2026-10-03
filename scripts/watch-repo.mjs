#!/usr/bin/env node
// Subscribe a repository's main (and its read replicas) to the platform's events queue, so the main guard
// sees every push and every token minted on it. Runs with the operator's `wrangler login`; the Worker itself
// holds no account credentials.
//
//   node scripts/watch-repo.mjs <repo> [--queue gf-events-staging] [--namespace gf-staging] [--mirrors N]
//   node scripts/watch-repo.mjs <repo> --remove [--queue ...]
//
// Event subscriptions are per repository (a wildcard repo name is accepted by the API but matches nothing;
// verified 2026-10-02), so agent forks are not watched: only main and its mirrors can move main.
import { cfApi } from './cf-api.mjs';

const args = process.argv.slice(2);
const arg = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const repo = args[0];
const queueName = arg('queue', 'gf-events-staging');
const namespace = arg('namespace', 'gf-staging');
const mirrors = Number(arg('mirrors', '0'));
if (!repo || repo.startsWith('--')) {
  console.error('usage: node scripts/watch-repo.mjs <repo> [--queue <name>] [--namespace <ns>] [--mirrors N] [--remove]');
  process.exit(2);
}
const queue = (await cfApi('GET', '/queues')).find((q) => q.queue_name === queueName);
if (!queue) throw new Error(`queue ${queueName} not found (npx wrangler queues create ${queueName})`);
const names = [repo, ...Array.from({ length: mirrors }, (_, i) => `${repo}--m${i}`)];
const prefix = `gf-guard ${namespace}/`;

const existing = (await cfApi('GET', '/event_subscriptions/subscriptions?per_page=100')).filter((s) => s.name?.startsWith(prefix) && s.destination?.queue_id === queue.queue_id);
if (args.includes('--remove')) {
  for (const s of existing.filter((s) => names.includes(s.source?.repo_name))) {
    await cfApi('DELETE', `/event_subscriptions/subscriptions/${s.id}`);
    console.log(`removed ${s.name}`);
  }
  process.exit(0);
}
for (const name of names) {
  if (existing.some((s) => s.source?.repo_name === name)) {
    console.log(`already watched: ${name}`);
    continue;
  }
  const s = await cfApi('POST', '/event_subscriptions/subscriptions', {
    name: `${prefix}${name}`,
    enabled: true,
    source: { type: 'artifacts.repo', namespace, repo_name: name },
    destination: { type: 'queues.queue', queue_id: queue.queue_id },
    events: ['pushed', 'token.created', 'cloned', 'fetched'],
  });
  console.log(`watching ${name} (subscription ${s.id})`);
}
