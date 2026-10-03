// Collusion clusters on the review graph: an edge reviewer -> author is added for every approval.
// Strongly connected components (Tarjan, iterative) with more than one member are mutual-approval
// clusters; approvals from members of the author's own cluster are excluded from evaluation.

export interface ReviewEdge {
  from: string;
  to: string;
}

export function stronglyConnectedComponents(edges: readonly ReviewEdge[]): string[][] {
  const adj = new Map<string, string[]>();
  for (const { from, to } of edges) {
    if (!adj.has(from)) adj.set(from, []);
    if (!adj.has(to)) adj.set(to, []);
    adj.get(from)!.push(to);
  }
  for (const list of adj.values()) list.sort();

  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];

  for (const root of [...adj.keys()].sort()) {
    if (idx.has(root)) continue;
    const work: Array<{ node: string; next: number }> = [{ node: root, next: 0 }];
    idx.set(root, index);
    low.set(root, index);
    index++;
    stack.push(root);
    onStack.add(root);
    while (work.length > 0) {
      const frame = work[work.length - 1];
      const succ = adj.get(frame.node)!;
      if (frame.next < succ.length) {
        const w = succ[frame.next++];
        if (!idx.has(w)) {
          idx.set(w, index);
          low.set(w, index);
          index++;
          stack.push(w);
          onStack.add(w);
          work.push({ node: w, next: 0 });
        } else if (onStack.has(w)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, idx.get(w)!));
        }
        continue;
      }
      work.pop();
      if (work.length > 0) {
        const parent = work[work.length - 1].node;
        low.set(parent, Math.min(low.get(parent)!, low.get(frame.node)!));
      }
      if (low.get(frame.node) === idx.get(frame.node)) {
        const comp: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          comp.push(w);
        } while (w !== frame.node);
        out.push(comp.sort());
      }
    }
  }
  return out;
}

/** Reviewers that share a multi-member strongly connected component with `author`. */
export function collusiveReviewers(edges: readonly ReviewEdge[], author: string): Set<string> {
  for (const comp of stronglyConnectedComponents(edges)) {
    if (comp.length > 1 && comp.includes(author)) return new Set(comp.filter((n) => n !== author));
  }
  return new Set();
}

/**
 * Same answer as collusiveReviewers, computed on adjacency sets maintained incrementally: the author's strongly
 * connected component is what the author reaches AND what reaches the author. The backward walk stays inside the
 * forward set (every node on a path from a component member to the author is a member), so the cost is bounded
 * by what the author reaches, and is constant for an author who never reviews (no outgoing edges).
 */
export function collusionCluster(out: ReadonlyMap<string, ReadonlySet<string>>, inc: ReadonlyMap<string, ReadonlySet<string>>, author: string): Set<string> {
  const fwd = new Set([author]);
  for (const stack = [author]; stack.length > 0; ) {
    for (const m of out.get(stack.pop()!) ?? []) {
      if (fwd.has(m)) continue;
      fwd.add(m);
      stack.push(m);
    }
  }
  if (fwd.size === 1) return new Set();
  const cluster = new Set<string>();
  const seen = new Set([author]);
  for (const stack = [author]; stack.length > 0; ) {
    for (const m of inc.get(stack.pop()!) ?? []) {
      if (seen.has(m) || !fwd.has(m)) continue;
      seen.add(m);
      cluster.add(m);
      stack.push(m);
    }
  }
  return cluster;
}
