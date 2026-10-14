// Availability, opening and knowing (DESIGN.md 5.3) and the baseline state (DESIGN.md 5.4).
// A monotone fixpoint evaluated in rounds: each round only uses facts from earlier rounds,
// so every derivation is as shallow as possible, and candidates are tried in sorted id
// order, so the recorded provenance is deterministic.

import type { DocumentIndex } from "./graph";
import type { Id, TrustDocument } from "./model";

/** The facts an evaluation starts from. */
export interface BaseFacts {
  reachableLocations: ReadonlySet<Id>;
  knownKeys: ReadonlySet<Id>;
  /** Databases in hand regardless of location, such as a stolen laptop for an attacker. */
  heldDatabases: ReadonlySet<Id>;
  /** Databases that are lost or stolen and so never available. */
  excludedDatabases: ReadonlySet<Id>;
}

/** What the owner has lost; the empty state is the baseline (DESIGN.md 5.4). */
export interface OwnerState {
  unreachableLocations: ReadonlySet<Id>;
  forgottenKeys: ReadonlySet<Id>;
  /** Lost or stolen databases. */
  missingDatabases: ReadonlySet<Id>;
  unavailableBiometrics: ReadonlySet<Id>;
}

export const BASELINE_STATE: OwnerState = {
  unreachableLocations: new Set(),
  forgottenKeys: new Set(),
  missingDatabases: new Set(),
  unavailableBiometrics: new Set(),
};

export function ownerFacts(doc: TrustDocument, state: OwnerState): BaseFacts {
  const knownKeys = doc.keys.filter(
    (key) =>
      (key.memorized && !state.forgottenKeys.has(key.id)) ||
      (key.category === "biometric" && !state.unavailableBiometrics.has(key.id)),
  );
  return {
    reachableLocations: new Set(doc.locations.map((l) => l.id).filter((id) => !state.unreachableLocations.has(id))),
    knownKeys: new Set(knownKeys.map((k) => k.id)),
    heldDatabases: new Set(),
    excludedDatabases: state.missingDatabases,
  };
}

export type AvailabilityReason =
  | { kind: "held" }
  | { kind: "location"; locationId: Id }
  | { kind: "container"; databaseId: Id; edgeId: Id };

export type OpenReason =
  | { kind: "unprotected" }
  | { kind: "full"; keyId: Id; edgeId: Id }
  | { kind: "rule"; ruleId: Id; keyIds: readonly Id[] };

export type KnownReason = { kind: "base" } | { kind: "contained"; databaseId: Id; edgeId: Id };

export interface Evaluation {
  available: ReadonlyMap<Id, AvailabilityReason>;
  open: ReadonlyMap<Id, OpenReason>;
  known: ReadonlyMap<Id, KnownReason>;
}

function availability(
  index: DocumentIndex,
  facts: BaseFacts,
  databaseId: Id,
  open: ReadonlyMap<Id, OpenReason>,
): AvailabilityReason | null {
  const database = index.databases.get(databaseId);
  if (database === undefined || database.ephemeral || facts.excludedDatabases.has(databaseId)) return null;
  if (facts.heldDatabases.has(databaseId)) return { kind: "held" };
  if (database.locationId !== null && facts.reachableLocations.has(database.locationId)) {
    return { kind: "location", locationId: database.locationId };
  }
  const container = index.containers.get(databaseId)?.find((link) => open.has(link.nodeId));
  return container === undefined ? null : { kind: "container", databaseId: container.nodeId, edgeId: container.edgeId };
}

function opening(index: DocumentIndex, databaseId: Id, known: ReadonlyMap<Id, KnownReason>): OpenReason | null {
  if (index.databases.get(databaseId)?.protection === "none") return { kind: "unprotected" };
  const full = index.fullUnlocks.get(databaseId)?.find((link) => known.has(link.nodeId));
  if (full !== undefined) return { kind: "full", keyId: full.nodeId, edgeId: full.edgeId };
  for (const { rule, keyIds } of index.rules.get(databaseId) ?? []) {
    const knownKeyIds = keyIds.filter((id) => known.has(id));
    if (knownKeyIds.length >= rule.threshold) {
      return { kind: "rule", ruleId: rule.id, keyIds: knownKeyIds.slice(0, rule.threshold) };
    }
  }
  return null;
}

export function evaluate(index: DocumentIndex, facts: BaseFacts): Evaluation {
  const available = new Map<Id, AvailabilityReason>();
  const open = new Map<Id, OpenReason>();
  const known = new Map<Id, KnownReason>();
  for (const keyId of index.keyIds) {
    if (facts.knownKeys.has(keyId)) known.set(keyId, { kind: "base" });
  }

  for (;;) {
    const newlyAvailable: [Id, AvailabilityReason][] = [];
    const newlyOpen: [Id, OpenReason][] = [];
    const newlyKnown: [Id, KnownReason][] = [];

    for (const databaseId of index.databaseIds) {
      if (open.has(databaseId)) continue;
      let reachable = available.has(databaseId);
      if (!reachable) {
        const reason = availability(index, facts, databaseId, open);
        if (reason !== null) {
          newlyAvailable.push([databaseId, reason]);
          reachable = true;
        }
      }
      if (!reachable) continue;
      const reason = opening(index, databaseId, known);
      if (reason !== null) newlyOpen.push([databaseId, reason]);
    }

    for (const keyId of index.keyIds) {
      if (known.has(keyId)) continue;
      const source = index.containers.get(keyId)?.find((link) => open.has(link.nodeId));
      if (source !== undefined) newlyKnown.push([keyId, { kind: "contained", databaseId: source.nodeId, edgeId: source.edgeId }]);
    }

    if (newlyAvailable.length === 0 && newlyOpen.length === 0 && newlyKnown.length === 0) break;
    for (const [id, reason] of newlyAvailable) available.set(id, reason);
    for (const [id, reason] of newlyOpen) open.set(id, reason);
    for (const [id, reason] of newlyKnown) known.set(id, reason);
  }

  return { available, open, known };
}
