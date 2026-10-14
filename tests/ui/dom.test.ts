import { describe, expect, it } from "vitest";
import { assertSafeAttribute, assertSafeStyle, assertSafeTag } from "../../src/ui/dom";

describe("assertSafeTag", () => {
  it.each<[string, "html" | "svg"]>([
    ["script", "html"],
    ["iframe", "html"],
    ["object", "html"],
    ["embed", "html"],
    ["a", "html"],
    ["img", "html"],
    ["form", "html"],
    ["DIV", "html"],
    ["script", "svg"],
    ["foreignObject", "svg"],
    ["animate", "svg"],
    ["set", "svg"],
    ["use", "svg"],
    ["image", "svg"],
    ["a", "svg"],
    ["div", "svg"],
    ["rect", "html"],
  ])("rejects <%s> in %s", (tag, namespace) => {
    expect(() => {
      assertSafeTag(tag, namespace);
    }).toThrow();
  });

  it.each<[string, "html" | "svg"]>([
    ["div", "html"],
    ["button", "html"],
    ["svg", "svg"],
    ["g", "svg"],
    ["rect", "svg"],
    ["path", "svg"],
    ["text", "svg"],
    ["marker", "svg"],
  ])("allows <%s> in %s", (tag, namespace) => {
    expect(() => {
      assertSafeTag(tag, namespace);
    }).not.toThrow();
  });
});

describe("assertSafeAttribute", () => {
  it.each([
    "onclick",
    "OnLoad",
    "style",
    "href",
    "xlink:href",
    "src",
    "srcdoc",
    "data",
    "formaction",
    "ping",
    "filter",
    "mask",
    "clip-path",
    "Class",
    "aria-Label",
  ])("rejects the attribute %s", (name) => {
    expect(() => {
      assertSafeAttribute(name, "x");
    }).toThrow();
  });

  it.each([
    ["class", "node selected"],
    ["role", "img"],
    ["aria-label", "Recovery DB"],
    ["data-node-id", "abc"],
    ["viewBox", "0 0 10 10"],
    ["refX", "5"],
    ["stroke-dasharray", "4 2"],
    ["title", "url(https://example.com) C:\\Users"],
    ["value", "C:\\Users\\vault.kdbx"],
    ["fill", "#1a2b3c"],
    ["fill", "none"],
    ["stroke", "context-stroke"],
    ["fill", "url(#tc-gradient-1)"],
    ["marker-end", "url(#tc-arrow)"],
    ["id", "tc-node-3f2a"],
    ["for", "tc-name-input"],
    ["name", "tc-category"],
  ])("allows %s=%s", (name, value) => {
    expect(() => {
      assertSafeAttribute(name, value);
    }).not.toThrow();
  });

  it.each([
    ["fill", "#1A2B3C"],
    ["fill", "red"],
    ["fill", "url(https://example.com/x.svg#a)"],
    ["stroke", "url(#a) red"],
    ["marker-end", "url(https://example.com/x.svg#a)"],
    ["marker-end", "url( #a)"],
    ["marker-start", "\\75 rl(https://example.com/x.svg#a)"],
    ["transform", "URL(x)"],
    ["marker-end", "url(#arrow)"],
    ["id", "fetch"],
    ["id", "config"],
    ["id", "tc-"],
    ["id", "tc-a b"],
    ["name", "location"],
    ["for", "Recovery DB"],
    ["id", `tc-${"a".repeat(65)}`],
  ])("rejects %s=%s", (name, value) => {
    expect(() => {
      assertSafeAttribute(name, value);
    }).toThrow();
  });
});

describe("assertSafeStyle", () => {
  it.each([
    ["transform", "translate(10px, 20px) scale(1.5)"],
    ["transform", "matrix(1, 0, 0, 1, 0, 0)"],
    ["width", "calc(100% - var(--tc-gutter))"],
    ["cursor", "grab"],
    ["--tc-node-fill", "#1a2b3c"],
  ])("allows %s: %s", (property, value) => {
    expect(() => {
      assertSafeStyle(property, value);
    }).not.toThrow();
  });

  it.each([
    ["background", "red"],
    ["background-image", "none"],
    ["--accent", "red"],
    ["--tc-Accent", "red"],
    ["width", "url(https://example.com/x)"],
    ["width", "URL(x)"],
    ["width", "image-set('x.png' 1x)"],
    ["width", "var(--tc-a, url(x))"],
    ["width", "\\75 rl(x)"],
    ["width", "u/**/rl(x)"],
    ["cursor", "src(x)"],
  ])("rejects %s: %s", (property, value) => {
    expect(() => {
      assertSafeStyle(property, value);
    }).toThrow();
  });
});
