// Document validation (DESIGN.md 4.4). Every import and decrypted load goes through
// parseDocument, or parseDocumentText for raw JSON text (DESIGN.md 9). Readers record an error and return a placeholder so one pass reports
// as many problems as possible; a document with any error is never returned.

import {
  DATA_TYPES,
  DATABASE_CATEGORIES,
  EDGE_DASHES,
  EDGE_TYPES,
  EDGE_WIDTHS,
  ID_PATTERN,
  KEY_CATEGORIES,
  LIMITS,
  LOCATION_KINDS,
  PROTECTIONS,
  SCENARIO_EVENT_TYPES,
  isHexColor,
  type DataType,
  type Database,
  type Edge,
  type EdgeStyle,
  type HexColor,
  type Id,
  type Key,
  type Location,
  type NodeStyle,
  type Scenario,
  type ScenarioEvent,
  type TrustDocument,
  type UnlockRule,
  type View,
} from "./model";
import { err, ok, type Result } from "./result";

export interface ValidationError {
  path: string;
  message: string;
}

const MAX_ERRORS = 100;
const PLACEHOLDER_COLOR: HexColor = "#000000";

type JsonObject = Readonly<Record<string, unknown>>;

interface Context {
  errors: ValidationError[];
}

function fail(ctx: Context, path: string, message: string): void {
  if (ctx.errors.length < MAX_ERRORS) ctx.errors.push({ path, message });
}

// JSON.parse only produces plain objects and arrays with own data properties. Anything
// else did not come from JSON, so it is rejected, and only own data properties are read:
// a polluted Object.prototype cannot supply a missing field and no getter ever runs.
function isObject(value: unknown): value is JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownValue(target: object, key: string | number): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  return descriptor !== undefined && "value" in descriptor ? (descriptor.value as unknown) : undefined;
}

function isList(value: unknown): value is readonly unknown[] {
  return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype;
}

function child(path: string, key: string | number): string {
  if (typeof key === "number") return `${path}[${String(key)}]`;
  return path === "" ? key : `${path}.${key}`;
}

function readObject(ctx: Context, value: unknown, path: string): JsonObject {
  if (isObject(value)) return value;
  fail(ctx, path, "Expected an object");
  return {};
}

// Limits count Unicode code points, so an emoji is one character, not two UTF-16 units.
// A string over twice the limit in UTF-16 units is too long whatever it contains, so
// oversized input is rejected without being copied.
function characterCount(value: string, maxLength: number): number {
  if (value.length <= maxLength || value.length > 2 * maxLength) return value.length;
  return Array.from(value).length;
}

function readString(ctx: Context, obj: JsonObject, key: string, path: string, maxLength: number): string {
  const value = ownValue(obj, key);
  const at = child(path, key);
  if (typeof value !== "string") {
    fail(ctx, at, "Expected a string");
    return "";
  }
  if (characterCount(value, maxLength) > maxLength) {
    fail(ctx, at, `Longer than ${String(maxLength)} characters`);
    return "";
  }
  return value;
}

function readBoolean(ctx: Context, obj: JsonObject, key: string, path: string): boolean {
  const value = ownValue(obj, key);
  if (typeof value === "boolean") return value;
  fail(ctx, child(path, key), "Expected true or false");
  return false;
}

function readNumber(
  ctx: Context,
  obj: JsonObject,
  key: string,
  path: string,
  bounds: { min: number; max: number; integer?: boolean },
): number {
  const value = ownValue(obj, key);
  const at = child(path, key);
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(ctx, at, "Expected a finite number");
    return bounds.min;
  }
  if (bounds.integer === true && !Number.isInteger(value)) {
    fail(ctx, at, "Expected an integer");
    return bounds.min;
  }
  if (value < bounds.min || value > bounds.max) {
    fail(ctx, at, `Expected a number between ${String(bounds.min)} and ${String(bounds.max)}`);
    return bounds.min;
  }
  return value;
}

function readEnum<T extends string | number>(
  ctx: Context,
  obj: JsonObject,
  key: string,
  path: string,
  values: readonly T[],
): T {
  const value = ownValue(obj, key);
  const match = values.find((candidate) => candidate === value);
  if (match !== undefined) return match;
  fail(ctx, child(path, key), `Expected one of: ${values.join(", ")}`);
  const [first] = values;
  if (first === undefined) throw new Error("readEnum needs at least one value");
  return first;
}

