import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// The security bans of DESIGN.md 10.4 live in eslint.config.js; these cases pin the
// bypasses that have been closed so they cannot reopen. Type-aware linting only accepts
// files in the TypeScript project, so the snippets are linted as if they were
// src/main.ts, which gets the full UI rule set. lintText never reads or writes the file.
const eslint = new ESLint();

async function restrictedSyntaxMessages(code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: "src/main.ts" });
  return (result?.messages ?? []).filter((m) => m.ruleId === "no-restricted-syntax").map((m) => m.message);
}

const SINK = /HTML\/CSS string sinks/;
const ID = /Set id, name and for/;

describe("DOM sink bans", { timeout: 30_000 }, () => {
  it.each([
    ["an object literal key", "export const probe = (el: HTMLElement, s: string): void => { Object.assign(el, { innerHTML: s }); };"],
    ["a quoted object literal key", 'export const probe = (el: HTMLElement, s: string): void => { Object.assign(el, { "outerHTML": s }); };'],
    ["destructuring", "export const probe = (el: HTMLElement): string => { const { innerHTML } = el; return innerHTML; };"],
    ["member access", "export const probe = (el: HTMLElement, s: string): void => { el.innerHTML = s; };"],
  ])("flags an HTML sink written through %s", async (_, code) => {
    expect(await restrictedSyntaxMessages(code)).toContainEqual(expect.stringMatching(SINK));
  });

  it.each([
    ["Object.assign", 'export const probe = (el: HTMLElement): void => { Object.assign(el, { id: "app" }); };'],
    ["Object.assign with a quoted key", 'export const probe = (el: HTMLLabelElement): void => { Object.assign(el, { "htmlFor": "app" }); };'],
    ["assignment", 'export const probe = (el: HTMLElement): void => { el.id = "app"; };'],
  ])("flags an unprefixed id written through %s", async (_, code) => {
    expect(await restrictedSyntaxMessages(code)).toContainEqual(expect.stringMatching(ID));
  });

  it("allows id and name keys in plain data objects", async () => {
    expect(await restrictedSyntaxMessages('export const probe = { id: "d1", name: "Disk" };')).toEqual([]);
  });
});
