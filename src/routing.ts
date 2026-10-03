// Task sharding: a repository is served by one registry Durable Object (forks, review graph, merge queue)
// and N task shards. A task always lives on shard fnv1a(taskId) % N; a patch id carries its shard index.

export const MAX_SHARDS = 64;
export const DEFAULT_SHARDS = 4;

export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export const shardOf = (taskId: string, shards: number): number => fnv1a(taskId) % shards;
export const shardName = (repo: string, shard: number): string => `${repo}#${shard}`;

export const PATCH_ID_RE = /^p(\d{1,2})_[0-9a-f]{12}$/;
export function shardOfPatch(patchId: string): number | null {
  const m = PATCH_ID_RE.exec(patchId);
  return m ? Number(m[1]) : null;
}