function readId(ctx: Context, obj: JsonObject, key: string, path: string): Id {
  const value = ownValue(obj, key);
  if (typeof value === "string" && ID_PATTERN.test(value)) return value;
  fail(ctx, child(path, key), "Expected an id of 1-64 letters, digits, '-' or '_'");
  return "";
}

function readNullableId(ctx: Context, obj: JsonObject, key: string, path: string): Id | null {
  return ownValue(obj, key) === null ? null : readId(ctx, obj, key, path);
}

function readColor(ctx: Context, obj: JsonObject, key: string, path: string): HexColor {
  const value = ownValue(obj, key);
  if (typeof value === "string" && isHexColor(value)) return value;
  fail(ctx, child(path, key), "Expected a colour like #1a2b3c (lowercase hex)");
  return PLACEHOLDER_COLOR;
}

function readList(ctx: Context, obj: JsonObject, key: string, path: string, maxItems: number): readonly unknown[] {
  const value = ownValue(obj, key);
  const at = child(path, key);
  if (!isList(value)) {
    fail(ctx, at, "Expected a list");
    return [];
  }
  if (value.length > maxItems) {
    fail(ctx, at, `More than ${String(maxItems)} entries`);
    return [];
  }
  return Array.from({ length: value.length }, (_, index) => ownValue(value, index));
}

function parseNodeStyle(ctx: Context, value: unknown, path: string): NodeStyle {
  const obj = readObject(ctx, value, path);
  const coordinate = { min: -LIMITS.coordinate, max: LIMITS.coordinate };
  const size = { min: LIMITS.minSize, max: LIMITS.maxSize };
  return {
    x: readNumber(ctx, obj, "x", path, coordinate),
    y: readNumber(ctx, obj, "y", path, coordinate),
    w: readNumber(ctx, obj, "w", path, size),
    h: readNumber(ctx, obj, "h", path, size),
    color: readColor(ctx, obj, "color", path),
  };
}

function parseLocation(ctx: Context, value: unknown, path: string): Location {
  const obj = readObject(ctx, value, path);
  return {
    id: readId(ctx, obj, "id", path),
    name: readString(ctx, obj, "name", path, LIMITS.nameLength),
    kind: readEnum(ctx, obj, "kind", path, LOCATION_KINDS),
    note: readString(ctx, obj, "note", path, LIMITS.noteLength),
  };
}

function parseDataTypes(ctx: Context, obj: JsonObject, path: string): DataType[] {
  const at = child(path, "dataTypes");
  const result: DataType[] = [];
  readList(ctx, obj, "dataTypes", path, DATA_TYPES.length).forEach((value, index) => {
    const dataType = DATA_TYPES.find((candidate) => candidate === value);
    if (dataType === undefined) {
      fail(ctx, child(at, index), `Expected one of: ${DATA_TYPES.join(", ")}`);
    } else if (result.includes(dataType)) {
      fail(ctx, child(at, index), "Duplicate data type");
    } else {
      result.push(dataType);
    }
  });
  return result;
}

function parseDatabase(ctx: Context, value: unknown, path: string): Database {
  const obj = readObject(ctx, value, path);
  return {
    id: readId(ctx, obj, "id", path),
    name: readString(ctx, obj, "name", path, LIMITS.nameLength),
    category: readEnum(ctx, obj, "category", path, DATABASE_CATEGORIES),
    product: readString(ctx, obj, "product", path, LIMITS.nameLength),
    encryption: readString(ctx, obj, "encryption", path, LIMITS.nameLength),
    dataTypes: parseDataTypes(ctx, obj, path),
    locationId: readNullableId(ctx, obj, "locationId", path),
    locationDetail: readString(ctx, obj, "locationDetail", path, LIMITS.nameLength),
    protection: readEnum(ctx, obj, "protection", path, PROTECTIONS),
    ephemeral: readBoolean(ctx, obj, "ephemeral", path),
    critical: readBoolean(ctx, obj, "critical", path),
    note: readString(ctx, obj, "note", path, LIMITS.noteLength),
    style: parseNodeStyle(ctx, ownValue(obj, "style"), child(path, "style")),
  };
}

