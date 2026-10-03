// Input validation at the HTTP edge. Every field of every route is checked before any RPC.

export class ValidationError extends Error {
  constructor(public readonly field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = 'ValidationError';
  }
}

export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const REPO_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
export const SHA_RE = /^[0-9a-f]{40}$/;

type Obj = Record<string, unknown>;

export function asObject(v: unknown, field = 'body'): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new ValidationError(field, 'must be a JSON object');
  return v as Obj;
}

export function str(o: Obj, field: string, opts: { max: number; re?: RegExp; optional?: boolean; min?: number }): string {
  const v = o[field];
  if (v === undefined && opts.optional) return '';
  if (typeof v !== 'string') throw new ValidationError(field, 'must be a string');
  if (v.length < (opts.min ?? 1)) throw new ValidationError(field, `must be at least ${opts.min ?? 1} characters`);
  if (v.length > opts.max) throw new ValidationError(field, `must be at most ${opts.max} characters`);
  if (opts.re && !opts.re.test(v)) throw new ValidationError(field, `must match ${opts.re}`);
  return v;
}

export function int(o: Obj, field: string, opts: { min: number; max: number; optional?: boolean; fallback?: number }): number {
  const v = o[field];
  if (v === undefined && opts.optional) {
    if (opts.fallback === undefined) throw new ValidationError(field, 'is required');
    return opts.fallback;
  }
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new ValidationError(field, 'must be an integer');
  if (v < opts.min || v > opts.max) throw new ValidationError(field, `must be in ${opts.min}..${opts.max}`);
  return v;
}

export function bool(o: Obj, field: string, fallback: boolean): boolean {
  const v = o[field];
  if (v === undefined) return fallback;
  if (typeof v !== 'boolean') throw new ValidationError(field, 'must be a boolean');
  return v;
}

export function rejectUnknown(o: Obj, allowed: readonly string[]): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new ValidationError(k, 'unknown field');
}

export async function readJson(request: Request, maxBytes: number): Promise<Obj> {
  const len = Number(request.headers.get('Content-Length') ?? '0');
  if (len > maxBytes) throw new ValidationError('body', `exceeds ${maxBytes} bytes`);
  // Read at most maxBytes even when the length is not declared (chunked): never buffer an unbounded body.
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body?.getReader();
  for (;;) {
    const { done, value } = reader ? await reader.read() : { done: true, value: undefined };
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader!.cancel();
      throw new ValidationError('body', `exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  if (text.trim() === '') return {};
  try {
    return asObject(JSON.parse(text));
  } catch (e) {
    if (e instanceof ValidationError) throw e;
    throw new ValidationError('body', 'is not valid JSON');
  }
}
