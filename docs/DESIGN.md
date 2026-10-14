# trustchain: Design

A small, offline-first web app for drawing a **chain of trust**: which databases hold which keys, and which keys unlock which databases. It proves the chain has no circular dependency, shows every way a database can be opened, and simulates threat scenarios (a lost location, a forgotten passphrase, a stolen device) to list the recovery paths that remain.

Think of a much simpler draw.io or Excalidraw, specialised for one job.

---

## 1. Goals and non-goals

### Goals
- Draw databases and keys on a canvas and connect them with typed, coloured arrows.
- Detect circular dependencies live, highlight them, and suggest concrete fixes.
- For any database, list every way it can be opened, starting from what the user knows or holds.
- Simulate threat scenarios with checkboxes and show what the owner can still recover and what an attacker could reach.
- Run fully offline, with no account, no server-side state and no network traffic.
- Keep saved work encrypted at rest in the browser.
- Export to JSON, SVG and PNG.

### Non-goals
- Storing real secrets. The app models *where* secrets live, never their values.
- Collaboration, sharing links, cloud sync, accounts, telemetry.
- General-purpose diagramming (free shapes, freehand drawing, text boxes beyond notes).
- Mobile-first editing. It must render on small screens, but editing targets desktop.

---

## 2. Principles

1. **Offline and serverless.** The build is static files. The app makes zero network requests, enforced by CSP (`connect-src 'none'`).
2. **Zero runtime dependencies.** Only TypeScript compiled to plain JS. Build and test tooling are dev dependencies.
3. **Pure core.** All analysis (graph, cycles, paths, scenarios, layout) lives in `src/core`, has no DOM or browser API access, and is fully unit tested.
4. **Encrypted at rest.** Nothing readable is written to browser storage. No cookies, no plaintext `localStorage`.
5. **Small attack surface.** No `innerHTML` with dynamic content, no `eval`, Trusted Types enforced, strict CSP.
6. **Deterministic.** The same document always produces the same analysis output, in the same order.

---

## 3. Tech stack

| Concern | Choice |
|---|---|
| Language | TypeScript, `strict: true`, plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` |
| UI | Vanilla TypeScript, DOM APIs, SVG canvas. No framework. |
| Build / dev server | Vite (dev dependency only) |
| Unit tests | Vitest |
| End-to-end tests | Playwright |
| Lint | ESLint with typescript-eslint, plus rules banning unsafe DOM sinks |
| Crypto | WebCrypto (`crypto.subtle`), no library |
| Storage | IndexedDB, encrypted envelope only |
| CI / hosting | GitHub Actions; static hosting on a dedicated custom domain (see 10.7) |

Versions: current stable at setup time, pinned exactly in `package.json` and locked in `package-lock.json`. Node: current LTS.

---

## 4. Domain model

### 4.1 Entities

```ts
type Id = string; // crypto.randomUUID()

interface Location {
  id: Id;
  name: string;              // "Home (L1)", "Safe deposit box", "Backblaze B2"
  kind: "physical" | "digital";
  note: string;
}

type DatabaseCategory =
  | "password-manager"   // KeePassXC, Bitwarden ...
  | "encrypted-volume"   // LUKS partition, VeraCrypt container
  | "drive"              // HDD, SSD, USB stick
  | "device"             // laptop, phone
  | "hardware-token"     // YubiKey, smart card
  | "offline-backup"     // paper, steel plate
  | "cloud-account"      // B2, Google Drive, email
  | "backup-repository"  // restic, borg
  | "session"            // ephemeral environment such as Tails
  | "other";

interface Database {
  id: Id;
  name: string;
  category: DatabaseCategory;
  product: string;            // free text: "KeePassXC", "LUKS2", "YubiKey 5"
  encryption: string;         // free text: "AES-256-XTS (LUKS2)", "KDBX4 / ChaCha20"
  dataTypes: DataType[];      // what it holds, see below
  locationId: Id | null;      // top-level placement; null if it lives only inside a container
  locationDetail: string;     // "/home/user/vault.kdbx", "top drawer"
  protection: "rules" | "none"; // "none": opens as soon as it is available (a steel plate)
  ephemeral: boolean;         // existed only during setup; never available in analysis
  critical: boolean;          // owner must always be able to recover it
  note: string;
  style: NodeStyle;
}

type DataType = "passwords" | "keys" | "recovery-codes" | "seed-shares"
              | "files" | "backups" | "credentials" | "other";

