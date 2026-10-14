// Domain model (DESIGN.md 4.1-4.3, 6.4) and validation limits (DESIGN.md 4.4).

export type Id = string;
export type HexColor = `#${string}`;

export const LOCATION_KINDS = ["physical", "digital"] as const;
export type LocationKind = (typeof LOCATION_KINDS)[number];

export interface Location {
  id: Id;
  name: string;
  kind: LocationKind;
  note: string;
}

export const DATABASE_CATEGORIES = [
  "password-manager",
  "encrypted-volume",
  "drive",
  "device",
  "hardware-token",
  "offline-backup",
  "cloud-account",
  "backup-repository",
  "session",
  "other",
] as const;
export type DatabaseCategory = (typeof DATABASE_CATEGORIES)[number];

export const DATA_TYPES = [
  "passwords",
  "keys",
  "recovery-codes",
  "seed-shares",
  "files",
  "backups",
  "credentials",
  "other",
] as const;
export type DataType = (typeof DATA_TYPES)[number];

export const PROTECTIONS = ["rules", "none"] as const;
export type Protection = (typeof PROTECTIONS)[number];

export interface NodeStyle {
  x: number;
  y: number;
  w: number;
  h: number;
  color: HexColor;
}

export interface Database {
  id: Id;
  name: string;
  category: DatabaseCategory;
  product: string;
  encryption: string;
  dataTypes: DataType[];
  locationId: Id | null;
  locationDetail: string;
  protection: Protection;
  ephemeral: boolean;
  critical: boolean;
  note: string;
  style: NodeStyle;
}

export const KEY_CATEGORIES = [
  "passphrase",
  "pin",
  "key-file",
  "recovery-code",
  "secret-share",
  "hardware-response",
  "biometric",
  "token",
  "other",
] as const;
export type KeyCategory = (typeof KEY_CATEGORIES)[number];

export interface Key {
  id: Id;
  name: string;
  category: KeyCategory;
  memorized: boolean;
  note: string;
  style: NodeStyle;
}

export const EDGE_TYPES = ["contains", "unlocks-full", "unlocks-partial"] as const;
export type EdgeType = (typeof EDGE_TYPES)[number];

export const EDGE_WIDTHS = [1, 2, 3] as const;
export type EdgeWidth = (typeof EDGE_WIDTHS)[number];

export const EDGE_DASHES = ["solid", "dashed", "dotted"] as const;
export type EdgeDash = (typeof EDGE_DASHES)[number];

export interface EdgeStyle {
  color: HexColor;
  width: EdgeWidth;
  dash: EdgeDash;
}

export interface Edge {
  id: Id;
  type: EdgeType;
  from: Id;
  to: Id;
  ruleId: Id | null;
  style: EdgeStyle;
}

export interface UnlockRule {
  id: Id;
  databaseId: Id;
  threshold: number;
  label: string;
}

export const SCENARIO_EVENT_TYPES = [
  "location-unreachable",
  "key-forgotten",
  "database-lost",
  "database-stolen",
  "location-compromised",
  "key-compromised",
  "biometric-unavailable",
] as const;

export type ScenarioEvent =
  | { type: "location-unreachable"; locationId: Id }
  | { type: "key-forgotten"; keyId: Id }
  | { type: "database-lost"; databaseId: Id }
  | { type: "database-stolen"; databaseId: Id }
  | { type: "location-compromised"; locationId: Id }
  | { type: "key-compromised"; keyId: Id }
  | { type: "biometric-unavailable"; keyId: Id };

export interface Scenario {
  id: Id;
  name: string;
  events: ScenarioEvent[];
}

export interface View {
  panX: number;
  panY: number;
  zoom: number;
}

export interface TrustDocument {
  schemaVersion: 1;
  id: Id;
  title: string;
  locations: Location[];
  databases: Database[];
  keys: Key[];
  edges: Edge[];
  rules: UnlockRule[];
  scenarios: Scenario[];
  notes: string;
  view: View;
}

export const LIMITS = {
  nodes: 2_000,
  edges: 10_000,
  locations: 500,
  rules: 10_000,
  scenarios: 200,
  eventsPerScenario: 1_000,
  nameLength: 200,
  noteLength: 5_000,
  coordinate: 1_000_000,
  minSize: 1,
  maxSize: 10_000,
  minZoom: 0.05,
  maxZoom: 20,
} as const;

export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/;

export function isHexColor(value: string): value is HexColor {
  return HEX_COLOR_PATTERN.test(value);
}

// Code-unit comparison: deterministic across locales, unlike localeCompare.
export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
