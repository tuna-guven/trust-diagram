import { describe, expect, it } from "vitest";
import { buildGraph, indexDocument } from "../../src/core/graph";
import type { TrustDocument } from "../../src/core/model";
import { contains, database, key, partial, rule, trustDocument, unlocks } from "./builders";

const doc = trustDocument({
  databases: [database("disk"), database("vault"), database("plate")],
  keys: [key("pass"), key("share-b"), key("share-a")],
  edges: [
    contains("disk", "vault"),
    unlocks("pass", "vault"),
    contains("vault", "share-a"),
    partial("share-b", "plate", "r1"),
    partial("share-a", "plate", "r1"),
    unlocks("pass", "disk"),
  ],
  rules: [rule("r1", "plate", 2)],
});

describe("buildGraph", () => {
  it("has a sorted node list of databases and keys", () => {
    expect(buildGraph(doc).nodes).toEqual(["disk", "pass", "plate", "share-a", "share-b", "vault"]);
  });

  it("turns contains and unlock edges into arcs sorted by target", () => {
    const graph = buildGraph(doc);
    expect(graph.successors.get("pass")).toEqual([
      { from: "pass", to: "disk", edgeId: "u-pass-disk", type: "unlocks-full" },
      { from: "pass", to: "vault", edgeId: "u-pass-vault", type: "unlocks-full" },
    ]);
    expect(graph.successors.get("share-a")).toEqual([{ from: "share-a", to: "plate", edgeId: "p-share-a-plate-r1", type: "unlocks-partial" }]);
    expect(graph.successors.get("plate")).toEqual([]);
  });

  it("leaves out ephemeral databases and their edges, but keeps the keys they contain", () => {
    const withSession = trustDocument({
      databases: [database("disk"), database("tails", { category: "session", ephemeral: true })],
      keys: [key("generated")],
      edges: [contains("tails", "generated"), unlocks("generated", "tails"), unlocks("generated", "disk"), contains("disk", "tails")],
    });
    const graph = buildGraph(withSession);
    expect(graph.nodes).toEqual(["disk", "generated"]);
    expect(graph.successors.has("tails")).toBe(false);
    expect(graph.successors.get("disk")).toEqual([]);
    expect(graph.successors.get("generated")).toEqual([{ from: "generated", to: "disk", edgeId: "u-generated-disk", type: "unlocks-full" }]);
  });

  it("is independent of edge order in the document", () => {
    const reversed = { ...doc, edges: [...doc.edges].reverse(), keys: [...doc.keys].reverse() };
    expect(buildGraph(reversed)).toEqual(buildGraph(doc));
  });
});

describe("indexDocument", () => {
  const index = indexDocument(doc);

  it("lists containers per node", () => {
    expect(index.containers.get("vault")).toEqual([{ nodeId: "disk", edgeId: "c-disk-vault" }]);
    expect(index.containers.get("share-a")).toEqual([{ nodeId: "vault", edgeId: "c-vault-share-a" }]);
    expect(index.containers.get("pass")).toBeUndefined();
  });

  it("groups partial unlock keys by rule, sorted", () => {
    expect(index.rules.get("plate")).toEqual([{ rule: rule("r1", "plate", 2), keyIds: ["share-a", "share-b"] }]);
  });

  it("lists full unlocks and unlock targets", () => {
    expect(index.fullUnlocks.get("vault")).toEqual([{ nodeId: "pass", edgeId: "u-pass-vault" }]);
    expect(index.unlockTargets.get("pass")?.map((l) => l.nodeId)).toEqual(["disk", "vault"]);
    expect(index.unlockTargets.get("share-b")?.map((l) => l.nodeId)).toEqual(["plate"]);
  });
});

describe("invalid documents", () => {
  const base = { databases: [database("d1"), database("d2")], keys: [key("k1"), key("k2")], rules: [rule("r1", "d1", 1)] };
  const invalid: [string, TrustDocument, RegExp][] = [
    ["a dangling edge target", trustDocument({ ...base, edges: [contains("d1", "missing")] }), /must end at a database or key/],
    ["a dangling edge source", trustDocument({ ...base, edges: [unlocks("missing", "d1")] }), /must start at a key/],
    ["contains from a key", trustDocument({ ...base, edges: [contains("k1", "d1")] }), /must start at a database/],
    ["an unlock from a database", trustDocument({ ...base, edges: [unlocks("d2", "d1")] }), /must start at a key/],
    ["an unlock of a key", trustDocument({ ...base, edges: [unlocks("k1", "k2")] }), /must end at a database/],
    ["a partial unlock without a rule", trustDocument({ ...base, edges: [{ ...partial("k1", "d1", "r1"), ruleId: null }] }), /must reference an unlock rule/],
    ["a partial unlock with an unknown rule", trustDocument({ ...base, edges: [partial("k1", "d1", "nope")] }), /unknown rule "nope"/],
    ["a rule of a different database", trustDocument({ ...base, edges: [partial("k1", "d2", "r1")] }), /of a different database/],
    ["a full unlock with a rule", trustDocument({ ...base, edges: [{ ...unlocks("k1", "d1"), ruleId: "r1" }] }), /may not reference a rule/],
  ];

  it.each(invalid)("throws on %s instead of dropping the edge", (_, doc, message) => {
    expect(() => buildGraph(doc)).toThrow(message);
    expect(() => indexDocument(doc)).toThrow(message);
  });

  it("throws on an edge touching an ephemeral database only if it is malformed", () => {
    const ephemeral = { ...base, databases: [database("d1", { ephemeral: true })] };
    expect(() => buildGraph(trustDocument({ ...ephemeral, edges: [unlocks("k1", "d1")] }))).not.toThrow();
    expect(() => buildGraph(trustDocument({ ...ephemeral, edges: [unlocks("d1", "k1")] }))).toThrow(/must start at a key/);
  });

  it("throws when a key is in the same rule twice, so it cannot count as two keys", () => {
    const edge = partial("k1", "d1", "r1");
    const doc = trustDocument({ ...base, edges: [edge, { ...edge, id: "again" }], rules: [rule("r1", "d1", 2)] });
    expect(() => indexDocument(doc)).toThrow(/"k1" is in rule "r1" more than once/);
  });
});

describe("indexDocument with ephemeral databases", () => {
  it("keeps them, unlike the graph, so analyses can discount them", () => {
    const doc = trustDocument({
      databases: [database("disk"), database("tails", { category: "session", ephemeral: true })],
      keys: [key("generated")],
      edges: [contains("tails", "generated"), unlocks("generated", "tails")],
    });
    const index = indexDocument(doc);
    expect(index.databaseIds).toEqual(["disk", "tails"]);
    expect(index.containers.get("generated")).toEqual([{ nodeId: "tails", edgeId: "c-tails-generated" }]);
    expect(buildGraph(doc).nodes).toEqual(["disk", "generated"]);
  });
});