type KeyCategory =
  | "passphrase" | "pin" | "key-file" | "recovery-code" | "secret-share"
  | "hardware-response"   // YubiKey challenge-response, FIDO2 assertion
  | "biometric"           // fingerprint, face
  | "token" | "other";

interface Key {
  id: Id;
  name: string;
  category: KeyCategory;
  memorized: boolean;         // the owner knows it by heart
  note: string;
  style: NodeStyle;
}

interface NodeStyle {
  x: number; y: number; w: number; h: number;
  color: HexColor;            // validated "#rrggbb"
}
```

### 4.2 Connections

| Type | From → To | Meaning |
|---|---|---|
| `contains` | Database → Key | The database stores a copy of the key. |
| `contains` | Database → Database | The inner database lives inside the outer one (a file on a drive, a partition on a disk). The inner one is only *available* while some container is open. |
| `unlocks-full` | Key → Database | The key alone opens the database. |
| `unlocks-partial` | Key → Database | The key is needed but not sufficient: it belongs to an **unlock rule** together with other keys. |

```ts
interface Edge {
  id: Id;
  type: "contains" | "unlocks-full" | "unlocks-partial";
  from: Id; to: Id;
  ruleId: Id | null;          // required for unlocks-partial, null otherwise
  style: { color: HexColor; width: 1 | 2 | 3; dash: "solid" | "dashed" | "dotted" };
}

