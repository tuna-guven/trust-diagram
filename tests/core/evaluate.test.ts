import { describe, expect, it } from "vitest";
import { BASELINE_STATE, evaluate, ownerFacts, type BaseFacts, type Evaluation, type OwnerState } from "../../src/core/evaluate";
import { indexDocument } from "../../src/core/graph";
import type { Database, Edge, Key, TrustDocument, UnlockRule } from "../../src/core/model";
import { contains, database, key, location, partial, rule, seededRandom, trustDocument, unlocks } from "./builders";

function run(doc: TrustDocument, state: Partial<OwnerState> = {}) {
  return evaluate(indexDocument(doc), ownerFacts(doc, { ...BASELINE_STATE, ...state }));
}

function sorted(ids: Iterable<string>): string[] {
  return [...ids].sort();
}

// Laptop at home, unlocked by a memorized disk passphrase; the laptop holds a KeePass
// file opened by a memorized passphrase plus a YubiKey response; the YubiKey (in a
// drawer at home) is opened by a memorized PIN and yields the response.
const laptopChain = trustDocument({
  locations: [location("home")],
  databases: [
    database("laptop", { category: "device", locationId: "home" }),
    database("daily", { locationId: null }),
    database("yubikey", { category: "hardware-token", locationId: "home" }),
  ],
  keys: [
    key("disk-pass", { memorized: true }),
    key("daily-pass", { memorized: true }),
    key("yk-pin", { category: "pin", memorized: true }),
    key("yk-response", { category: "hardware-response" }),
    key("bank-login"),
  ],
  edges: [
    unlocks("disk-pass", "laptop"),
    contains("laptop", "daily"),
    unlocks("yk-pin", "yubikey"),
    contains("yubikey", "yk-response"),
    partial("daily-pass", "daily", "rule-a"),
    partial("yk-response", "daily", "rule-a"),
    contains("daily", "bank-login"),
  ],
  rules: [rule("rule-a", "daily", 2)],
});

