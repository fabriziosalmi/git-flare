// Fast-forward merge over the git smart HTTP protocol using only fetch(): the pack negotiated from the
// fork's upload-pack (want = fork head, have = main head) is relayed unchanged to main's receive-pack
// with a compare-and-swap ref update (old = expected main head). No git client, no filesystem.
// Verified against Cloudflare Artifacts on 2026-10-02 (docs/spikes/artifacts-2026-10-02.md).

const enc = new TextEncoder();
const dec = new TextDecoder();
const FLUSH = enc.encode('0000');

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function pktLine(s: string): Uint8Array {
  const body = enc.encode(s);
  return concatBytes([enc.encode((body.length + 4).toString(16).padStart(4, '0')), body]);
}

/** Parse pkt-lines from the start of buf. null entries are flush-pkts. Stops before "PACK" if asked. */
export function readPktLines(buf: Uint8Array, stopAtPack = false): { lines: Array<Uint8Array | null>; rest: Uint8Array } {
  const lines: Array<Uint8Array | null> = [];
  let o = 0;
  while (o + 4 <= buf.length) {
    const head = dec.decode(buf.subarray(o, o + 4));
    if (stopAtPack && head === 'PACK') break;
    const len = parseInt(head, 16);
    if (!/^[0-9a-f]{4}$/.test(head) || Number.isNaN(len) || (len > 0 && len < 4) || o + len > buf.length) {
      throw new Error(`malformed pkt-line at offset ${o}`);
    }
    if (len === 0) {
      lines.push(null);
      o += 4;
      continue;
    }
    lines.push(buf.subarray(o + 4, o + len));
    o += len;
  }
  return { lines, rest: buf.subarray(o) };
}

async function sha1Hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-1', bytes));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function packChecksumValid(pack: Uint8Array): Promise<boolean> {
  if (pack.length < 32 || dec.decode(pack.subarray(0, 4)) !== 'PACK') return false;
  const trailer = [...pack.subarray(pack.length - 20)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return (await sha1Hex(pack.subarray(0, pack.length - 20))) === trailer;
}

/**
 * Extract the packfile from an upload-pack response. Artifacts appends a flush-pkt after the pack even
 * without side-band; it is stripped only when the SHA-1 trailer validates without it. An unverifiable
 * pack is never forwarded.
 */
export async function extractPack(body: Uint8Array): Promise<{ pack: Uint8Array; acks: string[]; strippedTrailingFlush: boolean }> {
  const { lines, rest } = readPktLines(body, true);
  const acks = lines.filter((l): l is Uint8Array => l !== null).map((l) => dec.decode(l).trim());
  let pack = rest;
  let strippedTrailingFlush = false;
  if (!(await packChecksumValid(pack))) {
    const tail = dec.decode(pack.subarray(pack.length - 4));
    if (tail === '0000' && (await packChecksumValid(pack.subarray(0, pack.length - 4)))) {
      pack = pack.subarray(0, pack.length - 4);
      strippedTrailingFlush = true;
    } else {
      throw new Error(`upload-pack returned no valid pack (negotiation: ${acks.join(' | ') || 'none'})`);
    }
  }
  return { pack, acks, strippedTrailingFlush };
}

/** Parse a receive-pack report (plain or side-band-64k). */
export function parseReport(body: Uint8Array): string[] {
  const out: string[] = [];
  for (const l of readPktLines(body).lines) {
    if (!l) continue;
    if (l[0] === 1) {
      for (const inner of readPktLines(l.subarray(1)).lines) if (inner) out.push(dec.decode(inner).trim());
    } else if (l[0] === 2 || l[0] === 3) {
      out.push(`band${l[0]}: ${dec.decode(l.subarray(1)).trim()}`);
    } else {
      out.push(dec.decode(l).trim());
    }
  }
  return out;
}

export type RelayResult =
  | { ok: true; objects: number; packBytes: number; ms: { uploadPack: number; receivePack: number } }
  | { ok: false; reason: 'stale' | 'error'; detail: string };

