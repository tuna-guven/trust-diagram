import { describe, expect, it } from "vitest";
import { analyzeDocument, looksLikeSecret, type IssueCode } from "../../src/core/issues";
import type { TrustDocument } from "../../src/core/model";
import { contains, database, key, location, partial, rule, trustDocument, unlocks } from "./builders";

function codesFor(doc: TrustDocument, nodeId: string): IssueCode[] {
  return analyzeDocument(doc)
    .issues.filter((i) => i.nodeIds.includes(nodeId))
    .map((i) => i.code);
}

const home = location("home");

describe("circular group issues", () => {
  it("reports a blocking loop as an error with the concrete cycle", () => {
    const doc = trustDocument({
      locations: [home],
      databases: [database("recovery", { name: "Recovery DB", locationId: "home" })],
      keys: [key("master", { name: "master passphrase" })],
      edges: [contains("recovery", "master"), unlocks("master", "recovery")],
    });
    const [first] = analyzeDocument(doc).issues;
    expect(first).toMatchObject({ code: "circular-blocking", severity: "error", nodeIds: ["master", "recovery"] });
    expect(first?.edgeIds).toEqual(["c-recovery-master", "u-master-recovery"]);
    expect(first?.message).toContain("master passphrase → unlocks → [Recovery DB] → contains → master passphrase");
    expect(first?.message).toContain("Cannot be opened: [Recovery DB]");
  });

  it("reports a loop with an outside path as a redundant warning", () => {
    const doc = trustDocument({
      locations: [home],
      databases: [database("recovery", { locationId: "home" }), database("plate", { locationId: "home", protection: "none" })],
      keys: [key("master")],
      edges: [contains("recovery", "master"), unlocks("master", "recovery"), contains("plate", "master")],
    });
    const analysis = analyzeDocument(doc);
    expect(analysis.circularGroups.map((g) => g.severity)).toEqual(["redundant"]);
    expect(analysis.issues[0]).toMatchObject({ code: "circular-redundant", severity: "warning" });
  });
});

describe("database issues", () => {
  it("flags a protected database without any unlock rule", () => {
    const doc = trustDocument({ databases: [database("orphan"), database("open", { protection: "none" })] });
    expect(codesFor(doc, "orphan")).toContain("database-without-rule");
    expect(codesFor(doc, "open")).not.toContain("database-without-rule");
  });

  it("counts a k-of-n rule as an unlock rule", () => {
    const doc = trustDocument({
      databases: [database("seed")],
      keys: [key("s1", { memorized: true })],
      edges: [partial("s1", "seed", "r")],
      rules: [rule("r", "seed", 1)],
    });
    expect(codesFor(doc, "seed")).not.toContain("database-without-rule");
  });

  it("flags a critical database that does not open in the baseline", () => {
    const doc = trustDocument({
      locations: [home],
      databases: [database("restic", { critical: true, locationId: "home" }), database("fine", { critical: true, locationId: "home", protection: "none" })],
    });
    expect(codesFor(doc, "restic")).toContain("critical-not-openable");
    expect(codesFor(doc, "fine")).not.toContain("critical-not-openable");
  });
});

describe("key issues", () => {
  const doc = trustDocument({
    locations: [home],
    databases: [
      database("vault", { locationId: "home", protection: "none" }),
      database("backup", { locationId: "home", protection: "none" }),
      database("setup", { ephemeral: true, protection: "none" }),
      database("target"),
    ],
    keys: [
      key("lost"),
      key("brain", { memorized: true }),
      key("single"),
      key("double"),
      key("brain-and-vault", { memorized: true }),
      key("setup-only"),
      key("finger", { category: "biometric" }),
    ],
    edges: [
      contains("vault", "single"),
      contains("vault", "double"),
      contains("backup", "double"),
      contains("vault", "brain-and-vault"),
      contains("setup", "setup-only"),
      ...["lost", "brain", "single", "double", "brain-and-vault", "setup-only", "finger"].map((k) => unlocks(k, "target")),
    ],
  });

  it.each<[string, IssueCode[]]>([
    ["lost", ["key-unobtainable"]],
    ["brain", ["key-only-memorized"]],
    ["single", ["key-single-copy"]],
    ["double", []],
    ["brain-and-vault", []],
    ["setup-only", ["key-unobtainable"]],
    ["finger", []],
  ])("%s -> %j", (id, codes) => {
    expect(codesFor(doc, id)).toEqual(codes);
  });

  it("flags a key that unlocks nothing", () => {
    const lonely = trustDocument({ keys: [key("lonely", { memorized: true })] });
    expect(codesFor(lonely, "lonely")).toEqual(["key-only-memorized", "key-unlocks-nothing"]);
  });
});

describe("looksLikeSecret", () => {
  it.each([
    ["correct horse battery staple", false],
    ["/home/user/Documents/vault.kdbx", false],
    ["/media/Backup-2026/Restic/Laptop_2026-10-14", false],
    ["Backblaze-B2-restic-laptop-2026-repo", false],
    ["C:\\Users\\Tuna\\Backups\\2026-10-14", false],
    ["https://example.com/Path/To/File-2026.txt", false],
    ["sk-proj-3Ab9xQ7mTz2LkP5wR8vY1nC4", true],
    ["0123456789abcdefABCDEF0123", false],
    ["YubiKey 5 NFC (backup)", false],
    ["AES-256-XTS (LUKS2)", false],
    ["Backblaze B2 bucket restic-laptop-2026", false],
    ["Xk9#mQ2$vL7pW4@nR8zT", true],
    ["token: ghp_8fK2mQ9xLp4ZrT7vWc1Ns6Yb3", true],
  ])("%s -> %s", (name, expected) => {
    expect(looksLikeSecret(name)).toBe(expected);
  });

  it("produces an info issue on any named entity", () => {
    const doc = trustDocument({ locations: [location("loc", { name: "Xk9#mQ2$vL7pW4@nR8zT" })] });
    expect(analyzeDocument(doc).issues).toMatchObject([{ code: "name-looks-secret", severity: "info", nodeIds: ["loc"] }]);
  });
});

describe("issue ordering", () => {
  it("sorts by severity, then code, then node id, independent of document order", () => {
    const doc = trustDocument({
      databases: [database("z-orphan"), database("a-orphan"), database("loop", { protection: "none" })],
      keys: [key("k-lost"), key("k-unused", { memorized: true })],
      edges: [contains("loop", "loop")],
    });
    const codes = (d: TrustDocument): string[] => analyzeDocument(d).issues.map((i) => `${i.code}:${i.nodeIds.join(",")}`);
    expect(codes(doc)).toEqual([
      "circular-blocking:loop",
      "database-without-rule:a-orphan",
      "database-without-rule:z-orphan",
      "key-unobtainable:k-lost",
      "key-only-memorized:k-unused",
      "key-unlocks-nothing:k-lost",
      "key-unlocks-nothing:k-unused",
    ]);
    const reversed = { ...doc, databases: [...doc.databases].reverse(), keys: [...doc.keys].reverse(), edges: [...doc.edges].reverse() };
    expect(codes(reversed)).toEqual(codes(doc));
  });
});