describe("evaluate (baseline)", () => {
  it("opens the whole chain with provenance", () => {
    const result = run(laptopChain);
    expect(sorted(result.open.keys())).toEqual(["daily", "laptop", "yubikey"]);
    expect(result.available.get("laptop")).toEqual({ kind: "location", locationId: "home" });
    expect(result.available.get("daily")).toEqual({ kind: "container", databaseId: "laptop", edgeId: "c-laptop-daily" });
    expect(result.open.get("laptop")).toEqual({ kind: "full", keyId: "disk-pass", edgeId: "u-disk-pass-laptop" });
    expect(result.open.get("daily")).toEqual({ kind: "rule", ruleId: "rule-a", keyIds: ["daily-pass", "yk-response"] });
    expect(result.known.get("disk-pass")).toEqual({ kind: "base" });
    expect(result.known.get("yk-response")).toEqual({ kind: "contained", databaseId: "yubikey", edgeId: "c-yubikey-yk-response" });
    expect(result.known.has("bank-login")).toBe(true);
  });

  it("closes the database when the partial rule is not met", () => {
    const result = run(laptopChain, { forgottenKeys: new Set(["yk-pin"]) });
    expect(result.available.has("daily")).toBe(true);
    expect(result.open.has("daily")).toBe(false);
    expect(result.known.has("bank-login")).toBe(false);
  });

  it("makes nothing at an unreachable location available", () => {
    const result = run(laptopChain, { unreachableLocations: new Set(["home"]) });
    expect(result.available.size).toBe(0);
    expect(result.open.size).toBe(0);
    expect(sorted(result.known.keys())).toEqual(["daily-pass", "disk-pass", "yk-pin"]);
  });

  it("treats a lost container as making its contents unavailable", () => {
    const result = run(laptopChain, { missingDatabases: new Set(["laptop"]) });
    expect(result.available.has("laptop")).toBe(false);
    expect(result.available.has("daily")).toBe(false);
  });

  it("needs any one open container, or a reachable location", () => {
    const doc = trustDocument({
      locations: [location("home"), location("office")],
      databases: [
        database("hdd-1", { locationId: "home", protection: "none" }),
        database("hdd-2", { locationId: "office", protection: "none" }),
        database("vault", { locationId: null, protection: "none" }),
        database("synced", { locationId: "office", protection: "none" }),
      ],
      edges: [contains("hdd-1", "vault"), contains("hdd-2", "vault"), contains("hdd-1", "synced")],
    });
    expect(run(doc, { unreachableLocations: new Set(["home"]) }).open.has("vault")).toBe(true);
    expect(run(doc, { missingDatabases: new Set(["hdd-1", "hdd-2"]) }).open.has("vault")).toBe(false);
    expect(run(doc, { unreachableLocations: new Set(["home"]) }).available.get("synced")).toEqual({ kind: "location", locationId: "office" });
  });

  it("follows nested containers", () => {
    const doc = trustDocument({
      locations: [location("home")],
      databases: [
        database("a", { locationId: "home", protection: "none" }),
        database("b", { protection: "none" }),
        database("c", { protection: "none" }),
      ],
      keys: [key("deep")],
      edges: [contains("a", "b"), contains("b", "c"), contains("c", "deep")],
    });
    expect(run(doc).known.get("deep")).toEqual({ kind: "contained", databaseId: "c", edgeId: "c-c-deep" });
  });

  it("never makes an ephemeral database available", () => {
    const doc = trustDocument({
      locations: [location("home")],
      databases: [database("tails", { category: "session", ephemeral: true, locationId: "home", protection: "none" })],
      keys: [key("generated")],
      edges: [contains("tails", "generated")],
    });
    const result = run(doc);
    expect(result.available.size).toBe(0);
    expect(result.known.size).toBe(0);
  });

  it("opens an unprotected database as soon as it is available", () => {
    const doc = trustDocument({
      locations: [location("bank")],
      databases: [database("plate", { category: "offline-backup", locationId: "bank", protection: "none" })],
    });
    expect(run(doc).open.get("plate")).toEqual({ kind: "unprotected" });
  });

  it("applies k-of-n thresholds", () => {
    const doc = trustDocument({
      locations: [location("home")],
      databases: [database("seed", { locationId: "home" })],
      keys: [key("s1", { memorized: true }), key("s2"), key("s3", { memorized: true })],
      edges: [partial("s1", "seed", "r"), partial("s2", "seed", "r"), partial("s3", "seed", "r")],
      rules: [rule("r", "seed", 2)],
    });
    expect(run(doc).open.get("seed")).toEqual({ kind: "rule", ruleId: "r", keyIds: ["s1", "s3"] });
    expect(run(doc, { forgottenKeys: new Set(["s3"]) }).open.has("seed")).toBe(false);
  });

  it("knows biometrics unless disabled", () => {
    const doc = trustDocument({
      locations: [location("pocket")],
      databases: [database("phone", { category: "device", locationId: "pocket" })],
      keys: [key("finger", { category: "biometric" })],
      edges: [unlocks("finger", "phone")],
    });
    expect(run(doc).open.has("phone")).toBe(true);
    expect(run(doc, { unavailableBiometrics: new Set(["finger"]) }).open.has("phone")).toBe(false);
  });

  it("is a least fixpoint: a database storing its only key never opens", () => {
    const doc = trustDocument({
      locations: [location("home")],
      databases: [database("recovery", { locationId: "home" })],
      keys: [key("master")],
      edges: [contains("recovery", "master"), unlocks("master", "recovery")],
    });
    const result = run(doc);
    expect(result.available.has("recovery")).toBe(true);
    expect(result.open.size).toBe(0);
    expect(result.known.size).toBe(0);
  });

  it("makes held databases available regardless of location", () => {
    const facts: BaseFacts = {
      reachableLocations: new Set(),
      knownKeys: new Set(["disk-pass"]),
      heldDatabases: new Set(["laptop"]),
      excludedDatabases: new Set(),
    };
    const result = evaluate(indexDocument(laptopChain), facts);
    expect(result.available.get("laptop")).toEqual({ kind: "held" });
    expect(result.open.has("laptop")).toBe(true);
  });

  it("records the shallowest derivation", () => {
    // "vault" can be opened directly by a memorized key or via a key two hops away.
    const doc = trustDocument({
      locations: [location("home")],
      databases: [database("a", { locationId: "home", protection: "none" }), database("vault", { locationId: "home" })],
      keys: [key("a-key"), key("z-key", { memorized: true })],
      edges: [contains("a", "a-key"), unlocks("a-key", "vault"), unlocks("z-key", "vault")],
    });
    expect(run(doc).open.get("vault")).toEqual({ kind: "full", keyId: "z-key", edgeId: "u-z-key-vault" });
  });

  it("records the shallowest container, not one opened in the same round", () => {
    // "a2" sorts before "z1" but only opens in round 2 (via "a1"); "z1" opens in round 1.
    const doc = trustDocument({
      locations: [location("home")],
      databases: [
        database("a1", { locationId: "home", protection: "none" }),
        database("a2", { protection: "none" }),
        database("target", { protection: "none" }),
        database("z1", { locationId: "home", protection: "none" }),
      ],
      edges: [contains("a1", "a2"), contains("a2", "target"), contains("z1", "target")],
    });
    expect(run(doc).available.get("target")).toEqual({ kind: "container", databaseId: "z1", edgeId: "c-z1-target" });
  });
});

