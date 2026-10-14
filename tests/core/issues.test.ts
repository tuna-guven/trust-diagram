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

describe("ephemeral databases", () => {
  it("raise no circular issue, but keys only they held are still stored nowhere", () => {
    const doc = trustDocument({
      databases: [database("tails", { category: "session", ephemeral: true, protection: "none" })],
      keys: [key("generated")],
      edges: [contains("tails", "generated"), unlocks("generated", "tails")],
    });
    const analysis = analyzeDocument(doc);
    expect(analysis.circularGroups).toEqual([]);
    expect(analysis.issues.map((i) => i.code)).toEqual(["key-unobtainable", "key-unlocks-nothing"]);
  });

  it("are not flagged for missing unlock rules", () => {
    const doc = trustDocument({ databases: [database("setup", { ephemeral: true })] });
    expect(codesFor(doc, "setup")).toEqual([]);
  });

  it("are flagged when marked critical, because they can never be recovered", () => {
    const doc = trustDocument({ databases: [database("setup", { ephemeral: true, critical: true, protection: "none" })] });
    const [first] = analyzeDocument(doc).issues;
    expect(first).toMatchObject({ code: "critical-not-openable", severity: "warning", nodeIds: ["setup"] });
    expect(first?.message).toContain("is ephemeral");
  });

  it("do not count as something a key unlocks", () => {
    const doc = trustDocument({
      databases: [database("setup", { ephemeral: true }), database("vault")],
      keys: [key("only-setup", { memorized: true }), key("both", { memorized: true })],
      edges: [unlocks("only-setup", "setup"), unlocks("both", "setup"), unlocks("both", "vault")],
    });
    expect(codesFor(doc, "only-setup")).toContain("key-unlocks-nothing");
    expect(codesFor(doc, "both")).not.toContain("key-unlocks-nothing");
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
    ["9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", true],
    ["key 0x9F86D081884C7D659A2FEAA0C55AD015", true],
    ["9f86d081884c7d659a2feaa0c55ad015A3BF", false],
    ["deadbeefdeadbeefdeadbeefdeadbeef", false],
    ["JBSWY3DPEHPK3PXP", true],
    ["seed JBSW Y3DP EHPK 3PXP for the bank", true],
    ["JBSW-Y3DP-EHPK-3PXP", true],
    ["KEYS DISK HOME SAFE", false],
    ["LUKS2 AES XTS PLAIN64 SHA256", false],
    ["abandon ability able about above absent absorb abstract absurd abuse access accident", false],
  ])("%s -> %s", (text, expected) => {
    expect(looksLikeSecret(text)).toBe(expected);
  });

  it("produces one info issue per entity, naming the fields but not their text", () => {
    const secret = "Xk9#mQ2$vL7pW4@nR8zT";
    const doc = trustDocument({
      locations: [location("loc", { name: secret, note: `stored here: ${secret}` })],
      databases: [database("db", { locationDetail: secret, protection: "none" })],
    });
    const issues = analyzeDocument(doc).issues.filter((i) => i.code === "text-looks-secret");
    expect(issues).toMatchObject([
      { severity: "info", nodeIds: ["db"], message: "The location detail looks like a real secret. Do not enter real secrets." },
      { severity: "info", nodeIds: ["loc"], message: "The name and note look like a real secret. Do not enter real secrets." },
    ]);
    expect(issues.some((i) => i.message.includes(secret))).toBe(false);
  });

  it("never repeats a secret-looking name in any issue message", () => {
    const secret = "Xk9#mQ2$vL7pW4@nR8zT";
    const doc = trustDocument({
      locations: [home],
      databases: [
        database("recovery", { name: secret, locationId: "home", critical: true }),
        database("orphan", { name: `${secret}-2` }),
      ],
      keys: [key("master", { name: `${secret}-3` }), key("memo", { name: `${secret}-4`, memorized: true })],
      edges: [contains("recovery", "master"), unlocks("master", "recovery")],
    });
    const messages = analyzeDocument(doc)
      .issues.filter((i) => i.code !== "text-looks-secret")
      .map((i) => i.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringContaining("(name hidden: looks like a secret) → unlocks → [(name hidden: looks like a secret)]"),
        "Critical database [(name hidden: looks like a secret)] cannot be opened on a normal day.",
        "[(name hidden: looks like a secret)] is protected but has no unlock rule, so it can never be opened.",
        '"(name hidden: looks like a secret)" is only memorized. Forgetting it loses it.',
      ]),
    );
    expect(messages.some((m) => m.includes(secret))).toBe(false);
  });

  it("keeps ordinary names in issue messages", () => {
    const doc = trustDocument({ keys: [key("k", { name: "LUKS2 passphrase", memorized: true })] });
    expect(analyzeDocument(doc).issues.map((i) => i.message)).toContain('"LUKS2 passphrase" is only memorized. Forgetting it loses it.');
  });

  it.each<[string, Partial<TrustDocument>, string, string]>([
    ["document title", { title: "JBSWY3DPEHPK3PXP" }, "doc", "title"],
    ["document notes", { notes: "JBSWY3DPEHPK3PXP" }, "doc", "notes"],
    ["key note", { keys: [key("k", { memorized: true, note: "JBSWY3DPEHPK3PXP" })] }, "k", "note"],
    [
      "database product, encryption and note",
      { databases: [database("d", { protection: "none", product: "JBSWY3DPEHPK3PXP", encryption: "JBSWY3DPEHPK3PXP", note: "JBSWY3DPEHPK3PXP" })] },
      "d",
      "product, encryption and note",
    ],
    ["rule label", { databases: [database("d")], keys: [key("k")], edges: [partial("k", "d", "r")], rules: [{ ...rule("r", "d", 1), label: "JBSWY3DPEHPK3PXP" }] }, "r", "label"],
    ["scenario name", { scenarios: [{ id: "s", name: "JBSWY3DPEHPK3PXP", events: [] }] }, "s", "name"],
  ])("scans the %s", (_, parts, id, fields) => {
    const issue = analyzeDocument(trustDocument(parts)).issues.find((i) => i.code === "text-looks-secret");
    expect(issue?.nodeIds).toEqual([id]);
    expect(issue?.message).toMatch(new RegExp(`^The ${fields} looks? like a real secret`));
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
