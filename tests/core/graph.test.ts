import { describe, expect, it } from "vitest";
import { buildGraph, indexDocument } from "../../src/core/graph";
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
