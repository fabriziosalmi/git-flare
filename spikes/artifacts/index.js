// Throwaway spike worker: exercises the Artifacts binding and times each call.
const timed = async (fn) => { const t0 = Date.now(); try { const v = await fn(); return { ok: true, ms: Date.now() - t0, v }; } catch (e) { return { ok: false, ms: Date.now() - t0, err: { name: e?.name, message: String(e?.message ?? e), code: e?.code } }; } };
export default {
  async fetch(req, env) {
    const u = new URL(req.url); const q = (k) => u.searchParams.get(k); const A = env.ARTIFACTS;
    const body = req.method === 'POST' ? await req.text() : '';
    const r = (x) => Response.json(x);
    switch (u.pathname) {
      case '/get': return r(await timed(async () => { const h = await A.get(q('repo')); return Object.keys(h ?? {}); }));
      case '/info': return r(await timed(async () => (await A.get(q('repo'))).info()));
      case '/fork': return r(await timed(async () => (await A.get(q('repo'))).fork(q('name'), { defaultBranchOnly: true, description: 'spike fork' })));
      case '/token': return r(await timed(async () => (await A.get(q('repo'))).createToken(q('scope'), Number(q('ttl')))));
      case '/tokens': return r(await timed(async () => (await A.get(q('repo'))).listTokens()));
      case '/revoke': return r(await timed(async () => (await A.get(q('repo'))).revokeToken(body.trim())));
      case '/log': return r(await timed(async () => (await A.get(q('repo'))).log({ ref: q('ref') || undefined, limit: Number(q('limit') || 20) })));
      case '/commit': return r(await timed(async () => (await A.get(q('repo'))).readCommit(q('hash'))));
      case '/tree': return r(await timed(async () => (await A.get(q('repo'))).readTree(q('hash'))));
      case '/blob': return r(await timed(async () => { const b = await (await A.get(q('repo'))).readBlob(q('hash')); return b ? { size: b.size, type: b.type, text: (await b.text()).slice(0, 200) } : null; }));
      case '/file': return r(await timed(async () => { const b = await (await A.get(q('repo'))).readFile({ ref: q('ref'), path: q('path') }); return b ? { size: b.size, type: b.type, text: (await b.text()).slice(0, 200) } : null; }));
      case '/delete': return r(await timed(async () => A.delete(q('repo'))));
    }
    return new Response('not found', { status: 404 });
  },
};