interface Rounds {
  available: Map<string, number>;
  open: Map<string, number>;
  known: Map<string, number>;
}

/**
 * Naive reference: apply the 5.3 round rules literally, with no provenance, and record
 * the first round in which each fact holds (base facts are round 0).
 */
function naive(doc: TrustDocument, facts: BaseFacts): Rounds {
  const available = new Map<string, number>();
  const open = new Map<string, number>();
  const known = new Map<string, number>([...facts.knownKeys].map((id) => [id, 0]));
  for (let round = 1; ; round++) {
    const before = { available: new Set(available.keys()), open: new Set(open.keys()), known: new Set(known.keys()) };
    for (const d of doc.databases) {
      const containers = doc.edges.filter((e) => e.type === "contains" && e.to === d.id).map((e) => e.from);
      const isAvailable =
        before.available.has(d.id) ||
        (!d.ephemeral &&
          !facts.excludedDatabases.has(d.id) &&
          (facts.heldDatabases.has(d.id) ||
            (d.locationId !== null && facts.reachableLocations.has(d.locationId)) ||
            containers.some((c) => before.open.has(c))));
      const ruleMet = (r: UnlockRule): boolean =>
        doc.edges.filter((e) => e.ruleId === r.id && before.known.has(e.from)).length >= r.threshold;
      const isOpen =
        isAvailable &&
        (d.protection === "none" ||
          doc.edges.some((e) => e.type === "unlocks-full" && e.to === d.id && before.known.has(e.from)) ||
          doc.rules.some((r) => r.databaseId === d.id && ruleMet(r)));
      if (isAvailable && !available.has(d.id)) available.set(d.id, round);
      if (isOpen && !open.has(d.id)) open.set(d.id, round);
    }
    for (const e of doc.edges) {
      if (e.type === "contains" && before.open.has(e.from) && !known.has(e.to) && doc.keys.some((k) => k.id === e.to)) {
        known.set(e.to, round);
      }
    }
    if (available.size === before.available.size && open.size === before.open.size && known.size === before.known.size) {
      return { available, open, known };
    }
  }
}

/** The round of each fact implied by the recorded provenance, following the reasons back to base facts. */
function provenanceRounds(result: Evaluation): Rounds {
  const rounds: Rounds = { available: new Map(), open: new Map(), known: new Map() };
  const visiting = new Set<string>();
  const memo = (kind: keyof Rounds, id: string, compute: () => number): number => {
    const cached = rounds[kind].get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(`${kind}:${id}`)) throw new Error(`provenance of ${kind} ${id} is circular`);
    visiting.add(`${kind}:${id}`);
    const value = compute();
    rounds[kind].set(id, value);
    return value;
  };
  const knownRound = (id: string): number =>
    memo("known", id, () => {
      const reason = result.known.get(id)!;
      return reason.kind === "base" ? 0 : openRound(reason.databaseId) + 1;
    });
  const availableRound = (id: string): number =>
    memo("available", id, () => {
      const reason = result.available.get(id)!;
      return reason.kind === "container" ? openRound(reason.databaseId) + 1 : 1;
    });
  const openRound = (id: string): number =>
    memo("open", id, () => {
      const reason = result.open.get(id)!;
      const keyIds = reason.kind === "unprotected" ? [] : reason.kind === "full" ? [reason.keyId] : reason.keyIds;
      return Math.max(availableRound(id), ...keyIds.map((k) => knownRound(k) + 1));
    });
  for (const id of result.known.keys()) knownRound(id);
  for (const id of result.available.keys()) availableRound(id);
  for (const id of result.open.keys()) openRound(id);
  return rounds;
}

/** Every recorded reason only refers to facts that hold. */
function expectSoundProvenance(result: Evaluation): void {
  for (const reason of result.available.values()) {
    if (reason.kind === "container") expect(result.open.has(reason.databaseId)).toBe(true);
  }
  for (const reason of result.open.values()) {
    if (reason.kind === "full") expect(result.known.has(reason.keyId)).toBe(true);
    if (reason.kind === "rule") expect(reason.keyIds.every((id) => result.known.has(id))).toBe(true);
  }
  for (const reason of result.known.values()) {
    if (reason.kind === "contained") expect(result.open.has(reason.databaseId)).toBe(true);
  }
}

