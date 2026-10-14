import { describe, expect, it } from "vitest";
import { analyzeDocument } from "../../src/core/issues";
import { parseDocument } from "../../src/core/schema";
import backwardKey from "../fixtures/backward-key.json";
import backwardKeyExpected from "../fixtures/backward-key.expected.json";
import kdbxInsideRestic from "../fixtures/kdbx-inside-restic.json";
import kdbxInsideResticExpected from "../fixtures/kdbx-inside-restic.expected.json";
import selfStoredKey from "../fixtures/self-stored-key.json";
import selfStoredKeyExpected from "../fixtures/self-stored-key.expected.json";

interface Expected {
  circularGroups: { severity: string; nodeIds: string[]; cycleEdgeIds: string[] }[];
  baselineOpen: string[];
  baselineKnown: string[];
  issues: { code: string; nodeIds: string[] }[];
}

const fixtures: [string, unknown, Expected][] = [
  ["self-stored-key", selfStoredKey, selfStoredKeyExpected],
  ["backward-key", backwardKey, backwardKeyExpected],
  ["kdbx-inside-restic", kdbxInsideRestic, kdbxInsideResticExpected],
];

describe.each(fixtures)("fixture %s", (_, input, expected) => {
  const parsed = parseDocument(input);
  if (!parsed.ok) throw new Error(`fixture is invalid: ${JSON.stringify(parsed.error)}`);
  const analysis = analyzeDocument(parsed.value);

  it("has the expected circular groups", () => {
    expect(
      analysis.circularGroups.map((g) => ({ severity: g.severity, nodeIds: g.nodeIds, cycleEdgeIds: g.cycle.map((a) => a.edgeId) })),
    ).toEqual(expected.circularGroups);
  });

  it("opens the expected databases and knows the expected keys on a normal day", () => {
    expect([...analysis.baseline.open.keys()].sort()).toEqual(expected.baselineOpen);
    expect([...analysis.baseline.known.keys()].sort()).toEqual(expected.baselineKnown);
  });

  it("reports the expected issues in order", () => {
    expect(analysis.issues.map((i) => ({ code: i.code, nodeIds: i.nodeIds }))).toEqual(expected.issues);
  });
});
