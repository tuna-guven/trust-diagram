import { describe, expect, it } from "vitest";
import { findCircularGroups, stronglyConnectedComponents, type CircularGroup } from "../../src/core/cycles";
import { buildGraph, type Arc, type DependencyGraph } from "../../src/core/graph";
import { compareIds } from "../../src/core/model";
import { contains, database, key, seededRandom, trustDocument, unlocks } from "./builders";

/** A bare graph from "a>b" pairs; arcs are typed "contains" since cycles ignore types. */
function graphOf(nodeCount: number, pairs: readonly [number, number][]): DependencyGraph {
  const name = (i: number): string => `n${String(i).padStart(3, "0")}`;
  const nodes = Array.from({ length: nodeCount }, (_, i) => name(i));
  const successors = new Map<string, Arc[]>(nodes.map((n) => [n, []]));
  pairs.forEach(([from, to], i) => {
    successors.get(name(from))!.push({ from: name(from), to: name(to), edgeId: `e${String(i)}`, type: "contains" });
  });
  for (const arcs of successors.values()) arcs.sort((a, b) => compareIds(a.to, b.to) || compareIds(a.edgeId, b.edgeId));
  return { nodes, successors };
}

function cycleNodes(group: CircularGroup): string[] {
  return group.cycle.map((arc) => arc.from);
}

describe("findCircularGroups", () => {
  it("accepts a DAG", () => {
    const doc = trustDocument({
      databases: [database("disk"), database("vault")],
      keys: [key("pass"), key("inner")],
      edges: [unlocks("pass", "disk"), contains("disk", "vault"), unlocks("pass", "vault"), contains("vault", "inner")],
    });
    expect(findCircularGroups(buildGraph(doc))).toEqual([]);
  });

  it("finds a self-loop", () => {
    const doc = trustDocument({ databases: [database("d")], edges: [contains("d", "d")] });
    expect(findCircularGroups(buildGraph(doc))).toEqual([
      { nodeIds: ["d"], cycle: [{ from: "d", to: "d", edgeId: "c-d-d", type: "contains" }] },
    ]);
  });

  it("finds a two-node cycle: a database storing its own key", () => {
    const doc = trustDocument({
      databases: [database("recovery")],
      keys: [key("master")],
      edges: [contains("recovery", "master"), unlocks("master", "recovery")],
    });
    const [group] = findCircularGroups(buildGraph(doc));
    expect(group?.nodeIds).toEqual(["master", "recovery"]);
    expect(group?.cycle.map((a) => a.edgeId)).toEqual(["u-master-recovery", "c-recovery-master"]);
  });

  it("ignores loops through an ephemeral database", () => {
    const doc = trustDocument({
      databases: [database("tails", { category: "session", ephemeral: true, protection: "none" }), database("disk")],
      keys: [key("generated")],
      edges: [contains("tails", "generated"), unlocks("generated", "tails"), contains("tails", "disk"), contains("disk", "tails")],
    });
    expect(findCircularGroups(buildGraph(doc))).toEqual([]);
  });

  it("reports the shortest cycle when a long loop has a shortcut", () => {
    // 0>1>2>3>4>5>0 plus shortcut 3>0: shortest cycle is 0>1>2>3>0.
    const graph = graphOf(6, [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 0], [3, 0]]);
    const [group] = findCircularGroups(graph);
    expect(group?.nodeIds).toHaveLength(6);
    expect(cycleNodes(group!)).toEqual(["n000", "n001", "n002", "n003"]);
  });

  it("finds a long cycle", () => {
    const n = 50;
    const graph = graphOf(n, Array.from({ length: n }, (_, i): [number, number] => [i, (i + 1) % n]));
    const [group] = findCircularGroups(graph);
    expect(group?.cycle).toHaveLength(n);
  });

  it("reports separate groups in order of their smallest id", () => {
    const graph = graphOf(6, [[4, 5], [5, 4], [0, 1], [1, 0], [1, 2], [2, 3]]);
    expect(findCircularGroups(graph).map((g) => g.nodeIds)).toEqual([["n000", "n001"], ["n004", "n005"]]);
  });

  it("handles deep graphs without recursion limits", () => {
    const n = 50_000;
    const graph = graphOf(n, Array.from({ length: n }, (_, i): [number, number] => [i, (i + 1) % n]));
    expect(stronglyConnectedComponents(graph)).toHaveLength(1);
  });
});

