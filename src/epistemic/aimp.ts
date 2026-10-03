// WASM bridge to the Rust SimHash (crates/aimp-wasm): 256-bit SimHash of a change's canonical text and the
// Hamming distance between two of them. Review aggregation lives in policy.ts (integer TypeScript).
import init, { simhash_text, simhash_hamming_distance } from '../../crates/aimp-wasm/pkg/aimp_wasm.js';

let ready: Promise<void> | null = null;

export function ensureAimp(wasm: WebAssembly.Module | ArrayBuffer | Uint8Array): Promise<void> {
  ready ??= init({ module_or_path: wasm }).then(() => undefined);
  return ready;
}

export class AimpEngine {
  static async create(wasm: WebAssembly.Module | ArrayBuffer | Uint8Array): Promise<AimpEngine> {
    await ensureAimp(wasm);
    return new AimpEngine();
  }

  computeSimHash(text: string): string {
    return simhash_text(text);
  }

  hammingDistance(hexA: string, hexB: string): number {
    return simhash_hamming_distance(hexA, hexB);
  }
}