export async function relayFastForward(opts: {
  forkUrl: string;
  forkReadToken: string;
  mainUrl: string;
  mainWriteToken: string;
  expectedOld: string;
  newSha: string;
  ref?: string;
  fetchImpl?: typeof fetch;
}): Promise<RelayResult> {
  const f = opts.fetchImpl ?? fetch;
  const ref = opts.ref ?? 'refs/heads/main';
  const t0 = Date.now();
  const up = await f(`${opts.forkUrl}/git-upload-pack`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.forkReadToken}`,
      'Content-Type': 'application/x-git-upload-pack-request',
      Accept: 'application/x-git-upload-pack-result',
    },
    body: concatBytes([
      pktLine(`want ${opts.newSha} ofs-delta no-progress\n`),
      FLUSH,
      pktLine(`have ${opts.expectedOld}\n`),
      pktLine('done\n'),
    ]),
  });
  if (!up.ok) return { ok: false, reason: 'error', detail: `upload-pack HTTP ${up.status}` };
  const { pack } = await extractPack(new Uint8Array(await up.arrayBuffer()));
  const objects = new DataView(pack.buffer, pack.byteOffset).getUint32(8);
  const t1 = Date.now();

  const res = await receivePack({ mainUrl: opts.mainUrl, token: opts.mainWriteToken, oldSha: opts.expectedOld, newSha: opts.newSha, ref, pack, fetchImpl: f });
  const t2 = Date.now();
  if (res.ok) return { ok: true, objects, packBytes: pack.length, ms: { uploadPack: t1 - t0, receivePack: t2 - t1 } };
  return res;
}

/** Update one ref with a compare-and-swap (old -> new), sending `pack` with the objects main lacks. */
export async function receivePack(opts: {
  mainUrl: string;
  token: string;
  oldSha: string;
  newSha: string;
  ref: string;
  pack: Uint8Array;
  fetchImpl?: typeof fetch;
}): Promise<{ ok: true } | { ok: false; reason: 'stale' | 'error'; detail: string }> {
  const f = opts.fetchImpl ?? fetch;
  const rp = await f(`${opts.mainUrl}/git-receive-pack`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.token}`,
      'Content-Type': 'application/x-git-receive-pack-request',
      Accept: 'application/x-git-receive-pack-result',
    },
    body: concatBytes([pktLine(`${opts.oldSha} ${opts.newSha} ${opts.ref}\0report-status ofs-delta\n`), FLUSH, opts.pack]),
  });
  const report = rp.ok ? parseReport(new Uint8Array(await rp.arrayBuffer())) : [`HTTP ${rp.status}`];
  if (report.includes('unpack ok') && report.includes(`ok ${opts.ref}`)) return { ok: true };
  const ng = report.find((l) => l.startsWith(`ng ${opts.ref}`));
  if (ng && /stale|fetch first|non-fast-forward/i.test(ng)) return { ok: false, reason: 'stale', detail: ng };
  return { ok: false, reason: 'error', detail: report.join(' | ') };
}

const ZERO = '0'.repeat(40);

/**
 * Delete refs with one receive-pack request (no pack: deletions carry no objects). Current values come from the
 * receive-pack ref advertisement; refs that do not exist are reported as missing, not as errors.
 */
export async function deleteRefs(opts: { url: string; token: string; refs: readonly string[]; fetchImpl?: typeof fetch }): Promise<{ deleted: string[]; missing: string[]; failed: string[] }> {
  const f = opts.fetchImpl ?? fetch;
  const auth = { Authorization: `Bearer ${opts.token}` };
  const adv = await f(`${opts.url}/info/refs?service=git-receive-pack`, { headers: auth });
  if (!adv.ok) throw new Error(`receive-pack advertisement HTTP ${adv.status}`);
  const current = new Map<string, string>();
  for (const l of readPktLines(new Uint8Array(await adv.arrayBuffer())).lines) {
    if (!l) continue;
    const m = /^([0-9a-f]{40}) ([^\0\n]+)/.exec(dec.decode(l));
    if (m) current.set(m[2], m[1]);
  }
  const present = opts.refs.filter((r) => current.has(r));
  const missing = opts.refs.filter((r) => !current.has(r));
  if (present.length === 0) return { deleted: [], missing, failed: [] };
  const commands = present.map((r, i) => pktLine(`${current.get(r)} ${ZERO} ${r}${i === 0 ? '\0report-status delete-refs' : ''}\n`));
  const rp = await f(`${opts.url}/git-receive-pack`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/x-git-receive-pack-request', Accept: 'application/x-git-receive-pack-result' },
    body: concatBytes([...commands, FLUSH]),
  });
  const report = rp.ok ? parseReport(new Uint8Array(await rp.arrayBuffer())) : [];
  const deleted = present.filter((r) => report.includes(`ok ${r}`));
  return { deleted, missing, failed: present.filter((r) => !deleted.includes(r)) };
}
