// Minimal ustar writer: the merge queue ships the composed tree to the test container as a tar stream on
// stdin, so the container needs no network and never sees a repository credential.

export interface TarEntry {
  path: string;
  /** git mode: 100644, 100755 or 120000 (symlink; content is the link target) */
  mode: string;
  content: Uint8Array;
}

const enc = new TextEncoder();

function octal(n: number, width: number): string {
  return n.toString(8).padStart(width - 1, '0') + '\0';
}

function splitName(path: string): { name: string; prefix: string } {
  if (enc.encode(path).length <= 100) return { name: path, prefix: '' };
  const i = path.lastIndexOf('/', 155);
  if (i <= 0 || enc.encode(path.slice(i + 1)).length > 100 || enc.encode(path.slice(0, i)).length > 155) throw new Error(`path too long for tar: ${path}`);
  return { name: path.slice(i + 1), prefix: path.slice(0, i) };
}

function header(e: TarEntry): Uint8Array {
  const h = new Uint8Array(512);
  const put = (s: string, off: number, len: number) => h.set(enc.encode(s).subarray(0, len), off);
  const { name, prefix } = splitName(e.path);
  const symlink = e.mode === '120000';
  put(name, 0, 100);
  put(e.mode === '100755' ? '0000755\0' : '0000644\0', 100, 8);
  put('0000000\0', 108, 8);
  put('0000000\0', 116, 8);
  put(octal(symlink ? 0 : e.content.length, 12), 124, 12);
  put(octal(0, 12), 136, 12);
  put('        ', 148, 8); // checksum placeholder (spaces)
  put(symlink ? '2' : '0', 156, 1);
  if (symlink) put(new TextDecoder().decode(e.content), 157, 100);
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  put(prefix, 345, 155);
  let sum = 0;
  for (const b of h) sum += b;
  put(octal(sum, 7) + ' ', 148, 8);
  return h;
}

export function writeTar(entries: readonly TarEntry[]): Uint8Array {
  const parts: Uint8Array[] = [];
  let total = 0;
  for (const e of entries) {
    if (e.path.startsWith('/') || e.path.split('/').some((p) => p === '..' || p === '')) throw new Error(`unsafe tar path ${e.path}`);
    const h = header(e);
    parts.push(h);
    total += 512;
    if (e.mode !== '120000') {
      parts.push(e.content);
      const pad = (512 - (e.content.length % 512)) % 512;
      if (pad) parts.push(new Uint8Array(pad));
      total += e.content.length + pad;
    }
  }
  parts.push(new Uint8Array(1024));
  total += 1024;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