function parseKey(ctx: Context, value: unknown, path: string): Key {
  const obj = readObject(ctx, value, path);
  return {
    id: readId(ctx, obj, "id", path),
    name: readString(ctx, obj, "name", path, LIMITS.nameLength),
    category: readEnum(ctx, obj, "category", path, KEY_CATEGORIES),
    memorized: readBoolean(ctx, obj, "memorized", path),
    note: readString(ctx, obj, "note", path, LIMITS.noteLength),
    style: parseNodeStyle(ctx, ownValue(obj, "style"), child(path, "style")),
  };
}

function parseEdgeStyle(ctx: Context, value: unknown, path: string): EdgeStyle {
  const obj = readObject(ctx, value, path);
  return {
    color: readColor(ctx, obj, "color", path),
    width: readEnum(ctx, obj, "width", path, EDGE_WIDTHS),
    dash: readEnum(ctx, obj, "dash", path, EDGE_DASHES),
  };
}

function parseEdge(ctx: Context, value: unknown, path: string): Edge {
  const obj = readObject(ctx, value, path);
  return {
    id: readId(ctx, obj, "id", path),
    type: readEnum(ctx, obj, "type", path, EDGE_TYPES),
    from: readId(ctx, obj, "from", path),
    to: readId(ctx, obj, "to", path),
    ruleId: readNullableId(ctx, obj, "ruleId", path),
    style: parseEdgeStyle(ctx, ownValue(obj, "style"), child(path, "style")),
  };
}

function parseRule(ctx: Context, value: unknown, path: string): UnlockRule {
  const obj = readObject(ctx, value, path);
  return {
    id: readId(ctx, obj, "id", path),
    databaseId: readId(ctx, obj, "databaseId", path),
    threshold: readNumber(ctx, obj, "threshold", path, { min: 1, max: LIMITS.edges, integer: true }),
    label: readString(ctx, obj, "label", path, LIMITS.nameLength),
  };
}

function parseEvent(ctx: Context, value: unknown, path: string): ScenarioEvent {
  const obj = readObject(ctx, value, path);
  const type = readEnum(ctx, obj, "type", path, SCENARIO_EVENT_TYPES);
  // With an unknown type we cannot tell which id field to expect, so don't guess one.
  if (ownValue(obj, "type") !== type) return { type: "location-unreachable", locationId: "" };
  switch (type) {
    case "location-unreachable":
    case "location-compromised":
      return { type, locationId: readId(ctx, obj, "locationId", path) };
    case "key-forgotten":
    case "key-compromised":
    case "biometric-unavailable":
      return { type, keyId: readId(ctx, obj, "keyId", path) };
    case "database-lost":
    case "database-stolen":
      return { type, databaseId: readId(ctx, obj, "databaseId", path) };
  }
}

function parseScenario(ctx: Context, value: unknown, path: string): Scenario {
  const obj = readObject(ctx, value, path);
  const eventsPath = child(path, "events");
  return {
    id: readId(ctx, obj, "id", path),
    name: readString(ctx, obj, "name", path, LIMITS.nameLength),
    events: readList(ctx, obj, "events", path, LIMITS.eventsPerScenario).map((event, index) =>
      parseEvent(ctx, event, child(eventsPath, index)),
    ),
  };
}

function parseView(ctx: Context, value: unknown, path: string): View {
  const obj = readObject(ctx, value, path);
  const coordinate = { min: -LIMITS.coordinate, max: LIMITS.coordinate };
  return {
    panX: readNumber(ctx, obj, "panX", path, coordinate),
    panY: readNumber(ctx, obj, "panY", path, coordinate),
    zoom: readNumber(ctx, obj, "zoom", path, { min: LIMITS.minZoom, max: LIMITS.maxZoom }),
  };
}

function parseAll<T>(
  ctx: Context,
  root: JsonObject,
  key: string,
  maxItems: number,
  parse: (ctx: Context, value: unknown, path: string) => T,
): T[] {
  return readList(ctx, root, key, "", maxItems).map((value, index) => parse(ctx, value, child(key, index)));
}

