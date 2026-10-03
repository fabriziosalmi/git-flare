// Agent identity. Keys are HMAC-SHA256 signed by the platform (secret AUTH_SECRET), verified in the
// Worker without any lookup: gfk1.<base64url(payload)>.<base64url(signature)>.
// The model family is fixed at registration by the operator, never declared per request.

export type AgentRole = 'worker' | 'reviewer';

export interface AgentIdentity {
  agentId: string;
  role: AgentRole;
  family: string;
  /** unix seconds the key was issued (set by verifyAgentKey; used by revocation) */
  issuedAt?: number;
}

interface KeyPayload {
  v: 1;
  sub: string;
  role: AgentRole;
  fam: string;
  iat: number;
  exp: number;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function issueAgentKey(
  secret: string,
  identity: AgentIdentity,
  nowMs: number,
  ttlMs: number
): Promise<string> {
  const payload: KeyPayload = {
    v: 1,
    sub: identity.agentId,
    role: identity.role,
    fam: identity.family,
    iat: Math.floor(nowMs / 1000),
    exp: Math.floor((nowMs + ttlMs) / 1000),
  };
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(`gfk1.${body}`)));
  return `gfk1.${body}.${b64url(sig)}`;
}

export async function verifyAgentKey(secret: string, key: string, nowMs: number): Promise<AgentIdentity | null> {
  const parts = key.split('.');
  if (parts.length !== 3 || parts[0] !== 'gfk1') return null;
  let sig: Uint8Array;
  try {
    sig = fromB64url(parts[2]);
  } catch {
    return null;
  }
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), sig, enc.encode(`gfk1.${parts[1]}`));
  if (!ok) return null;
  let payload: KeyPayload;
  try {
    payload = JSON.parse(dec.decode(fromB64url(parts[1])));
  } catch {
    return null;
  }
  if (payload.v !== 1 || (payload.role !== 'worker' && payload.role !== 'reviewer')) return null;
  if (typeof payload.exp !== 'number' || payload.exp * 1000 <= nowMs) return null;
  return { agentId: payload.sub, role: payload.role, family: payload.fam, issuedAt: payload.iat };
}

/** Constant-time comparison of two secrets (hash both, compare digests without early exit). */
export async function secretEquals(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const x = new Uint8Array(da);
  const y = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export function bearer(request: Request): string | null {
  const h = request.headers.get('Authorization');
  if (!h || !h.startsWith('Bearer ')) return null;
  const v = h.slice(7).trim();
  return v.length > 0 ? v : null;
}
