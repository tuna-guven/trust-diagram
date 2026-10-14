// Safe DOM construction (DESIGN.md 10.4). User strings only reach the DOM as text
// nodes or through setAttribute on names that cannot execute code or load resources.

export type Attributes = Readonly<Record<string, string | number | boolean>>;
export type Child = Node | string;

const SVG_NS = "http://www.w3.org/2000/svg";

// Event handler attributes run code, style attributes violate the CSP, and URL
// attributes could load resources or run javascript: URLs. Those get dedicated helpers.
const FORBIDDEN_ATTRIBUTES = new Set(["style", "href", "xlink:href", "src", "srcdoc", "srcset", "action", "formaction"]);

function assertSafeAttribute(name: string): void {
  const lower = name.toLowerCase();
  if (lower.startsWith("on") || FORBIDDEN_ATTRIBUTES.has(lower)) {
    throw new Error(`Attribute "${name}" must not be set through the generic DOM helpers`);
  }
}

function build<E extends Element>(element: E, attributes: Attributes, children: readonly Child[]): E {
  for (const [name, value] of Object.entries(attributes)) {
    assertSafeAttribute(name);
    if (value === false) continue;
    element.setAttribute(name, value === true ? "" : String(value));
  }
  for (const child of children) {
    element.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return element;
}

export function createElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Attributes = {},
  children: readonly Child[] = [],
): HTMLElementTagNameMap[K] {
  return build(document.createElement(tag), attributes, children);
}

export function createSvgElement<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attributes: Attributes = {},
  children: readonly Child[] = [],
): SVGElementTagNameMap[K] {
  return build(document.createElementNS(SVG_NS, tag), attributes, children);
}
