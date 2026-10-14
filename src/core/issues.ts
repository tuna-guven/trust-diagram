// Issue list (DESIGN.md 6.1), computed from the circularity check (5.2) and the
// baseline evaluation (5.4). Issues are sorted by severity, code, then node id.

import { classifyCircularGroups, findCircularGroups, type ClassifiedGroup } from "./cycles";
import { BASELINE_STATE, evaluate, ownerFacts, type Evaluation } from "./evaluate";
import { buildGraph, indexDocument, type Arc, type DocumentIndex } from "./graph";
import { compareIds, type Id, type Key, type TrustDocument } from "./model";

export type IssueSeverity = "error" | "warning" | "info";

export const ISSUE_CODES = [
  "circular-blocking",
  "circular-redundant",
  "database-without-rule",
  "key-unobtainable",
  "key-only-memorized",
  "critical-not-openable",
  "key-single-copy",
  "key-unlocks-nothing",
  "name-looks-secret",
] as const;
export type IssueCode = (typeof ISSUE_CODES)[number];

export interface Issue {
  code: IssueCode;
  severity: IssueSeverity;
  message: string;
  /** Sorted ids of the databases, keys and locations involved. */
  nodeIds: readonly Id[];
  /** Sorted ids of the edges involved. */
  edgeIds: readonly Id[];
}

export interface Analysis {
  index: DocumentIndex;
  baseline: Evaluation;
  circularGroups: readonly ClassifiedGroup[];
  issues: readonly Issue[];
}

const SEVERITY_RANK: Record<IssueSeverity, number> = { error: 0, warning: 1, info: 2 };

// A pasted secret is a long word that mixes character classes, switches class between
// most neighbouring characters and has high per-character entropy. Labels and paths
// contain long runs of letters, so they fail the class-switch test (see DESIGN.md 6.1).
const SECRET_MIN_LENGTH = 20;
const SECRET_MIN_CLASSES = 3;
const SECRET_MIN_SWITCH_RATIO = 0.55;
const SECRET_MIN_ENTROPY_BITS = 3.5;

type CharClass = "lower" | "upper" | "digit" | "symbol";

function charClass(char: string): CharClass {
  if (char >= "a" && char <= "z") return "lower";
  if (char >= "A" && char <= "Z") return "upper";
  if (char >= "0" && char <= "9") return "digit";
  return "symbol";
}

function wordLooksLikeSecret(word: string): boolean {
  const chars = Array.from(word);
  if (chars.length < SECRET_MIN_LENGTH) return false;
  const classes = chars.map(charClass);
  if (new Set(classes).size < SECRET_MIN_CLASSES) return false;
  const switches = classes.filter((c, i) => i > 0 && c !== classes[i - 1]).length;
  if (switches / (chars.length - 1) < SECRET_MIN_SWITCH_RATIO) return false;
  const counts = new Map<string, number>();
  for (const char of chars) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / chars.length;
    entropy -= p * Math.log2(p);
  }
  return entropy >= SECRET_MIN_ENTROPY_BITS;
}

export function looksLikeSecret(name: string): boolean {
  return name.split(/\s+/).some(wordLooksLikeSecret);
}

function nodeLabel(index: DocumentIndex, id: Id): string {
  const database = index.databases.get(id);
  if (database !== undefined) return `[${database.name}]`;
  return index.keys.get(id)?.name ?? id;
}

/** "[Recovery DB] → contains → master passphrase → unlocks → [Recovery DB]" */
export function formatCycle(index: DocumentIndex, cycle: readonly Arc[]): string {
  const [first] = cycle;
  if (first === undefined) return "";
  const parts = [nodeLabel(index, first.from)];
  for (const arc of cycle) parts.push(arc.type === "contains" ? "contains" : "unlocks", nodeLabel(index, arc.to));
  return parts.join(" → ");
}

function issue(code: IssueCode, severity: IssueSeverity, message: string, nodeIds: Id[], edgeIds: Id[] = []): Issue {
  return { code, severity, message, nodeIds: nodeIds.sort(compareIds), edgeIds: edgeIds.sort(compareIds) };
}

