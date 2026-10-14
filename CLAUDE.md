# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project

**trustchain** is an offline, serverless web app for drawing a chain of trust (databases, keys, and how they contain and unlock each other). It detects circular dependencies, lists unlock paths, and simulates threat scenarios. Full specification: **`docs/DESIGN.md`**. Read the relevant section before starting any task, and treat it as the source of truth. If a task conflicts with it, stop and ask instead of improvising.

## Stack

- TypeScript (strict), vanilla DOM + SVG. **No UI framework.**
- Vite for dev/build, Vitest for unit tests, Playwright for e2e, ESLint with typescript-eslint.
- WebCrypto and IndexedDB. No crypto or storage libraries.
- **Zero runtime dependencies.** Never add one without explicit approval from the maintainer.

## Commands

```bash
npm ci                 # install exactly from the lockfile (scripts are disabled by .npmrc)
npm run dev            # dev server on 127.0.0.1
npm run typecheck      # tsc --noEmit
npm run lint           # eslint
npm test               # vitest run
npm run test:watch     # vitest
npm run e2e            # playwright test
npm run build          # production build to dist/
npm run preview        # serve dist/ on 127.0.0.1
npm run check          # typecheck + lint + test (run before every commit)
```

## Architecture rules

- `src/core/` is **pure**: no DOM, no `window`, no browser APIs, no imports from `state/`, `persist/`, `ui/`, `export/` or `workers/`. All analysis lives here and is unit tested.
- Dependency direction: `ui → state → core`, `persist → core`, `export → core`. Never the reverse.
- All document edits go through commands in `src/state/commands.ts` so they are undoable. Never mutate the document directly from UI code.
- All external input (imports, decrypted vault data) goes through `parseDocument` in `src/core/schema.ts` before use.
- Analysis output must be deterministic: sort by stable keys (ids, names), never rely on `Set`/`Map` insertion order from user actions.
- Implement the semantics in DESIGN.md section 5 exactly. If you find an ambiguity, ask.

## Security rules (non-negotiable)

- Never use `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval`, `new Function`, or `setTimeout`/`setInterval` with a string. Build DOM with the helpers in `src/ui/dom.ts` (`createElement`, `createElementNS`, `textContent`).
- Never set a `style="..."` attribute. Use SVG presentation attributes or `element.style.setProperty`.
- Never use `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `navigator.sendBeacon`, or anything else that touches the network. No CDNs, web fonts, analytics or external links that load resources.
- Never write to cookies, `localStorage` or `sessionStorage`. The only persistent write is the encrypted envelope in IndexedDB (`src/persist/vault.ts`).
- Never log document contents, passphrases or keys, including in tests' console output.
- Randomness only from `crypto.getRandomValues` / `crypto.randomUUID`. Never `Math.random` for ids, salts or IVs.
- Colours must match `^#[0-9a-f]{6}$` before reaching the DOM. Enforce limits from DESIGN.md 4.4.
- Do not weaken the CSP in `index.html`. If a feature seems to need that, stop and ask.
- Keep `.npmrc` (`ignore-scripts=true`, `save-exact=true`). Pin GitHub Actions to commit SHAs.

## Code style

- `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`. No `any`; use `unknown` and narrow. No non-null assertions (`!`) except in tests.
- Prefer small pure functions and plain data types. Use discriminated unions over classes where possible.
- Name things after the domain: `Database`, `Key`, `UnlockRule`, `Scenario`, never generic `Node`/`Item` in public APIs.
- Use the `Result<T, E>` type from `src/core/result.ts` for expected failures; throw only for programmer errors.
- Comments explain *why*, not *what*. Each core module starts with a short header naming the DESIGN.md section it implements.
- No dead code, no commented-out code, no TODOs without an issue number.

## Testing rules

- Every change to `src/core/` comes with tests. New algorithms also need a brute-force comparison test on small random inputs.
- Fixtures live in `tests/fixtures/` with an expected-results file next to each. When behaviour changes intentionally, update expectations in the same commit and say why in the message.
- Persistence tests must cover: round trip, wrong passphrase, tampered header, tampered ciphertext, unique IV per save.
- The e2e suite includes a test asserting that a full session makes zero network requests. Keep it passing.

## Workflow

- Work milestone by milestone (DESIGN.md section 13). Do not start a later milestone's features early.
- Before coding a task: restate the goal, list the files you will touch, and name the DESIGN.md sections involved.
- Keep commits small and focused. Use Conventional Commits (`feat:`, `fix:`, `test:`, `refactor:`, `docs:`, `chore:`, `ci:`).
- Run `npm run check` before every commit and `npm run e2e` before finishing a milestone.
- If a task would require any of the following, stop and ask first:
  - adding a dependency of any kind
  - changing the document schema (bump `schemaVersion` and add a migration)
  - changing the envelope format or crypto parameters
  - relaxing the CSP or a security rule
  - deviating from DESIGN.md

## Definition of done

- `npm run check` and `npm run build` pass with no warnings.
- New behaviour is covered by tests; e2e passes at milestone boundaries.
- No new runtime dependencies; no banned APIs; CSP unchanged.
- DESIGN.md updated if the behaviour or a decision changed.
- UI changes work with keyboard only, in light and dark themes, and at 200% zoom.
