import { describe, expect, it } from "vitest";
import { LIMITS } from "../../src/core/model";
import { parseDocument } from "../../src/core/schema";
import { contains, database, key, location, partial, rule, trustDocument, unlocks } from "./builders";

function roundTrip(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function errorsOf(input: unknown): { path: string; message: string }[] {
  const result = parseDocument(input);
  if (result.ok) throw new Error("expected validation to fail");
  return result.error;
}

const valid = trustDocument({
  locations: [location("home")],
  databases: [database("vault", { locationId: "home", dataTypes: ["passwords", "keys"] }), database("plate", { protection: "none" })],
  keys: [key("master", { memorized: true }), key("share-a"), key("share-b")],
  edges: [unlocks("master", "vault"), partial("share-a", "plate", "r1"), partial("share-b", "plate", "r1"), contains("vault", "share-a")],
  rules: [rule("r1", "plate", 2)],
  scenarios: [{ id: "s1", name: "Fire", events: [{ type: "location-unreachable", locationId: "home" }] }],
});

describe("parseDocument", () => {
  it("accepts a valid document unchanged", () => {
    const result = parseDocument(roundTrip(valid));
    expect(result).toEqual({ ok: true, value: valid });
  });

  it("drops unknown fields everywhere", () => {
    const input = roundTrip(valid) as Record<string, unknown>;
    input["extra"] = 1;
    const databases = input["databases"] as Record<string, unknown>[];
    databases[0]!["secret"] = "x";
    (databases[0]!["style"] as Record<string, unknown>)["opacity"] = 0.5;
    const result = parseDocument(input);
    expect(result).toEqual({ ok: true, value: valid });
  });

  it("rejects non-objects and unknown schema versions", () => {
    expect(errorsOf(null)).toEqual([{ path: "", message: "Expected a document object" }]);
    expect(errorsOf([])).toHaveLength(1);
    expect(errorsOf({ ...valid, schemaVersion: 2 })[0]?.path).toBe("schemaVersion");
  });

  it("rejects unknown enum values with a precise path", () => {
    const input = roundTrip(valid) as { databases: { category: string }[] };
    input.databases[1]!.category = "spaceship";
    expect(errorsOf(input)).toEqual([{ path: "databases[1].category", message: expect.stringContaining("password-manager") as string }]);
  });

  it.each([
    ["uppercase hex", "#ABCDEF"],
    ["short hex", "#abc"],
    ["named colour", "red"],
    ["css injection", "#000000;background:url(x)"],
  ])("rejects colour: %s", (_, color) => {
    const input = roundTrip(valid) as { keys: { style: { color: string } }[] };
    input.keys[0]!.style.color = color;
    expect(errorsOf(input).map((e) => e.path)).toEqual(["keys[0].style.color"]);
  });

  it("rejects non-finite and out-of-bounds numbers", () => {
    const input = roundTrip(valid) as { keys: { style: Record<string, unknown> }[]; view: Record<string, unknown> };
    input.keys[0]!.style["x"] = Number.NaN;
    input.keys[1]!.style["w"] = 0;
    input.keys[2]!.style["y"] = LIMITS.coordinate + 1;
    input.view["zoom"] = 100;
    expect(errorsOf(input).map((e) => e.path)).toEqual(["keys[0].style.x", "keys[1].style.w", "keys[2].style.y", "view.zoom"]);
  });

  it("enforces string length limits", () => {
    const input = roundTrip(valid) as { keys: { name: string; note: string }[] };
    input.keys[0]!.name = "n".repeat(LIMITS.nameLength + 1);
    input.keys[1]!.note = "n".repeat(LIMITS.noteLength + 1);
    input.keys[2]!.name = "n".repeat(LIMITS.nameLength);
    expect(errorsOf(input).map((e) => e.path)).toEqual(["keys[0].name", "keys[1].note"]);
  });

  it("rejects more nodes or edges than the limits instead of truncating", () => {
    const keys = Array.from({ length: LIMITS.nodes + 1 }, (_, i) => key(`k${String(i)}`));
    expect(errorsOf(roundTrip(trustDocument({ keys })))).toEqual([{ path: "", message: expect.stringContaining("2000") as string }]);

    const edges = Array.from({ length: LIMITS.edges + 1 }, (_, i) => unlocks(`k${String(i)}`, "vault"));
    expect(errorsOf(roundTrip(trustDocument({ edges }))).map((e) => e.path)).toEqual(["edges"]);
  });

  it("rejects malformed and duplicate ids", () => {
    const input = roundTrip(valid) as { keys: { id: string }[]; rules: { id: string }[] };
    input.keys[0]!.id = "has space";
    input.rules[0]!.id = "vault";
    const paths = errorsOf(input).map((e) => e.path);
    expect(paths).toContain("keys[0].id");
    expect(paths).toContain("rules[0].id");
  });

  it("checks edge endpoint types", () => {
    const doc = trustDocument({
      databases: [database("d1"), database("d2")],
      keys: [key("k1"), key("k2")],
      edges: [contains("k1", "d1"), unlocks("d1", "d2"), unlocks("k1", "k2"), contains("d1", "missing")],
    });
    expect(errorsOf(roundTrip(doc)).map((e) => e.path)).toEqual(["edges[0].from", "edges[1].from", "edges[2].to", "edges[3].to"]);
  });

  it("allows a contains self-loop, which the cycle check reports later", () => {
    const doc = trustDocument({ databases: [database("d1")], edges: [contains("d1", "d1")] });
    expect(parseDocument(roundTrip(doc)).ok).toBe(true);
  });

  it("validates rule references on edges", () => {
    const doc = trustDocument({
      databases: [database("d1"), database("d2")],
      keys: [key("k1"), key("k2")],
      edges: [
        { ...partial("k1", "d1", "r1"), ruleId: null },
        partial("k1", "d1", "missing"),
        partial("k2", "d2", "r1"),
        { ...unlocks("k1", "d2"), ruleId: "r1" },
        partial("k2", "d1", "r1"),
      ],
      rules: [rule("r1", "d1", 1)],
    });
    expect(errorsOf(roundTrip(doc)).map((e) => e.path)).toEqual(["edges[0].ruleId", "edges[1].ruleId", "edges[2].ruleId", "edges[3].ruleId"]);
  });

  it("requires 1 <= threshold <= keys in rule", () => {
    const doc = trustDocument({
      databases: [database("d1")],
      keys: [key("k1"), key("k2")],
      edges: [partial("k1", "d1", "r1"), partial("k2", "d1", "r1")],
      rules: [rule("r1", "d1", 3), rule("r2", "d1", 1), rule("r3", "d1", 0)],
    });
    expect(errorsOf(roundTrip(doc)).map((e) => e.path)).toEqual(["rules[2].threshold", "rules[0].threshold", "rules[1]", "rules[2]"]);
  });

  it("rejects a non-integer threshold", () => {
    const doc = trustDocument({
      databases: [database("d1")],
      keys: [key("k1"), key("k2")],
      edges: [partial("k1", "d1", "r1"), partial("k2", "d1", "r1")],
      rules: [rule("r1", "d1", 1.5)],
    });
    expect(errorsOf(roundTrip(doc)).map((e) => e.path)).toEqual(["rules[0].threshold"]);
  });

  it("rejects duplicate connections", () => {
    const doc = trustDocument({
      databases: [database("d1")],
      keys: [key("k1")],
      edges: [unlocks("k1", "d1"), { ...unlocks("k1", "d1"), id: "other" }],
    });
    expect(errorsOf(roundTrip(doc))).toEqual([{ path: "edges[1]", message: "Duplicate connection" }]);
  });

  it("checks location and scenario references", () => {
    const doc = trustDocument({
      databases: [database("d1", { locationId: "nowhere" })],
      keys: [key("k1")],
      scenarios: [
        {
          id: "s1",
          name: "Bad",
          events: [
            { type: "key-forgotten", keyId: "d1" },
            { type: "database-stolen", databaseId: "k1" },
            { type: "location-compromised", locationId: "x" },
          ],
        },
      ],
    });
    expect(errorsOf(roundTrip(doc)).map((e) => e.path)).toEqual([
      "databases[0].locationId",
      "scenarios[0].events[0].keyId",
      "scenarios[0].events[1].databaseId",
      "scenarios[0].events[2].locationId",
    ]);
  });

  it("rejects duplicate and unknown data types", () => {
    const input = roundTrip(valid) as { databases: { dataTypes: string[] }[] };
    input.databases[0]!.dataTypes = ["files", "files", "gold"];
    expect(errorsOf(input).map((e) => e.path)).toEqual(["databases[0].dataTypes[1]", "databases[0].dataTypes[2]"]);
  });

  it("reports missing fields instead of guessing defaults", () => {
    const input = roundTrip(valid) as { keys: Record<string, unknown>[] };
    delete input.keys[0]!["memorized"];
    delete input.keys[0]!["style"];
    const paths = errorsOf(input).map((e) => e.path);
    expect(paths).toContain("keys[0].memorized");
    expect(paths).toContain("keys[0].style");
  });
});
