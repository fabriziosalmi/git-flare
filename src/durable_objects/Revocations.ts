// Agent key revocation list: one Durable Object for the whole deployment (named "global"). Keys are verified
// in the Worker without lookups, so revocation is a denylist: every key of `agentId` issued at or before
// `revokedThrough` (unix seconds) is refused. Revocations are rare, so Workers cache the whole list per isolate
// and refresh it every LIST_TTL_MS: one call per isolate per period, however many agents there are.
import { DurableObject } from 'cloudflare:workers';

export const REVOCATION_LIST_TTL_MS = 30_000;

export interface RevocationList {
  version: number;
  revokedThrough: Record<string, number>;
}

export class Revocations extends DurableObject<object> {
  private list: RevocationList = { version: 0, revokedThrough: {} };

  constructor(ctx: DurableObjectState, env: object) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.list = (await ctx.storage.get<RevocationList>('list')) ?? this.list;
    });
  }

  async revoke(agentId: string, throughSec: number): Promise<RevocationList> {
    this.list = { version: this.list.version + 1, revokedThrough: { ...this.list.revokedThrough, [agentId]: Math.max(throughSec, this.list.revokedThrough[agentId] ?? 0) } };
    await this.ctx.storage.put('list', this.list);
    return this.list;
  }

  getList(): RevocationList {
    return this.list;
  }
}