/** Brute force: transitive closure, then u, v share a group iff each reaches the other. */
function bruteForceGroups(n: number, pairs: readonly [number, number][]): { members: number[]; shortest: number }[] {
  const inf = Number.POSITIVE_INFINITY;
  const dist = Array.from({ length: n }, () => Array<number>(n).fill(inf));
  for (const [a, b] of pairs) dist[a]![b] = 1;
  for (let k = 0; k < n; k++)
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) dist[i]![j] = Math.min(dist[i]![j]!, dist[i]![k]! + dist[k]![j]!);

  const groups: { members: number[]; shortest: number }[] = [];
  const assigned = new Set<number>();
  for (let i = 0; i < n; i++) {
    if (assigned.has(i)) continue;
    const members = [i];
    for (let j = i + 1; j < n; j++) if (dist[i]![j]! < inf && dist[j]![i]! < inf) members.push(j);
    members.forEach((m) => assigned.add(m));
    const inGroup = new Set(members);
    // Shortest cycle inside the group: min over arcs a>b in the group of 1 + dist(b, a).
    // dist may route outside the group, but any such route stays in the SCC by definition.
    let shortest = inf;
    for (const [a, b] of pairs) if (inGroup.has(a) && inGroup.has(b)) shortest = Math.min(shortest, 1 + (a === b ? 0 : dist[b]![a]!));
    if (shortest < inf) groups.push({ members, shortest });
  }
  return groups;
}

function randomPairs(random: () => number, n: number, m: number, acyclic: boolean): [number, number][] {
  const pairs: [number, number][] = [];
  for (let i = 0; i < m; i++) {
    let a = Math.floor(random() * n);
    let b = Math.floor(random() * n);
    if (acyclic) {
      if (a === b) continue;
      if (a > b) [a, b] = [b, a];
    }
    pairs.push([a, b]);
  }
  return pairs;
}

describe("findCircularGroups properties", () => {
  it("never reports cycles on random DAGs", () => {
    const random = seededRandom(1);
    for (let run = 0; run < 300; run++) {
      const n = 1 + Math.floor(random() * 30);
      const graph = graphOf(n, randomPairs(random, n, Math.floor(random() * n * 3), true));
      expect(findCircularGroups(graph)).toEqual([]);
    }
  });

  it("agrees with brute force on random graphs", () => {
    const random = seededRandom(2);
    for (let run = 0; run < 500; run++) {
      const n = 1 + Math.floor(random() * 12);
      const pairs = randomPairs(random, n, Math.floor(random() * n * 2.5), false);
      const graph = graphOf(n, pairs);
      const groups = findCircularGroups(graph);
      const expected = bruteForceGroups(n, pairs);

      expect(groups.map((g) => g.nodeIds)).toEqual(expected.map((g) => g.members.map((i) => graph.nodes[i])));
      groups.forEach((group, i) => {
        expect(group.cycle).toHaveLength(expected[i]!.shortest);
        // The reported cycle is a real, closed, simple loop inside the group.
        const members = new Set(group.nodeIds);
        group.cycle.forEach((arc, step) => {
          const next = group.cycle[(step + 1) % group.cycle.length]!;
          expect(arc.to).toBe(next.from);
          expect(members.has(arc.from)).toBe(true);
          expect(graph.successors.get(arc.from)).toContainEqual(arc);
        });
        expect(new Set(cycleNodes(group)).size).toBe(group.cycle.length);
      });
    }
  });

  it("is deterministic regardless of document order", () => {
    const random = seededRandom(3);
    const ids = Array.from({ length: 10 }, (_, i) => `d${String(i)}`);
    const edges = randomPairs(random, 10, 25, false).map(([a, b]) => contains(ids[a]!, ids[b]!));
    const unique = [...new Map(edges.map((e) => [e.id, e])).values()];
    const doc = trustDocument({ databases: ids.map((id) => database(id)), edges: unique });
    const shuffled = { ...doc, databases: [...doc.databases].reverse(), edges: [...unique].reverse() };
    expect(findCircularGroups(buildGraph(shuffled))).toEqual(findCircularGroups(buildGraph(doc)));
  });
});
