// Dependency graph G (DESIGN.md 5.1) and the sorted lookup index shared by the analyses.
// Every list here is sorted by stable keys so downstream output is deterministic (DESIGN.md 2).

import {
  EDGE_TYPES,
  compareIds,
  type Database,
  type Edge,
  type EdgeType,
  type Id,
  type Key,
  type TrustDocument,
  type UnlockRule,
} from "./model";

interface Lookup {
  databases: ReadonlyMap<Id, Database>;
  keys: ReadonlyMap<Id, Key>;
  rules: ReadonlyMap<Id, UnlockRule>;
}

function lookupOf(doc: TrustDocument): Lookup {
  return {
    databases: new Map(doc.databases.map((d) => [d.id, d])),
    keys: new Map(doc.keys.map((k) => [k.id, k])),
    rules: new Map(doc.rules.map((r) => [r.id, r])),
  };
}

// parseDocument already rejects every edge this catches (DESIGN.md 4.4), so a failure means a
// caller skipped validation or a command corrupted the document. Dropping the edge would
// silently hide a dependency from the analysis, so fail loudly instead.
function checkEdge(edge: Edge, lookup: Lookup): void {
  const fail = (problem: string): never => {
    throw new Error(`Edge "${edge.id}" ${problem}; documents must pass parseDocument before analysis`);
  };
  if (edge.type === "contains") {
    if (!lookup.databases.has(edge.from)) fail("must start at a database");
    if (!lookup.databases.has(edge.to) && !lookup.keys.has(edge.to)) fail("must end at a database or key");
  } else {
    if (!lookup.keys.has(edge.from)) fail("must start at a key");
    if (!lookup.databases.has(edge.to)) fail("must end at a database");
  }
  if (edge.type !== "unlocks-partial") {
    if (edge.ruleId !== null) fail("may not reference a rule");
    return;
  }
  if (edge.ruleId === null) return fail("must reference an unlock rule");
  const rule = lookup.rules.get(edge.ruleId);
  if (rule === undefined) fail(`references unknown rule "${edge.ruleId}"`);
  else if (rule.databaseId !== edge.to) fail(`references rule "${rule.id}" of a different database`);
}

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

/**
 * contains A -> X gives A -> X; unlocks-* K -> D gives K -> D. Ephemeral databases no
 * longer exist, so they and their edges are left out. Throws if the document breaks the
 * structural rules of DESIGN.md 4.4.
 */
export function buildGraph(doc: TrustDocument): DependencyGraph {
  const lookup = lookupOf(doc);
  const isEphemeral = (id: Id): boolean => lookup.databases.get(id)?.ephemeral === true;
  const databaseIds = doc.databases.filter((d) => !d.ephemeral).map((d) => d.id);
  const nodes = [...databaseIds, ...doc.keys.map((k) => k.id)].sort(compareIds);
  const successors = new Map<Id, Arc[]>(nodes.map((id) => [id, []]));
  for (const edge of doc.edges) {
    checkEdge(edge, lookup);
    if (isEphemeral(edge.from) || isEphemeral(edge.to)) continue;
    successors.get(edge.from)?.push({ from: edge.from, to: edge.to, edgeId: edge.id, type: edge.type });
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

/**
 * Lookups over the whole document, unlike G (DESIGN.md 5.1): ephemeral databases and their
 * edges are included, because the analyses must see them to discount them (a copy inside
 * an ephemeral database does not count, DESIGN.md 6.1) and to never make them available
 * (DESIGN.md 5.3). Code that walks these maps must check `ephemeral` itself.
 */
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

/** Throws if the document breaks the structural rules of DESIGN.md 4.4. */
export function indexDocument(doc: TrustDocument): DocumentIndex {
  const lookup = lookupOf(doc);
  const containers = new Map<Id, Link[]>();
  const fullUnlocks = new Map<Id, Link[]>();
  const unlockTargets = new Map<Id, Link[]>();
  const ruleKeys = new Map<Id, Set<Id>>();

  for (const edge of doc.edges) {
    checkEdge(edge, lookup);
    switch (edge.type) {
      case "contains":
        pushTo(containers, edge.to, { nodeId: edge.from, edgeId: edge.id });
        break;
      case "unlocks-full":
        pushTo(fullUnlocks, edge.to, { nodeId: edge.from, edgeId: edge.id });
        pushTo(unlockTargets, edge.from, { nodeId: edge.to, edgeId: edge.id });
        break;
      case "unlocks-partial":
        if (edge.ruleId !== null) {
          // A key counted twice would let a k-of-n rule open with fewer distinct keys.
          const members = ruleKeys.get(edge.ruleId) ?? new Set<Id>();
          if (members.has(edge.from)) throw new Error(`Key "${edge.from}" is in rule "${edge.ruleId}" more than once`);
          ruleKeys.set(edge.ruleId, members.add(edge.from));
        }
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
    databases: lookup.databases,
    keys: lookup.keys,
    databaseIds: doc.databases.map((d) => d.id).sort(compareIds),
    keyIds: doc.keys.map((k) => k.id).sort(compareIds),
    containers: sortLinks(containers),
    fullUnlocks: sortLinks(fullUnlocks),
    rules,
    unlockTargets: sortLinks(unlockTargets),
  };
}