function sortedEntries(map: ReadonlyMap<string, number>): [string, number][] {
  return [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function expectMatchesNaive(doc: TrustDocument, facts: BaseFacts): void {
  const result = evaluate(indexDocument(doc), facts);
  const expected = naive(doc, facts);
  expect(sorted(result.available.keys())).toEqual(sorted(expected.available.keys()));
  expect(sorted(result.open.keys())).toEqual(sorted(expected.open.keys()));
  expect(sorted(result.known.keys())).toEqual(sorted(expected.known.keys()));
  expectSoundProvenance(result);

  // The recorded derivations are as shallow as possible (DESIGN.md 5.3).
  const rounds = provenanceRounds(result);
  expect(sortedEntries(rounds.available)).toEqual(sortedEntries(expected.available));
  expect(sortedEntries(rounds.open)).toEqual(sortedEntries(expected.open));
  expect(sortedEntries(rounds.known)).toEqual(sortedEntries(expected.known));
}

function subset<T>(random: () => number, items: readonly T[], probability: number): Set<T> {
  return new Set(items.filter(() => random() < probability));
}

function shuffle<T>(random: () => number, items: readonly T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

function randomDocument(random: () => number): TrustDocument {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const locations = [location("l0"), location("l1")];
  const databases: Database[] = Array.from({ length: 1 + Math.floor(random() * 7) }, (_, i) =>
    database(`d${String(i)}`, {
      locationId: random() < 0.4 ? pick(["l0", "l1"]) : null,
      protection: random() < 0.2 ? "none" : "rules",
      ephemeral: random() < 0.1,
    }),
  );
  const keys: Key[] = Array.from({ length: 1 + Math.floor(random() * 7) }, (_, i) =>
    key(`k${String(i)}`, { memorized: random() < 0.3, category: random() < 0.1 ? "biometric" : "passphrase" }),
  );
  const edges = new Map<string, Edge>();
  const rules: UnlockRule[] = [];
  for (let i = 0; i < Math.floor(random() * 14); i++) {
    const d = pick(databases).id;
    const k = pick(keys).id;
    const roll = random();
    const edge =
      roll < 0.3 ? contains(d, k) : roll < 0.45 ? contains(d, pick(databases).id) : roll < 0.75 ? unlocks(k, d) : partial(k, d, `r-${d}`);
    edges.set(edge.id, edge);
  }
  for (const d of databases) {
    const keyCount = [...edges.values()].filter((e) => e.ruleId === `r-${d.id}`).length;
    if (keyCount > 0) rules.push(rule(`r-${d.id}`, d.id, 1 + Math.floor(random() * keyCount)));
  }
  return trustDocument({ locations, databases, keys, edges: [...edges.values()], rules });
}

describe("evaluate properties", () => {
  it("matches the naive fixpoint for random owner states", () => {
    const random = seededRandom(7);
    for (let runIndex = 0; runIndex < 1000; runIndex++) {
      const doc = randomDocument(random);
      const biometrics = doc.keys.filter((k) => k.category === "biometric").map((k) => k.id);
      const state: OwnerState = {
        unreachableLocations: new Set(random() < 0.3 ? ["l0"] : []),
        forgottenKeys: subset(random, doc.keys.map((k) => k.id), 0.2),
        missingDatabases: subset(random, doc.databases.map((d) => d.id), 0.15),
        unavailableBiometrics: subset(random, biometrics, 0.5),
      };
      expectMatchesNaive(doc, ownerFacts(doc, state));
    }
  });

  it("matches the naive fixpoint for arbitrary base facts, including held databases", () => {
    const random = seededRandom(8);
    for (let runIndex = 0; runIndex < 1000; runIndex++) {
      const doc = randomDocument(random);
      const databaseIds = doc.databases.map((d) => d.id);
      const facts: BaseFacts = {
        reachableLocations: subset(random, ["l0", "l1"], 0.5),
        knownKeys: subset(random, doc.keys.map((k) => k.id), 0.3),
        heldDatabases: subset(random, databaseIds, 0.25),
        excludedDatabases: subset(random, databaseIds, 0.15),
      };
      expectMatchesNaive(doc, facts);
    }
  });

  it("records the same provenance, in the same order, regardless of document order", () => {
    const random = seededRandom(9);
    const entries = (doc: TrustDocument) => {
      const result = run(doc);
      return { available: [...result.available], open: [...result.open], known: [...result.known] };
    };
    for (let runIndex = 0; runIndex < 300; runIndex++) {
      const doc = randomDocument(random);
      const shuffled: TrustDocument = {
        ...doc,
        databases: shuffle(random, doc.databases),
        keys: shuffle(random, doc.keys),
        edges: shuffle(random, doc.edges),
        rules: shuffle(random, doc.rules),
      };
      expect(entries(shuffled)).toEqual(entries(doc));
    }
  });
});
