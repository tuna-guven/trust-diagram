// Dependency graph G (DESIGN.md 5.1) and the sorted lookup index shared by the analyses.
// Every list here is sorted by stable keys so downstream output is deterministic (DESIGN.md 2).

import { EDGE_TYPES, compareIds, type Database, type EdgeType, type Id, type Key, type TrustDocument, type UnlockRule } from "./model";

export interface Arc {
  from: Id;
  to: Id;
  edgeId: Id;
  type: EdgeType;
}

export interface DependencyGraph {
  /** Sorted node ids (databases and keys). */
  nodes: readonly Id[];
  /** Outgoing arcs per node, sorted by target, edge type, then edge id. */
  successors: ReadonlyMap<Id, readonly Arc[]>;
}

function compareArcs(a: Arc, b: Arc): number {
  return compareIds(a.to, b.to) || EDGE_TYPES.indexOf(a.type) - EDGE_TYPES.indexOf(b.type) || compareIds(a.edgeId, b.edgeId);
}

/** contains A -> X gives A -> X; unlocks-* K -> D gives K -> D. */
export function buildGraph(doc: TrustDocument): DependencyGraph {
  const nodes = [...doc.databases.map((d) => d.id), ...doc.keys.map((k) => k.id)].sort(compareIds);
  const successors = new Map<Id, Arc[]>(nodes.map((id) => [id, []]));
  for (const edge of doc.edges) {
    const arcs = successors.get(edge.from);
    if (arcs === undefined || !successors.has(edge.to)) continue;
    arcs.push({ from: edge.from, to: edge.to, edgeId: edge.id, type: edge.type });
  }
  for (const arcs of successors.values()) arcs.sort(compareArcs);
  return { nodes, successors };
}

export interface Link {
  /** The node at the other end of the edge. */
  nodeId: Id;
  edgeId: Id;
}

export interface RuleKeys {
  rule: UnlockRule;
  /** Sorted ids of the keys in the rule. */
  keyIds: readonly Id[];
}

export interface DocumentIndex {
  databases: ReadonlyMap<Id, Database>;
  keys: ReadonlyMap<Id, Key>;
  databaseIds: readonly Id[];
  keyIds: readonly Id[];
  /** Node id -> databases that contain it. */
  containers: ReadonlyMap<Id, readonly Link[]>;
  /** Database id -> keys that unlock it fully. */
  fullUnlocks: ReadonlyMap<Id, readonly Link[]>;
  /** Database id -> its k-of-n unlock rules. */
  rules: ReadonlyMap<Id, readonly RuleKeys[]>;
  /** Key id -> databases it helps unlock (fully or partially). */
  unlockTargets: ReadonlyMap<Id, readonly Link[]>;
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

function sortLinks(map: Map<Id, Link[]>): Map<Id, Link[]> {
  for (const links of map.values()) {
    links.sort((a, b) => compareIds(a.nodeId, b.nodeId) || compareIds(a.edgeId, b.edgeId));
  }
  return map;
}

export function indexDocument(doc: TrustDocument): DocumentIndex {
  const containers = new Map<Id, Link[]>();
  const fullUnlocks = new Map<Id, Link[]>();
  const unlockTargets = new Map<Id, Link[]>();
  const ruleKeys = new Map<Id, Id[]>();

  for (const edge of doc.edges) {
    switch (edge.type) {
      case "contains":
        pushTo(containers, edge.to, { nodeId: edge.from, edgeId: edge.id });
        break;
      case "unlocks-full":
        pushTo(fullUnlocks, edge.to, { nodeId: edge.from, edgeId: edge.id });
        pushTo(unlockTargets, edge.from, { nodeId: edge.to, edgeId: edge.id });
        break;
      case "unlocks-partial":
        if (edge.ruleId !== null) pushTo(ruleKeys, edge.ruleId, edge.from);
        pushTo(unlockTargets, edge.from, { nodeId: edge.to, edgeId: edge.id });
        break;
    }
  }

  const rules = new Map<Id, RuleKeys[]>();
  for (const rule of [...doc.rules].sort((a, b) => compareIds(a.id, b.id))) {
    const keyIds = [...(ruleKeys.get(rule.id) ?? [])].sort(compareIds);
    pushTo(rules, rule.databaseId, { rule, keyIds });
  }

  return {
    databases: new Map(doc.databases.map((d) => [d.id, d])),
    keys: new Map(doc.keys.map((k) => [k.id, k])),
    databaseIds: doc.databases.map((d) => d.id).sort(compareIds),
    keyIds: doc.keys.map((k) => k.id).sort(compareIds),
    containers: sortLinks(containers),
    fullUnlocks: sortLinks(fullUnlocks),
    rules,
    unlockTargets: sortLinks(unlockTargets),
  };
}
