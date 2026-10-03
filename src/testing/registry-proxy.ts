// Package registry access for the test container. The container runs with internet access
// disabled; the only name it can reach is REGISTRY_HOST, which Cloudflare routes to this Worker entrypoint
// (Container.interceptOutboundHttp). It forwards read-only requests to the public npm registry and nothing
// else: no other host, no writes, no credentials. Install commands are declared in the protected
// `.gitflare/gates.json` and run with --ignore-scripts, so no package code runs while the registry is reachable.
import { WorkerEntrypoint } from 'cloudflare:workers';

/** Plain-HTTP name the container uses as its npm registry (no TLS interception, no CA to trust). */
export const REGISTRY_HOST = 'registry.npm.internal';
export const UPSTREAM = 'https://registry.npmjs.org';

/** The upstream request for an intercepted one, or the response refusing it. */
export function registryUpstream(request: Request): Request | Response {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('registry proxy: read-only\n', { status: 405 });
  const url = new URL(request.url);
  if (url.hostname !== REGISTRY_HOST) return new Response('registry proxy: unknown host\n', { status: 403 });
  if (url.pathname.includes('..') || url.username || url.password) return new Response('registry proxy: bad path\n', { status: 400 });
  const headers = new Headers();
  for (const h of ['accept', 'accept-encoding', 'npm-command', 'user-agent']) {
    const v = request.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new Request(`${UPSTREAM}${url.pathname}${url.search}`, { method: request.method, headers, redirect: 'follow' });
}

export class RegistryProxy extends WorkerEntrypoint {
  async fetch(request: Request): Promise<Response> {
    const up = registryUpstream(request);
    if (up instanceof Response) return up;
    const res = await fetch(up);
    // npm rewrites tarball URLs found in metadata to the configured registry (replace-registry-host), so the
    // body can be passed through unchanged.
    return new Response(res.body, { status: res.status, headers: res.headers });
  }
}
