// Circularity (DESIGN.md 5.2): Tarjan's SCC (iterative), the shortest cycle through each
// circular group (BFS restricted to the group), and blocking/redundant classification.

import type { Evaluation } from "./evaluate";
import type { Arc, DependencyGraph, DocumentIndex } from "./graph";
import { compareIds, type Id } from "./model";

export interface CircularGroup {
  /** Sorted ids of every node in the strongly connected component. */
  nodeIds: readonly Id[];
  /** A shortest cycle through the group, starting and ending at cycle[0].from. */
  cycle: readonly Arc[];
}

export type CircularSeverity = "blocking" | "redundant";

export interface ClassifiedGroup extends CircularGroup {
  severity: CircularSeverity;
  /** Sorted ids of databases in the group that cannot be opened in the baseline state. */
  unopenedDatabaseIds: readonly Id[];
}

function arcsFrom(graph: DependencyGraph, node: Id): readonly Arc[] {
  return graph.successors.get(node) ?? [];
}

interface Frame {
  node: Id;
  next: number;
}

/** Strongly connected components, each sorted, ordered by their smallest id. */
export function stronglyConnectedComponents(graph: DependencyGraph): Id[][] {
  const order = new Map<Id, number>();
  const lowlink = new Map<Id, number>();
  const onStack = new Set<Id>();
  const stack: Id[] = [];
  const components: Id[][] = [];

  const low = (node: Id): number => lowlink.get(node) ?? Number.POSITIVE_INFINITY;
  const enter = (node: Id, frames: Frame[]): void => {
    const position = order.size;
    order.set(node, position);
    lowlink.set(node, position);
    stack.push(node);
    onStack.add(node);
    frames.push({ node, next: 0 });
  };

  for (const root of graph.nodes) {
    if (order.has(root)) continue;
    const frames: Frame[] = [];
    enter(root, frames);

    for (let frame = frames.at(-1); frame !== undefined; frame = frames.at(-1)) {
      const arc = arcsFrom(graph, frame.node)[frame.next];
      if (arc !== undefined) {
        frame.next += 1;
        const target = order.get(arc.to);
        if (target === undefined) enter(arc.to, frames);
        else if (onStack.has(arc.to)) lowlink.set(frame.node, Math.min(low(frame.node), target));
        continue;
      }

      frames.pop();
      if (low(frame.node) === order.get(frame.node)) {
        const component: Id[] = [];
        for (let member = stack.pop(); member !== undefined; member = stack.pop()) {
          onStack.delete(member);
          component.push(member);
          if (member === frame.node) break;
        }
        components.push(component.sort(compareIds));
      }
      const parent = frames.at(-1);
      if (parent !== undefined) lowlink.set(parent.node, Math.min(low(parent.node), low(frame.node)));
    }
  }

  return components.sort((a, b) => compareIds(a[0] ?? "", b[0] ?? ""));
}

/** Shortest cycle from start back to start using only arcs inside members, or null. */
function shortestCycleFrom(graph: DependencyGraph, members: ReadonlySet<Id>, start: Id): Arc[] | null {
  const via = new Map<Id, Arc>();
  const queue: Id[] = [start];
  for (let head = 0; head < queue.length; head += 1) {
    const node = queue[head];
    if (node === undefined) break;
    for (const arc of arcsFrom(graph, node)) {
      if (!members.has(arc.to)) continue;
      if (arc.to === start) {
        const cycle = [arc];
        for (let step = via.get(arc.from); step !== undefined; step = via.get(step.from)) cycle.push(step);
        return cycle.reverse();
      }
      if (!via.has(arc.to)) {
        via.set(arc.to, arc);
        queue.push(arc.to);
      }
    }
  }
  return null;
}

function shortestCycle(graph: DependencyGraph, nodeIds: readonly Id[]): Arc[] | null {
  const members = new Set(nodeIds);
  let best: Arc[] | null = null;
  for (const start of nodeIds) {
    const cycle = shortestCycleFrom(graph, members, start);
    if (cycle !== null && (best === null || cycle.length < best.length)) best = cycle;
    if (best?.length === 1) break;
  }
  return best;
}

/** Every SCC with more than one node, or with a self-loop, as a circular group. */
export function findCircularGroups(graph: DependencyGraph): CircularGroup[] {
  const groups: CircularGroup[] = [];
  for (const nodeIds of stronglyConnectedComponents(graph)) {
    const cycle = shortestCycle(graph, nodeIds);
    if (cycle !== null) groups.push({ nodeIds, cycle });
  }
  return groups;
}

export function classifyCircularGroups(
  groups: readonly CircularGroup[],
  index: DocumentIndex,
  baseline: Evaluation,
): ClassifiedGroup[] {
  return groups.map((group) => {
    const unopenedDatabaseIds = group.nodeIds.filter((id) => index.databases.has(id) && !baseline.open.has(id));
    return { ...group, severity: unopenedDatabaseIds.length > 0 ? "blocking" : "redundant", unopenedDatabaseIds };
  });
}
