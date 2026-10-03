// Main guard. Artifacts has no branch protection: any write token on a repository can move (or rewrite) main.
// The registry is the only component that should ever write main, so it records what it wrote (the heads it
// landed, the ids of the write tokens it minted) and checks two independent signals against that record:
//   - Artifacts events (Queues event subscriptions on main and its mirrors): `pushed` and `token.created`;
//   - main's head at the start of every merge round.
// Anything it did not produce raises an alert, and the merge queue stops until an admin accepts the new
// head or restores the last one the platform produced.

export interface ArtifactsEvent {
  type: string;
  repo: string;
  namespace: string;
  payload: Record<string, unknown>;
  /** event time (ms), from metadata.eventTimestamp */
  at: number;
}

export interface GuardAlert {
  kind: 'foreign-push' | 'foreign-write-token' | 'head-moved';
  at: number;
  repo: string;
  detail: string;
  ref?: string;
  before?: string;
  after?: string;
  commits?: Array<{ id: string; author: string; committer: string; message: string }>;
}

export interface GuardEventRecord {
  at: number;
  type: string;
  repo: string;
  ref?: string;
  after?: string;
  verdict: 'own' | 'foreign' | 'info';
  lagMs: number;
}

export interface MainGuard {
  /** The head main must have: the last one the platform produced (or saw at init). */
  expectedHead: string | null;
  landed: string[];
  ownWriteTokens: string[];
  alert: GuardAlert | null;
  recent: GuardEventRecord[];
  counts: { events: number; ownPushes: number; foreignPushes: number; foreignWriteTokens: number; clones: number; fetches: number; maxLagMs: number };
}

export const emptyGuard = (): MainGuard => ({
  expectedHead: null,
  landed: [],
  ownWriteTokens: [],
  alert: null,
  recent: [],
  counts: { events: 0, ownPushes: 0, foreignPushes: 0, foreignWriteTokens: 0, clones: 0, fetches: 0, maxLagMs: 0 },
});

const cap = <T>(xs: T[], n: number) => (xs.length > n ? xs.slice(xs.length - n) : xs);
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

/** Normalise one message body from an Artifacts event subscription; null if it is not one. */
export function parseArtifactsEvent(body: unknown): ArtifactsEvent | null {
  let b = body;
  if (typeof b === 'string') {
    try {
      b = JSON.parse(b);
    } catch {
      return null;
    }
  }
  if (!b || typeof b !== 'object') return null;
  const o = b as { type?: unknown; source?: { type?: unknown; namespace?: unknown; repoName?: unknown }; payload?: unknown; metadata?: { eventTimestamp?: unknown } };
  if (typeof o.type !== 'string' || !o.type.startsWith('cf.artifacts.')) return null;
  const repo = str(o.source?.repoName);
  if (!repo) return null;
  const at = Date.parse(str(o.metadata?.eventTimestamp) ?? '');
  return { type: o.type, repo, namespace: str(o.source?.namespace) ?? '', payload: (o.payload && typeof o.payload === 'object' ? o.payload : {}) as Record<string, unknown>, at: Number.isFinite(at) ? at : Date.now() };
}

/** The repository an event belongs to: forks are `<repo>--a<hash>[-r2]`, mirrors `<repo>--m<i>`. */
export function baseRepoOf(name: string): string {
  const m = /^(.+)--(?:a[0-9a-f]{12}(?:-r2)?|m\d{1,2})$/.exec(name);
  return m ? m[1] : name;
}

export function recordLanded(g: MainGuard, head: string): void {
  g.expectedHead = head;
  if (!g.landed.includes(head)) g.landed = cap([...g.landed, head], 100);
}

export function recordOwnToken(g: MainGuard, id: string): void {
  g.ownWriteTokens = cap([...g.ownWriteTokens, id], 500);
}

/** Apply one event for a watched repository (main or one of its mirrors). Returns the alert it raised, if any. */
export function applyEvent(g: MainGuard, e: ArtifactsEvent, watched: ReadonlySet<string>, now: number): GuardAlert | null {
  if (!watched.has(e.repo)) return null;
  g.counts.events++;
  const lagMs = Math.max(0, now - e.at);
  g.counts.maxLagMs = Math.max(g.counts.maxLagMs, lagMs);
  let verdict: GuardEventRecord['verdict'] = 'info';
  let alert: GuardAlert | null = null;
  const ref = str(e.payload.ref);
  const after = str(e.payload.after);
  if (e.type === 'cf.artifacts.repo.pushed') {
    if (ref === 'refs/heads/main' && after && g.landed.includes(after)) {
      verdict = 'own';
      g.counts.ownPushes++;
    } else {
      verdict = 'foreign';
      g.counts.foreignPushes++;
      const commits = Array.isArray(e.payload.commits) ? (e.payload.commits as Array<Record<string, unknown>>) : [];
      alert = {
        kind: 'foreign-push',
        at: e.at,
        repo: e.repo,
        ref,
        before: str(e.payload.before),
        after,
        detail: `push to ${e.repo} ${ref ?? '?'} → ${after?.slice(0, 12) ?? '?'} that the merge queue did not make`,
        commits: commits.slice(0, 5).map((c) => ({
          id: str(c.id) ?? '',
          author: str((c.author as Record<string, unknown> | undefined)?.email) ?? '',
          committer: str((c.committer as Record<string, unknown> | undefined)?.email) ?? '',
          message: (str(c.message) ?? '').slice(0, 200),
        })),
      };
    }
  } else if (e.type === 'cf.artifacts.repo.token.created') {
    const id = str(e.payload.tokenId);
    if (e.payload.scope === 'write' && id && g.ownWriteTokens.includes(id)) verdict = 'own';
    else if (e.payload.scope === 'write' && id) {
      verdict = 'foreign';
      g.counts.foreignWriteTokens++;
      alert = { kind: 'foreign-write-token', at: e.at, repo: e.repo, detail: `write token ${id} minted on ${e.repo} outside the platform` };
    }
  } else if (e.type === 'cf.artifacts.repo.cloned') g.counts.clones++;
  else if (e.type === 'cf.artifacts.repo.fetched') g.counts.fetches++;
  g.recent = cap([...g.recent, { at: e.at, type: e.type.replace('cf.artifacts.repo.', ''), repo: e.repo, ref, after: after?.slice(0, 12), verdict, lagMs }], 30);
  if (alert && !g.alert) g.alert = alert;
  return alert;
}