function circularIssues(index: DocumentIndex, groups: readonly ClassifiedGroup[]): Issue[] {
  return groups.map((group) => {
    const loop = formatCycle(index, group.cycle);
    const edgeIds = group.cycle.map((arc) => arc.edgeId);
    if (group.severity === "blocking") {
      const blocked = group.unopenedDatabaseIds.map((id) => nodeLabel(index, id)).join(", ");
      return issue("circular-blocking", "error", `Circular dependency: ${loop}. Cannot be opened: ${blocked}.`, [...group.nodeIds], edgeIds);
    }
    return issue(
      "circular-redundant",
      "warning",
      `Circular dependency: ${loop}. Every database in it can still be opened another way.`,
      [...group.nodeIds],
      edgeIds,
    );
  });
}

/** Containers that still exist; an ephemeral database's copy is gone after setup. */
function storedCopies(index: DocumentIndex, key: Key): Id[] {
  return (index.containers.get(key.id) ?? [])
    .filter((link) => index.databases.get(link.nodeId)?.ephemeral === false)
    .map((link) => link.edgeId);
}

function keyIssues(index: DocumentIndex): Issue[] {
  const issues: Issue[] = [];
  for (const key of index.keys.values()) {
    const copies = storedCopies(index, key);
    const biometric = key.category === "biometric";
    if (!biometric && copies.length === 0) {
      if (key.memorized) {
        issues.push(issue("key-only-memorized", "warning", `"${key.name}" is only memorized. Forgetting it loses it.`, [key.id]));
      } else {
        issues.push(issue("key-unobtainable", "warning", `"${key.name}" is stored nowhere and not memorized, so it cannot be obtained.`, [key.id]));
      }
    } else if (!biometric && !key.memorized && copies.length === 1) {
      issues.push(issue("key-single-copy", "info", `"${key.name}" exists in a single copy.`, [key.id], copies));
    }
    if ((index.unlockTargets.get(key.id) ?? []).length === 0) {
      issues.push(issue("key-unlocks-nothing", "info", `"${key.name}" unlocks nothing.`, [key.id]));
    }
  }
  return issues;
}

function databaseIssues(index: DocumentIndex, baseline: Evaluation): Issue[] {
  const issues: Issue[] = [];
  for (const database of index.databases.values()) {
    const hasRule = (index.fullUnlocks.get(database.id) ?? []).length > 0 || (index.rules.get(database.id) ?? []).length > 0;
    if (database.protection === "rules" && !hasRule) {
      issues.push(issue("database-without-rule", "warning", `[${database.name}] is protected but has no unlock rule, so it can never be opened.`, [database.id]));
    }
    if (database.critical && !baseline.open.has(database.id)) {
      issues.push(issue("critical-not-openable", "warning", `Critical database [${database.name}] cannot be opened on a normal day.`, [database.id]));
    }
  }
  return issues;
}

function secretNameIssues(doc: TrustDocument): Issue[] {
  const named = [...doc.locations, ...doc.databases, ...doc.keys];
  return named
    .filter((entity) => looksLikeSecret(entity.name))
    .map((entity) => issue("name-looks-secret", "info", "This name looks like a real secret. Do not enter real secrets.", [entity.id]));
}

function compareIssues(a: Issue, b: Issue): number {
  return (
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    ISSUE_CODES.indexOf(a.code) - ISSUE_CODES.indexOf(b.code) ||
    compareIds(a.nodeIds[0] ?? "", b.nodeIds[0] ?? "")
  );
}

export function analyzeDocument(doc: TrustDocument): Analysis {
  const index = indexDocument(doc);
  const baseline = evaluate(index, ownerFacts(doc, BASELINE_STATE));
  const circularGroups = classifyCircularGroups(findCircularGroups(buildGraph(doc)), index, baseline);
  const issues = [
    ...circularIssues(index, circularGroups),
    ...keyIssues(index),
    ...databaseIssues(index, baseline),
    ...secretNameIssues(doc),
  ].sort(compareIssues);
  return { index, baseline, circularGroups, issues };
}