// Placeholder ids ("") come from fields that already failed; skip them to avoid cascades.
function checkReference(ctx: Context, id: Id | null, valid: { has(id: Id): boolean }, path: string, what: string): void {
  if (id === null || id === "") return;
  if (!valid.has(id)) fail(ctx, path, `Unknown ${what} "${id}"`);
}

function checkUniqueIds(ctx: Context, doc: TrustDocument): void {
  const seen = new Set<Id>();
  const visit = (id: Id, path: string): void => {
    if (id === "") return;
    if (seen.has(id)) fail(ctx, path, `Duplicate id "${id}"`);
    seen.add(id);
  };
  visit(doc.id, "id");
  const groups: [string, readonly { id: Id }[]][] = [
    ["locations", doc.locations],
    ["databases", doc.databases],
    ["keys", doc.keys],
    ["edges", doc.edges],
    ["rules", doc.rules],
    ["scenarios", doc.scenarios],
  ];
  for (const [name, entities] of groups) {
    entities.forEach((entity, index) => {
      visit(entity.id, child(child(name, index), "id"));
    });
  }
}

function checkReferences(ctx: Context, doc: TrustDocument): void {
  const locationIds = new Set(doc.locations.map((l) => l.id));
  const databaseIds = new Set(doc.databases.map((d) => d.id));
  const keyIds = new Set(doc.keys.map((k) => k.id));
  const nodeIds = new Set([...databaseIds, ...keyIds]);
  const rulesById = new Map(doc.rules.map((r) => [r.id, r]));

  doc.databases.forEach((database, index) => {
    checkReference(ctx, database.locationId, locationIds, `databases[${String(index)}].locationId`, "location");
  });
  doc.rules.forEach((rule, index) => {
    checkReference(ctx, rule.databaseId, databaseIds, `rules[${String(index)}].databaseId`, "database");
  });

  const edgeSignatures = new Set<string>();
  const keysPerRule = new Map<Id, number>();
  doc.edges.forEach((edge, index) => {
    const path = `edges[${String(index)}]`;
    if (edge.type === "contains") {
      checkReference(ctx, edge.from, databaseIds, `${path}.from`, "database (contains must start at a database)");
      checkReference(ctx, edge.to, nodeIds, `${path}.to`, "database or key");
    } else {
      checkReference(ctx, edge.from, keyIds, `${path}.from`, "key (unlock edges must start at a key)");
      checkReference(ctx, edge.to, databaseIds, `${path}.to`, "database (unlock edges must end at a database)");
    }

    if (edge.type === "unlocks-partial") {
      const rule = edge.ruleId === null ? undefined : rulesById.get(edge.ruleId);
      if (edge.ruleId === null) {
        fail(ctx, `${path}.ruleId`, "A partial unlock edge must reference an unlock rule");
      } else if (rule === undefined) {
        if (edge.ruleId !== "") fail(ctx, `${path}.ruleId`, `Unknown unlock rule "${edge.ruleId}"`);
      } else if (rule.databaseId !== edge.to) {
        fail(ctx, `${path}.ruleId`, `Rule "${rule.id}" belongs to a different database`);
      } else {
        keysPerRule.set(rule.id, (keysPerRule.get(rule.id) ?? 0) + 1);
      }
    } else if (edge.ruleId !== null) {
      fail(ctx, `${path}.ruleId`, "Only partial unlock edges may reference a rule");
    }

    const signature = [edge.type, edge.from, edge.to, edge.ruleId ?? ""].join("\u0000");
    if (edgeSignatures.has(signature)) fail(ctx, path, "Duplicate connection");
    edgeSignatures.add(signature);
  });

  doc.rules.forEach((rule, index) => {
    const keyCount = keysPerRule.get(rule.id) ?? 0;
    if (keyCount === 0) {
      fail(ctx, `rules[${String(index)}]`, "Unlock rule has no keys");
    } else if (rule.threshold > keyCount) {
      fail(ctx, `rules[${String(index)}].threshold`, `Threshold exceeds the ${String(keyCount)} keys in the rule`);
    }
  });

  const targets: EventTargets = {
    locationIds,
    keys: new Map(doc.keys.map((k) => [k.id, k])),
    databases: new Map(doc.databases.map((d) => [d.id, d])),
  };
  doc.scenarios.forEach((scenario, scenarioIndex) => {
    scenario.events.forEach((event, eventIndex) => {
      checkEvent(ctx, targets, event, `scenarios[${String(scenarioIndex)}].events[${String(eventIndex)}]`);
    });
  });
}