interface UnlockRule {        // an AND group, generalised to k-of-n
  id: Id;
  databaseId: Id;
  threshold: number;          // k; default = number of keys in the rule (plain AND)
  label: string;              // shown as a badge, e.g. "A" or "2 of 3"
}
```

A database opens if **any** of its rules is satisfied (OR). A rule is satisfied when at least `threshold` of its keys are known. An `unlocks-full` edge is a rule with a single key. The k-of-n threshold models secret sharing, such as SLIP-39 "2 of 3".

### 4.3 Document

```ts
interface TrustDocument {
  schemaVersion: 1;
  id: Id;
  title: string;
  locations: Location[];
  databases: Database[];
  keys: Key[];
  edges: Edge[];
  rules: UnlockRule[];
  scenarios: Scenario[];      // see section 6.4
  notes: string;
  view: { panX: number; panY: number; zoom: number };
}
```

### 4.4 Validation (structural rules)

`core/schema.ts` exposes `parseDocument(input: unknown): Result<TrustDocument, ValidationError[]>`. It is hand-written (no schema library) and runs on every import and every decrypted load.

- `contains` must start at a database. `unlocks-*` must go from a key to a database.
- `unlocks-partial` must reference an existing rule of the target database. `1 ≤ threshold ≤ keys in rule`.
- No duplicate edges (same type, from, to, rule).
- Colours match `^#[0-9a-f]{6}$`. Numbers are finite and within bounds.
- Limits: 2,000 nodes (databases and keys together), 10,000 edges, 200 characters per name, 5,000 per note (characters are Unicode code points). Also 500 locations, 10,000 rules, 200 scenarios and 1,000 events per scenario. Larger input is rejected, not truncated.
- Number bounds: coordinates and pan within ±1,000,000; node width and height 1–10,000; zoom 0.05–20; threshold an integer.
- Ids match `^[A-Za-z0-9_-]{1,64}$` and are unique across the whole document (this accepts `crypto.randomUUID()` output and readable fixture ids).
- Every field is required; missing fields are errors, never filled with defaults.
- Unknown fields are dropped. Unknown enum values are rejected.
- Scenario events must fit the kind of entity they target:
  - `location-unreachable` and `location-compromised`: any location.
  - `key-forgotten`: a memorized key, since only a memorized key can be forgotten.
  - `key-compromised`: any key.
  - `biometric-unavailable`: a `biometric` key.
  - `database-lost` and `database-stolen`: a database that is not ephemeral, since an ephemeral one no longer exists.

  An edit that makes an event stop fitting (unticking `memorized`, changing a key's category, marking a database ephemeral, deleting the target) removes that event from every scenario in the same undoable command.
- Only plain objects and arrays, as `JSON.parse` produces them, are accepted, and only their own data properties are read. Inherited fields and getters are ignored, so a polluted `Object.prototype` cannot supply a field.
- Raw JSON text goes through `parseDocumentText`, which rejects text longer than 16 MiB (16 × 2²⁰ UTF-16 code units) before calling `JSON.parse`. Parser error messages are not shown, because they quote the input.

---

## 5. Semantics (the specification the core implements)

### 5.1 Dependency graph

Build a directed graph *G* over databases and keys:
- `contains` Database A → X gives edge A → X.
- `unlocks-*` Key K → Database D gives edge K → D.

Ephemeral databases are not part of *G*, and neither is any connection to or from one. They no longer exist, so they cannot take part in a dependency. Keys they contain stay in *G* (the issues in 6.1 still report such keys as stored nowhere).

### 5.2 Circularity

The chain is free of circularity **iff G is a DAG**. Detection uses Tarjan's strongly connected components (iterative, no recursion limits). Every SCC with more than one node, or a self-loop, is one **circular group**. For each group, report the shortest cycle through it (BFS restricted to the SCC) so the user sees a concrete loop such as:

`[Recovery DB] → contains → master passphrase → unlocks → [Recovery DB]`

When several cycles are equally short, the one found by BFS from the smallest node id (exploring arcs in sorted order) is reported, so the result is deterministic.

The check is strict on purpose: a cycle is reported even if another copy of a key exists elsewhere. Each group is additionally classified:
- **Blocking**: in the baseline state (5.4), at least one database in the group cannot be opened.
- **Redundant**: every database in the group can still be opened through some path outside the loop. Still reported, at lower severity.

### 5.3 Availability, opening, knowing

Analysis runs against a **state**: the set of reachable locations, forgotten keys, lost and stolen databases.

- A database is **available** if it is not ephemeral, not lost or stolen (for the owner), and either its location is reachable or (if it has containers) at least one container is **open**.
- A database is **open** if it is available and either `protection = "none"` or at least one of its rules is satisfied.
- A key is **known** if it is memorized and not forgotten, or it is contained in an open database, or it is a `biometric` key whose owner is present (always, unless a scenario disables it).

Evaluation is a monotone fixpoint (forward chaining): start from base facts, repeatedly open what can be opened, stop when nothing changes. Each opened database and known key records **provenance**: which rule fired and which database supplied each key. This gives a derivation tree for explanations.

Evaluation proceeds in rounds. Round 0 holds the base facts. In each later round:
- a database becomes available if its location is reachable, or if a container was opened in an earlier round;
- a database that is available by now, including one that became available in this round, opens if keys known in an earlier round satisfy one of its rules (or if `protection = "none"`);
- a key becomes known if a database containing it was opened in an earlier round.

Becoming available and opening therefore count as a single step; every other derivation uses only facts from earlier rounds. Each fact is recorded in the first round it can be derived, so every recorded derivation is as shallow as possible. Within a round, candidates are tried in sorted id order: full unlocks before k-of-n rules, and for a k-of-n rule the first `threshold` known keys by id. The provenance is therefore deterministic.

### 5.4 Baseline state

All locations reachable, nothing forgotten, lost or stolen. Used for the normal-day view, path listing and cycle classification.

### 5.5 Unlock paths for a database

"How can database D be opened?" returns a list of **minimal unlock sets**: sets of base facts (memorized keys, reachable locations, biometrics) such that the fixpoint from that set opens D, with no subset doing so.

Computed by expanding D's condition into disjunctive normal form over base facts on the DAG, with memoisation per node and superset elimination. Results are sorted by size and capped (default 25 sets per database, marked "more paths exist" when truncated). Each set is shown with its derivation steps:

```
Path 1 (needs: Home reachable, laptop disk passphrase*, daily db passphrase*, YubiKey PIN*)
  1. Laptop is at Home → available
  2. laptop disk passphrase* → opens Laptop
  3. Laptop contains Daily database → available
  4. YubiKey PIN* → opens YubiKey → yields YubiKey response
  5. daily db passphrase* + YubiKey response (rule A) → opens Daily database
```

Path listing is only defined when G is a DAG. While cycles exist the panel shows the cycle warning instead.

---

## 6. Analysis features

### 6.1 Issues panel

Recomputed (debounced, ~150 ms) after every edit. Each issue links to the involved nodes and highlights them.

| Severity | Issue |
|---|---|
| Error | Circular group (blocking) |
| Warning | Circular group (redundant) |
| Warning | Protected database with no unlock rule (can never be opened) |
| Warning | Key stored nowhere and not memorized (cannot be obtained) |
| Warning | Key only memorized, stored nowhere (forgetting it loses it) |
| Warning | Critical database not openable in the baseline state |
| Info | Key in a single copy |
| Info | Key that unlocks nothing |
| Info | Text looks like a real secret (a pasted key or token): "Do not enter real secrets" |

Definitions used by these checks:
- A key's **copies** are the non-ephemeral databases that contain it, plus one if it is memorized. A copy inside an ephemeral database does not count, because that database no longer exists. "Stored nowhere" means no such database.
- **Ephemeral** databases no longer exist. They never get "Protected database with no unlock rule", and an unlock connection to one does not count, so a key that only unlocks ephemeral databases "unlocks nothing". A critical ephemeral database is still reported as "Critical database not openable", since it can never be recovered; the message says it is ephemeral.
- **Biometric** keys are exempt from the "stored nowhere", "only memorized" and "single copy" checks, since they are always known unless a scenario disables them.
- "Key in a single copy" applies to keys that are not memorized and have exactly one copy. A key that is only memorized gets the "only memorized" warning instead.
- Every free-text field is checked: the document title and notes; location name and note; database name, product, encryption, location detail and note; key name and note; rule label; scenario name. One issue is raised per entity, naming the fields but never quoting their text.
- Text **looks like a secret** if any whitespace-separated word matches one of these rules:
  - It is at least 20 characters long, uses at least three character classes (lowercase, uppercase, digit, other), switches class between at least 55% of neighbouring characters, and has at least 3.5 bits of entropy per character. Paths and labels contain long runs of letters, so they fail the class-switch test.
  - It is a single-case hex string of at least 32 digits (optional `0x`), or an uppercase base32 string of at least 16 characters (optional `=` padding), that mixes letters and digits and has at least 3 bits of entropy per character.
- Uppercase base32 written in groups of four separated by single spaces or dashes (at least four groups, as authenticator apps show TOTP seeds) is joined and tested as one word.
- Known limits: word-based secrets such as BIP39 seed phrases and diceware passphrases read like prose and are not detected. Non-secret hex values such as hashes, snapshot ids and fingerprints of 32 or more digits are reported, which is acceptable at info severity.

Issue messages quote entity names so the user can find them. A name that itself looks like a secret is replaced by "(name hidden: looks like a secret)", so the panel never repeats a pasted secret.

Issues are sorted by severity, then by the order of this table, then by the first involved id.

### 6.2 Fix suggestions for cycles

For each circular group, generate candidate edits, verify each one by re-running the analysis on a copy of the document, and show only those that remove the group without making any critical database unopenable. Ranked:

1. **Remove a redundant copy.** Remove a `contains` edge inside the group when the key has another copy outside the group's descendants. *"Recovery DB stores 'master passphrase', which it needs itself. Another copy exists on Steel plates. Remove this copy."*
2. **Move the copy upstream.** Move a key from a database inside the loop to a database that is not a descendant of the loop, listing candidates.
3. **Add an independent unlock rule.** Suggest a rule for a database in the loop using keys that do not depend on the loop.
4. **Memorize the key.** Last resort; it also triggers the "only memorized" warning unless a second copy is added upstream.

Each suggestion has a one-click **Apply** that is a normal, undoable edit.

### 6.3 Paths panel

Select a database to see its minimal unlock sets (5.5) for the baseline or the active scenario. Hovering a path highlights its nodes and edges on the canvas.

### 6.4 Scenarios (threat models)

```ts
type ScenarioEvent =
  | { type: "location-unreachable"; locationId: Id }  // fire, travel, provider outage
  | { type: "key-forgotten"; keyId: Id }
  | { type: "database-lost"; databaseId: Id }        // destroyed, broken, lost
  | { type: "database-stolen"; databaseId: Id }      // owner loses it, attacker gains it
  | { type: "location-compromised"; locationId: Id } // burglary: attacker gets everything there
  | { type: "key-compromised"; keyId: Id }           // phishing, keylogger, coercion
  | { type: "biometric-unavailable"; keyId: Id };

interface Scenario { id: Id; name: string; events: ScenarioEvent[] }
```

**UI.** A checkbox matrix generated from the document: every location (unreachable, compromised), every memorized key (forgotten, compromised), every database with a location (lost, stolen). Ticking boxes updates results live. Presets combine events:
- *Fire at X*: X unreachable + every database at X lost.
- *Burglary at X*: X compromised + every database at X stolen.
- *Forgot everything*: every memorized key forgotten.
- *All hardware tokens lost*.

The current selection can be saved as a named scenario.

**Results**, two columns:
- **Owner**: every database marked *open*, *open via an alternative path*, or *lost*. Critical databases first, with a headline: "All critical databases recoverable" or "Lost: restic repos". Each recoverable database lists its remaining unlock paths.
- **Attacker**: base facts = stolen databases, everything at compromised locations, compromised keys. Lists what the attacker can open and the derivation for each.

### 6.5 Resilience sweep

A button that evaluates every single event and every pair of events from the checkbox matrix (triples optional, behind a confirmation with an estimate) and reports the **minimal failure sets**: the smallest combinations that make a critical database unrecoverable, and the smallest combinations that let an attacker open one. Runs in a Web Worker so the UI stays responsive.

---

## 7. User interface

### 7.1 Layout

```
┌──────────────────────────────────────────────────────────────┐
│ Toolbar: Select · Database · Key · Connect · Pan │ Undo Redo │
│          Auto-layout │ Export │ Lock                          │
├───────────────────────────────────────────┬──────────────────┤
│                                           │ Inspector        │
│              SVG canvas                   │ (selected item)  │
│                                           ├──────────────────┤
│                                           │ Issues │ Paths │  │
│                                           │ Scenarios        │
└───────────────────────────────────────────┴──────────────────┘
```

### 7.2 Canvas
- SVG, pan with space+drag or middle mouse, zoom with wheel (centred on cursor), fit-to-content.
- **Databases**: rounded rectangles with a category icon, name, location badge and protection icon. Ephemeral databases have a dashed border; critical ones have a marker.
- **Keys**: pills with a category icon. Memorized keys show `*`.
- **Containment**: a database inside another can optionally be drawn nested inside its container.
- **Edges**: default styles per type (contains solid, unlocks-full dashed, unlocks-partial dotted with a rule badge like `A` or `2/3`). Colour, width and dash are editable per edge.
- **Highlights**: cycles in red with a glow; hovered path in its own colour; everything else dimmed.
- Snap to grid (toggle). Multi-select with a box or shift+click. Delete with Del or Backspace.

### 7.3 Creating connections
Drag from a node's handle to another node. A small menu offers only the valid types for that pair:
- Database → Key: *contains*
- Database → Database: *contains*
- Key → Database: *unlocks fully*, *unlocks partially* (then choose an existing rule of that database or create one, and set k-of-n)

### 7.4 Inspector
Form fields for the selected node or edge (all entity fields from section 4), a colour picker limited to a palette plus hex input, and a list of the node's incoming and outgoing connections.

### 7.5 Auto-layout
Layered layout from the DAG: longest-path layering, then barycenter ordering to reduce crossings, left to right. Disabled while cycles exist (it explains why).

### 7.6 Keyboard
`V` select, `D` database, `K` key, `C` connect, `Space` pan, `Ctrl+Z` / `Ctrl+Shift+Z` undo/redo, `Ctrl+A` select all, `Del` delete, `F` fit, `Ctrl+E` export, `Ctrl+L` lock.

### 7.7 Accessibility and theming
- All panels are keyboard navigable, with ARIA labels on controls and on canvas nodes (`role="group"`, accessible names).
- Every node and edge can also be reached from list views in the Issues and Paths panels, so the canvas is never the only way in.
- Light and dark themes via CSS variables, following `prefers-color-scheme`. Contrast at least WCAG AA. Meaning is never carried by colour alone (dash patterns, badges, icons).

### 7.8 Undo/redo
Command pattern over document edits, held in memory only (never persisted).

---

## 8. Persistence and encryption

### 8.1 Storage
- IndexedDB database `trustchain`, object store `vault`, one record holding an **encrypted envelope**. The vault holds a list of documents plus app preferences (theme, grid, auto-lock time).
- Nothing else is ever written: no cookies, no `localStorage`, no `sessionStorage`, no service worker cache.

### 8.2 Envelope format (also used for encrypted export)

```json
{
  "format": "trustchain-encrypted",
  "v": 1,
  "kdf": { "name": "PBKDF2", "hash": "SHA-256", "iterations": 600000, "salt": "<base64, 16 bytes>" },
  "cipher": { "name": "AES-GCM", "iv": "<base64, 12 bytes>" },
  "ciphertext": "<base64>"
}
```

- Key: PBKDF2-HMAC-SHA-256, 600,000 iterations, random 16-byte salt, derived as a **non-extractable** AES-256-GCM `CryptoKey`.
- Every save uses a fresh random 12-byte IV.
- Additional authenticated data: the canonical JSON of the envelope without `ciphertext`, so tampering with KDF parameters fails decryption.
- Decryption output goes through `parseDocument` before use.
- Iteration count is read from the envelope, so it can be raised later. Argon2id would be stronger but needs WASM; it is out of scope for v1.

### 8.3 Lifecycle
1. **First run**: choose a passphrase (minimum 12 characters, with a strength hint) or start a **memory-only session** that never touches storage.
2. **Later runs**: if a vault exists, the unlock screen appears first. A wrong passphrase reveals nothing.
3. **Autosave**: re-encrypt and write about 1 s after the last change.
4. **Lock**: manual (`Ctrl+L`) or after inactivity (default 15 min). Lock drops all references and reloads the page, since JavaScript cannot reliably wipe memory.
5. **Change passphrase**: re-derive and re-encrypt.
6. **Forgot passphrase**: no recovery by design. The only option is **Wipe local data**, which deletes the IndexedDB database after a typed confirmation.

---

## 9. Import and export

| Format | Details |
|---|---|
| JSON (plain) | Pretty-printed `TrustDocument`. A dialog warns that it is unencrypted. |
| JSON (encrypted) | The envelope from 8.2 with a passphrase chosen at export time. |
| SVG | A cleaned clone of the canvas: computed styles inlined as presentation attributes, interactive attributes removed, no external references, light theme by default. |
| PNG | The SVG rendered to an offscreen canvas at 2× scale via a `blob:` image, then `canvas.toBlob`. |
| Mermaid, DOT (later) | Text exports for docs and Graphviz. |

- Downloads use a `blob:` URL with `<a download>`, revoked right after.
- Import: file picker or drag and drop, JSON only. Encrypted files prompt for the passphrase. The file size is checked (`File.size`) before it is read, and all text goes through `parseDocumentText` (4.4) before anything is rendered.

---

## 10. Security

### 10.1 What the app protects
Diagrams describe someone's security architecture, which is sensitive metadata. The app protects that data **at rest** in the browser profile and on disk, and guarantees it never leaves the machine.

### 10.2 What it cannot protect against
Malware on the device, malicious browser extensions, a compromised browser, or someone watching the screen. The README must say so plainly.

### 10.3 Content Security Policy
Set as a `<meta http-equiv>` tag, since GitHub Pages cannot send custom headers:

```
default-src 'none';
script-src 'self';
style-src 'self';
img-src 'self' blob: data:;
font-src 'self';
worker-src 'self';
connect-src 'none';
base-uri 'none';
form-action 'none';
require-trusted-types-for 'script';
trusted-types 'none';
```

- `frame-ancestors` is ignored in a meta tag, so the app refuses to render when `window.top !== window.self`.
- Also set `<meta name="referrer" content="no-referrer">`.
- Inline styles are never written as `style="..."` attributes. Dynamic styling uses SVG presentation attributes or the CSSOM through the `setStyle` helper in `src/ui/dom.ts`, both of which the CSP allows.

### 10.4 Code rules
- Never use `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval`, `new Function`, or string-based `setTimeout`. Enforced by ESLint and by Trusted Types at runtime.
- Build DOM only through `createElement` / `createElementNS` and `textContent`, via helpers in `src/ui/dom.ts`. The helpers allowlist tags and attributes; a new one is added only after review. Presentation attributes parsed as CSS (`fill`, `marker-end` and so on) may only reference `url(#id)` in the same document, and `fill`/`stroke` must be a `#rrggbb` colour or a paint keyword. ESLint bans `setAttribute*`, `createElement*` and assignments to URL properties (`href`, `src` and similar) everywhere else.
- `id`, `name` and `for` values must start with `tc-` (pattern `^tc-[A-Za-z0-9_-]{1,64}$`). The hyphen means an element can never shadow a global identifier through the window's named properties (DOM clobbering), whatever text a user typed.
- Inline styles are set only through `setStyle(element, property, value)` in `src/ui/dom.ts`. It allowlists properties (custom properties must start with `--tc-`) and functions (`calc`, `var`, transforms and similar), and rejects backslashes, so a value cannot load a resource with `url()`, `image-set()` or CSS escapes. Constructable stylesheets (`CSSStyleSheet`, `insertRule`, `replaceSync`, `adoptedStyleSheets`) are banned.
- Lint bans match computed access too (`el["innerHTML"]`, string literals naming a sink) and the method itself, so `.call`, `.apply` and destructuring cannot bypass them. Also banned outside `src/ui/dom.ts`: `DOMParser`, `createContextualFragment`, `setHTMLUnsafe`, `parseHTMLUnsafe`, `importNode`, `adoptNode`, `document.implementation`, `toggleAttribute`, `attributes`, `getAttributeNode*` and `setNamedItem*`. Static rules cannot catch every dynamically built name; CSP and Trusted Types are the runtime backstop.
- User strings only ever reach the DOM as text content or validated attribute values. Colours must pass the hex regex before use.
- No network APIs: `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource` and `navigator.sendBeacon` are banned by lint rule and blocked by CSP.
- No navigation APIs. CSP does not govern top-level navigation, so a URL carrying data would leave the machine despite `connect-src 'none'`. `window.open`, `location.assign`, `location.replace` and assignments to `location` (bare, or through `window` or `document`) are banned by lint rule.
- No third-party fonts, icons or CDNs. Icons are inline SVG paths in `src/ui/icons.ts`.
- Random values only from `crypto.getRandomValues` / `crypto.randomUUID`.

### 10.5 Supply chain
- Zero runtime dependencies. Adding any runtime dependency requires a written justification in the PR.
- `.npmrc` sets `ignore-scripts=true` and `save-exact=true`. CI installs with `npm ci`.
- GitHub Actions pin third-party actions to full commit SHAs and use least-privilege `permissions`.
- Dependabot for dev dependencies and actions, with a 7-day cooldown so a new release is not proposed until it has been public for a week. CI runs `npm audit --audit-level=high`.
- The Pages deploy (disabled until 10.7 is satisfied) runs the full CI workflow (checks, audit, build and e2e, including the zero-network test) first and deploys only if it passes. The deploy build installs from the lockfile without a dependency cache.
- Releases build from a tag. The README documents how to verify a build locally (`npm ci && npm run build` and compare `dist/`).

### 10.6 Running locally
- `npm run preview` serves `dist/` on `127.0.0.1` only.
- Any static file server bound to localhost works. The app needs no backend.

### 10.7 Hosting origin

> **Warning: never deploy to `tuna-guven.github.io`.** The app must be served from a dedicated origin: a custom domain (or subdomain) that hosts nothing else. Until that domain exists, the Pages deploy workflow is parked at `.github/disabled-workflows/pages.yml`, outside `.github/workflows/`, so GitHub never runs it. Re-enabling it means moving it back. Dependabot does not watch it there, so refresh its action pins at that point.

The browser's security boundary is the origin (scheme, host, port), not the path. Every GitHub Pages project site of an account is served from the same origin, `https://<account>.github.io`, so `/trust-diagram/` would share it with every other repository the account publishes, now or later. On a shared origin:

- **CSP gives no protection.** `script-src 'self'` and `worker-src 'self'` allow any script on the origin, including one from another repository.
- **Service workers can take over the app.** A user site (`<account>.github.io` repository) can register a service worker with scope `/`. It would then intercept every request for this app and serve its own JavaScript, which runs with the app's full privileges, sees the passphrase and decrypted documents, and persists after that site's content changes.
- **Same-origin windows can read the app.** Any page on the origin can `window.open` the app and read its DOM, including decrypted documents after the user unlocks. The frame check (10.3) does not stop this.
- **Storage is shared.** IndexedDB belongs to the origin, so other pages can read the encrypted vault (enabling offline passphrase guessing), delete it, or replace it. AES-GCM detects tampering but cannot prevent loss.

Each of these needs only one other page on the origin to be malicious or to have an XSS bug, so the app's security would depend on every repository the account ever publishes. A dedicated origin makes the app the only code that origin ever runs. Before re-enabling the deploy, configure the custom domain in the repository's Pages settings (with HTTPS enforced) and serve nothing else from it.

---

## 11. Architecture

```
src/
  main.ts                 bootstrap: frame check, unlock flow, mount UI
  core/                   pure TypeScript, no DOM, no browser APIs
    model.ts              types from section 4
    result.ts             Result<T, E> type for expected failures
    schema.ts             parseDocument, limits, validation errors
    graph.ts              build dependency graph
    cycles.ts             Tarjan SCC, shortest cycle, classification
    evaluate.ts           fixpoint with provenance (section 5.3)
    paths.ts              minimal unlock sets (section 5.5)
    suggest.ts            fix suggestions (section 6.2)
    scenarios.ts          events to state, owner and attacker results
    sweep.ts              resilience sweep (worker-friendly)
    layout.ts             layered auto-layout
    issues.ts             issue list (section 6.1)
  state/
    store.ts              single document store, subscribe/notify
    commands.ts           undoable edit commands
    history.ts            undo/redo stacks
  persist/
    envelope.ts           encrypt/decrypt envelope (WebCrypto)
    vault.ts              IndexedDB read/write/wipe
    session.ts            passphrase, autosave, auto-lock
  ui/
    dom.ts                safe element and SVG helpers
    icons.ts              inline SVG icon paths
    canvas/               render.ts, viewport.ts, interact.ts, highlight.ts
    panels/               inspector.ts, issues.ts, paths.ts, scenarios.ts
    dialogs/              unlock.ts, export.ts, import.ts, confirm.ts
    toolbar.ts
  workers/
    sweep.worker.ts       runs core/sweep.ts off the main thread
  export/
    json.ts  svg.ts  png.ts
  styles/
    app.css
tests/
  core/*.test.ts          unit tests per core module
  persist/*.test.ts       envelope round trip, tamper detection
  fixtures/*.json         one document per known mistake, with expected results
e2e/
  *.spec.ts               Playwright flows
```

**Data flow.** UI events dispatch commands → the store applies them and notifies subscribers → the renderer redraws the affected SVG nodes → the analysis runs debounced on the new document → panels and highlights update. The core never imports from `state`, `persist` or `ui`.

**Performance targets.** 500 nodes and 2,000 edges at 60 fps while panning. Analysis under 50 ms for that size, excluding the sweep.

---

## 12. Testing

- **Core** (Vitest): every module, aiming at full branch coverage. Required cases:
  - DAG accepted; self-loop, two-node and long cycles each found, with the correct shortest cycle.
  - k-of-n rules, nested containers, ephemeral and `protection: none` databases.
  - Minimal unlock sets are minimal and complete on small graphs (checked against brute force over all subsets of base facts).
  - Property tests: random DAGs never report cycles; random graphs agree with a brute-force cycle check.
  - Every suggestion, once applied, removes its cycle and keeps critical databases openable.
- **Fixtures**: one fixture per known mistake (self-stored key, backward key, `.kdbx` only inside restic), each with expected circular groups, baseline results and issues, extended with paths and scenario results in later milestones.
- **Persistence**: envelope round trip; wrong passphrase fails; any modified byte in header or ciphertext fails; IV differs on every save.
- **E2E** (Playwright): create nodes and connections, see a cycle warning and apply a fix, run a scenario, export JSON, re-import it, lock and unlock. One test asserts that no network request is made during a full session.

---

## 13. Milestones

| # | Scope | Done when |
|---|---|---|
| M0 | Scaffold: Vite, TS strict, ESLint, Vitest, Playwright, CSP meta, CI, Pages deploy | Blank app deploys; CI green; CSP active |
| M1 | Core model, schema, graph, cycles, evaluate, issues | Unit tests and fixtures pass |
| M2 | Canvas: create, move, edit, delete nodes and edges; inspector; undo/redo | Each fixture in `tests/fixtures/` can be drawn by hand |
| M3 | Live issues panel, cycle highlighting, fix suggestions | Suggestions apply and pass verification |
| M4 | Paths panel with derivations and highlighting | Brute-force tests pass |
| M5 | Scenarios: checkbox matrix, presets, owner and attacker results, saved scenarios | Fixture scenarios match expected results |
| M6 | Encrypted vault, unlock screen, autosave, auto-lock, wipe | Persistence tests pass; no plaintext in storage |
| M7 | Import/export: JSON (plain and encrypted), SVG, PNG | Round trip is lossless |
| M8 | Auto-layout, resilience sweep in a worker, accessibility pass, themes | E2E suite passes; a11y checklist complete |

---

## 14. Future
- Argon2id via a vetted WASM build.
- Import from and export to the `trustchain.py` CLI JSON format, and a shared fixture suite run by both tools.
- Template library (a typical password-manager setup, a LUKS + YubiKey laptop, an SLIP-39 backup).
- Translations.
