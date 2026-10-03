// Platform gates, executed by the coordinator on the server-computed change. Agents cannot declare gate
// results. These are STATIC checks: they catch accidents and obvious leaks, they do not prove the code
// works. Executing the project's own build and tests (Cloudflare Sandbox) is the next gate tier.
import type { FileChange } from './epistemic/changeset.js';
import type { GateResult } from './epistemic/policy.js';

export const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/],
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['openai-key', /\bsk-(proj-)?[A-Za-z0-9]{32,}/],
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['artifacts-token', /\bart_v\d+_[A-Za-z0-9_]{20,}/],
];

// Heuristic only: trivially bypassable by obfuscation; it blocks accidental dynamic evaluation.
const DYNAMIC_EVAL: RegExp[] = [/\beval\s*\(/, /\bnew\s+Function\s*\(/, /(^|[^.\w])Function\s*\(/, /\bchild_process\b/];
const SCRIPT_FILE = /\.(m?[jt]sx?|cjs)$/;
// Content a reviewer cannot read must be content that is binary by nature: an image, font or media file whose
// first bytes carry that format's signature. Anything else with a NUL byte (one in a comment makes a .js file
// "binary"; named logo.png it can still be loaded by require()) would reach main unread, so it fails.
// Executables, archives and WebAssembly are code a reviewer cannot read either: they are not on the list.
const SIGNATURES: Array<[RegExp, (hex: string) => boolean]> = [
  [/\.png$/i, (h) => h.startsWith('89504e470d0a1a0a')],
  [/\.jpe?g$/i, (h) => h.startsWith('ffd8ff')],
  [/\.gif$/i, (h) => h.startsWith('474946383761') || h.startsWith('474946383961')],
  [/\.webp$/i, (h) => h.startsWith('52494646') && h.slice(16, 24) === '57454250'],
  [/\.(avif|mp4|m4a|mov)$/i, (h) => h.slice(8, 16) === '66747970'],
  [/\.ico$/i, (h) => h.startsWith('00000100')],
  [/\.bmp$/i, (h) => h.startsWith('424d')],
  [/\.tiff?$/i, (h) => h.startsWith('49492a00') || h.startsWith('4d4d002a')],
  [/\.woff$/i, (h) => h.startsWith('774f4646')],
  [/\.woff2$/i, (h) => h.startsWith('774f4632')],
  [/\.ttf$/i, (h) => h.startsWith('00010000') || h.startsWith('74727565')],
  [/\.otf$/i, (h) => h.startsWith('4f54544f')],
  [/\.pdf$/i, (h) => h.startsWith('25504446')],
  [/\.mp3$/i, (h) => h.startsWith('494433') || /^ff[ef]/.test(h)],
  [/\.webm$/i, (h) => h.startsWith('1a45dfa3')],
  [/\.ogg$/i, (h) => h.startsWith('4f676753')],
  [/\.wav$/i, (h) => h.startsWith('52494646') && h.slice(16, 24) === '57415645'],
  [/\.flac$/i, (h) => h.startsWith('664c6143')],
];
const readableBinary = (f: FileChange) => SIGNATURES.some(([ext, sig]) => ext.test(f.path) && sig(f.magic ?? ''));
const SYMLINK_MODE = '120000';

/**
 * Lines a change brings in: added minus removed, as multisets. A moved line, or an untouched one the diff
 * reports as removed and added past its edit limit, is not new content and must not trip a gate.
 */
function newLines(f: FileChange): string[] {
  const removed = new Map<string, number>();
  for (const l of f.removed) removed.set(l, (removed.get(l) ?? 0) + 1);
  return f.added.filter((l) => {
    const c = removed.get(l) ?? 0;
    if (c > 0) removed.set(l, c - 1);
    return c === 0;
  });
}

export interface GateConfig {
  protectedPaths: string[];
}

export const DEFAULT_GATE_CONFIG: GateConfig = Object.freeze({ protectedPaths: ['.github/workflows/', '.gitflare/'] });

export function runGates(files: readonly FileChange[], config: GateConfig = DEFAULT_GATE_CONFIG): GateResult[] {
  const results: GateResult[] = [];
  results.push({
    gate: 'non-empty',
    passed: files.length > 0,
    detail: files.length > 0 ? `${files.length} file(s) changed` : 'commit introduces no change against its base',
  });

  const protectedHits = files.filter((f) => config.protectedPaths.some((p) => f.path.startsWith(p))).map((f) => f.path);
  results.push({
    gate: 'protected-paths',
    passed: protectedHits.length === 0,
    detail: protectedHits.length === 0 ? 'no protected path touched' : `protected: ${protectedHits.join(', ')}`,
  });

  const opaque = files.filter((f) => f.binary && f.status !== 'deleted' && !readableBinary(f)).map((f) => f.path);
  results.push({
    gate: 'binary-content',
    passed: opaque.length === 0,
    detail: opaque.length === 0 ? 'no unreadable content outside image, font and media files with their signature' : `binary content in: ${opaque.join(', ')}`,
  });

  const links = files.filter((f) => f.blob?.mode === SYMLINK_MODE).map((f) => f.path);
  results.push({
    gate: 'no-symlinks',
    passed: links.length === 0,
    detail: links.length === 0 ? 'no symbolic link added or changed' : `symbolic link: ${links.join(', ')}`,
  });

  const secretHits: string[] = [];
  for (const f of files) {
    for (const line of [...newLines(f), ...(f.strings ?? [])]) for (const [name, re] of SECRET_PATTERNS) if (re.test(line)) secretHits.push(`${f.path} (${name})`);
  }
  results.push({
    gate: 'secret-scan',
    passed: secretHits.length === 0,
    detail: secretHits.length === 0 ? 'no credential pattern in added lines or binary strings' : `credential pattern: ${[...new Set(secretHits)].join(', ')}`,
  });

  const evalHits: string[] = [];
  for (const f of files) {
    // Script files' new lines, and any binary file's strings (code hidden in a file loaded by require()).
    const lines = [...(SCRIPT_FILE.test(f.path) ? newLines(f) : []), ...(f.strings ?? [])];
    for (const line of lines) if (DYNAMIC_EVAL.some((re) => re.test(line))) evalHits.push(f.path);
  }
  results.push({
    gate: 'dynamic-eval-heuristic',
    passed: evalHits.length === 0,
    detail: evalHits.length === 0 ? 'no dynamic evaluation in new script lines or binary strings' : `dynamic evaluation in: ${[...new Set(evalHits)].join(', ')}`,
  });
  return results;
}