// An event must fit the kind of entity it targets (DESIGN.md 4.4): only a memorized key
// can be forgotten, only a biometric can be unavailable, and an ephemeral database no
// longer exists, so it cannot be lost or stolen.
interface EventTargets {
  locationIds: ReadonlySet<Id>;
  keys: ReadonlyMap<Id, Key>;
  databases: ReadonlyMap<Id, Database>;
}

function checkEvent(ctx: Context, targets: EventTargets, event: ScenarioEvent, path: string): void {
  switch (event.type) {
    case "location-unreachable":
    case "location-compromised":
      checkReference(ctx, event.locationId, targets.locationIds, `${path}.locationId`, "location");
      return;
    case "key-forgotten":
    case "key-compromised":
    case "biometric-unavailable": {
      const at = `${path}.keyId`;
      const key = targets.keys.get(event.keyId);
      if (key === undefined) {
        checkReference(ctx, event.keyId, targets.keys, at, "key");
      } else if (event.type === "key-forgotten" && !key.memorized) {
        fail(ctx, at, `Key "${key.id}" is not memorized, so it cannot be forgotten`);
      } else if (event.type === "biometric-unavailable" && key.category !== "biometric") {
        fail(ctx, at, `Key "${key.id}" is not a biometric`);
      }
      return;
    }
    case "database-lost":
    case "database-stolen": {
      const at = `${path}.databaseId`;
      const database = targets.databases.get(event.databaseId);
      if (database === undefined) checkReference(ctx, event.databaseId, targets.databases, at, "database");
      else if (database.ephemeral) fail(ctx, at, `Database "${database.id}" is ephemeral, so it no longer exists`);
      return;
    }
  }
}

export function parseDocument(input: unknown): Result<TrustDocument, ValidationError[]> {
  if (!isObject(input)) return err([{ path: "", message: "Expected a document object" }]);
  if (ownValue(input, "schemaVersion") !== 1) {
    return err([{ path: "schemaVersion", message: "Unsupported schema version (expected 1)" }]);
  }

  const ctx: Context = { errors: [] };
  const listLength = (key: string): number => {
    const value = ownValue(input, key);
    return isList(value) ? value.length : 0;
  };
  const nodeCount = listLength("databases") + listLength("keys");
  if (nodeCount > LIMITS.nodes) {
    return err([{ path: "", message: `More than ${String(LIMITS.nodes)} databases and keys` }]);
  }

  const doc: TrustDocument = {
    schemaVersion: 1,
    id: readId(ctx, input, "id", ""),
    title: readString(ctx, input, "title", "", LIMITS.nameLength),
    locations: parseAll(ctx, input, "locations", LIMITS.locations, parseLocation),
    databases: parseAll(ctx, input, "databases", LIMITS.nodes, parseDatabase),
    keys: parseAll(ctx, input, "keys", LIMITS.nodes, parseKey),
    edges: parseAll(ctx, input, "edges", LIMITS.edges, parseEdge),
    rules: parseAll(ctx, input, "rules", LIMITS.rules, parseRule),
    scenarios: parseAll(ctx, input, "scenarios", LIMITS.scenarios, parseScenario),
    notes: readString(ctx, input, "notes", "", LIMITS.noteLength),
    view: parseView(ctx, ownValue(input, "view"), "view"),
  };

  checkUniqueIds(ctx, doc);
  checkReferences(ctx, doc);
  return ctx.errors.length === 0 ? ok(doc) : err(ctx.errors);
}

/**
 * Parses document JSON text. The length check runs before JSON.parse, so oversized input
 * costs nothing to reject (DESIGN.md 4.4, 9).
 */
export function parseDocumentText(text: string): Result<TrustDocument, ValidationError[]> {
  if (text.length > LIMITS.documentLength) {
    return err([{ path: "", message: "The file is larger than the 16 MiB limit" }]);
  }
  let input: unknown;
  try {
    input = JSON.parse(text) as unknown;
  } catch {
    // Parser messages quote part of the input, which may be sensitive, so they are dropped.
    return err([{ path: "", message: "The file is not valid JSON" }]);
  }
  return parseDocument(input);
}
