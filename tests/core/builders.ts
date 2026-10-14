// Terse builders for test documents. Defaults are valid per DESIGN.md 4.4.
import type { Database, Edge, Id, Key, Location, TrustDocument, UnlockRule } from "../../src/core/model";

const style = { x: 0, y: 0, w: 160, h: 60, color: "#336699" } as const;
const edgeStyle = { color: "#555555", width: 1, dash: "solid" } as const;

export function location(id: Id, overrides: Partial<Location> = {}): Location {
  return { id, name: id, kind: "physical", note: "", ...overrides };
}

export function database(id: Id, overrides: Partial<Database> = {}): Database {
  return {
    id,
    name: id,
    category: "password-manager",
    product: "",
    encryption: "",
    dataTypes: [],
    locationId: null,
    locationDetail: "",
    protection: "rules",
    ephemeral: false,
    critical: false,
    note: "",
    style: { ...style },
    ...overrides,
  };
}

export function key(id: Id, overrides: Partial<Key> = {}): Key {
  return { id, name: id, category: "passphrase", memorized: false, note: "", style: { ...style }, ...overrides };
}

export function contains(from: Id, to: Id): Edge {
  return { id: `c-${from}-${to}`, type: "contains", from, to, ruleId: null, style: { ...edgeStyle } };
}

export function unlocks(from: Id, to: Id): Edge {
  return { id: `u-${from}-${to}`, type: "unlocks-full", from, to, ruleId: null, style: { ...edgeStyle } };
}

export function partial(from: Id, to: Id, ruleId: Id): Edge {
  return { id: `p-${from}-${to}-${ruleId}`, type: "unlocks-partial", from, to, ruleId, style: { ...edgeStyle } };
}

export function rule(id: Id, databaseId: Id, threshold: number): UnlockRule {
  return { id, databaseId, threshold, label: id };
}

export function trustDocument(parts: Partial<TrustDocument> = {}): TrustDocument {
  return {
    schemaVersion: 1,
    id: "doc",
    title: "Test",
    locations: [],
    databases: [],
    keys: [],
    edges: [],
    rules: [],
    scenarios: [],
    notes: "",
    view: { panX: 0, panY: 0, zoom: 1 },
    ...parts,
  };
}

/** Deterministic PRNG (mulberry32) so property tests are reproducible. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
