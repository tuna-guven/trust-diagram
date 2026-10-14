// Safe DOM construction (DESIGN.md 10.4). User strings only reach the DOM as text
// nodes or as values of allowlisted attributes that cannot execute code or load
// resources. ESLint bans setAttribute, createElement and style.setProperty outside this
// module, so these helpers are the only way elements, attributes and inline styles are made.

export type Attributes = Readonly<Record<string, string | number | boolean>>;
export type Child = Node | string;

const SVG_NS = "http://www.w3.org/2000/svg";

// An allowlist, not a blocklist: a tag or attribute the app has not needed before must
// be reviewed and added here. Elements that load resources or run code (script, iframe,
// a, img, use, image, foreignObject) and SVG animation, which can rewrite attributes at
// runtime, are deliberately absent.
const HTML_TAGS = new Set([
  "aside",
  "button",
  "details",
  "dialog",
  "div",
  "fieldset",
  "footer",
  "h1",
  "h2",
  "h3",
  "header",
  "input",
  "label",
  "legend",
  "li",
  "main",
  "nav",
  "ol",
  "option",
  "p",
  "section",
  "select",
  "span",
  "strong",
  "summary",
  "textarea",
  "ul",
]);

const SVG_TAGS = new Set([
  "circle",
  "defs",
  "desc",
  "ellipse",
  "g",
  "line",
  "marker",
  "path",
  "polygon",
  "polyline",
  "rect",
  "svg",
  "text",
  "title",
  "tspan",
]);

// Names are case-sensitive: SVG attributes such as viewBox and refX are camelCase.
const ATTRIBUTES = new Set([
  // Global and form attributes.
  "autocomplete",
  "checked",
  "class",
  "cols",
  "dir",
  "disabled",
  "draggable",
  "for",
  "hidden",
  "id",
  "lang",
  "max",
  "maxlength",
  "min",
  "minlength",
  "multiple",
  "name",
  "open",
  "placeholder",
  "readonly",
  "required",
  "role",
  "rows",
  "selected",
  "spellcheck",
  "step",
  "tabindex",
  "title",
  "type",
  "value",
  // SVG geometry and presentation.
  "cx",
  "cy",
  "d",
  "dominant-baseline",
  "dx",
  "dy",
  "fill",
  "fill-opacity",
  "focusable",
  "font-size",
  "font-weight",
  "height",
  "marker-end",
  "marker-start",
  "markerHeight",
  "markerUnits",
  "markerWidth",
  "opacity",
  "orient",
  "pointer-events",
  "points",
  "preserveAspectRatio",
  "r",
  "refX",
  "refY",
  "rx",
  "ry",
  "stroke",
  "stroke-dasharray",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-opacity",
  "stroke-width",
  "text-anchor",
  "transform",
  "vector-effect",
  "viewBox",
  "width",
  "x",
  "x1",
  "x2",
  "y",
  "y1",
  "y2",
]);

const PREFIXED_ATTRIBUTE = /^(?:aria|data)-[a-z0-9-]+$/;

// Presentation attributes are parsed as CSS, so their values could load a resource with
// url(...), possibly spelled with CSS escapes. Only a fragment reference to an element in
// the same document is allowed, and paint must be a validated hex colour or a keyword
// (CLAUDE.md, DESIGN.md 10.4). Other attributes are plain text and need no value check.
const PAINT_ATTRIBUTES = new Set(["fill", "stroke"]);
const CSS_ATTRIBUTES = new Set([
  "dominant-baseline",
  "fill-opacity",
  "font-size",
  "font-weight",
  "marker-end",
  "marker-start",
  "opacity",
  "pointer-events",
  "stroke-dasharray",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-opacity",
  "stroke-width",
  "text-anchor",
  "transform",
  "vector-effect",
]);
const PAINT_KEYWORDS = new Set(["none", "currentColor", "context-fill", "context-stroke"]);
const HEX_COLOR = /^#[0-9a-f]{6}$/;
const LOCAL_REFERENCE = /^url\(#tc-[A-Za-z0-9_-]{1,64}\)$/;
const URL_OR_ESCAPE = /url\s*\(|\\/i;

// Every element with an id becomes a named property of window, so an id such as "fetch"
// or "config" could shadow a global the app reads (DOM clobbering). The hyphen in "tc-"
// can never appear in a JavaScript identifier, so prefixed ids cannot shadow one. name and
// for are held to the same rule so a user string never reaches any of them unprefixed.
const ID_ATTRIBUTES = new Set(["for", "id", "name"]);
const ID_VALUE = /^tc-[A-Za-z0-9_-]{1,64}$/;

// Inline style properties are allowlisted like attributes. Custom properties carry the
// app's prefix so they cannot override a theme variable by accident.
const STYLE_PROPERTIES = new Set(["cursor", "display", "height", "left", "top", "transform", "transform-origin", "visibility", "width"]);
const CUSTOM_PROPERTY = /^--tc-[a-z0-9-]+$/;
// Only functions that compute a value; url(), image-set(), image(), src() and the like
// would load a resource. CSS function names are ASCII case-insensitive.
const STYLE_FUNCTIONS = new Set([
  "calc",
  "clamp",
  "matrix",
  "max",
  "min",
  "rotate",
  "scale",
  "scalex",
  "scaley",
  "translate",
  "translatex",
  "translatey",
  "var",
]);
const CSS_FUNCTION = /([A-Za-z0-9_-]+)\s*\(/g;
// Escapes and comments can disguise a function name, so neither is ever needed or allowed.
const CSS_ESCAPE_OR_COMMENT = /\\|\/\*/;

export function assertSafeTag(tag: string, namespace: "html" | "svg"): void {
  if (!(namespace === "html" ? HTML_TAGS : SVG_TAGS).has(tag)) {
    throw new Error(`Element <${tag}> is not allowlisted in src/ui/dom.ts`);
  }
}

export function assertSafeAttribute(name: string, value: string): void {
  if (!ATTRIBUTES.has(name) && !PREFIXED_ATTRIBUTE.test(name)) {
    throw new Error(`Attribute "${name}" is not allowlisted in src/ui/dom.ts`);
  }
  if (ID_ATTRIBUTES.has(name)) {
    if (!ID_VALUE.test(value)) throw new Error(`Attribute "${name}" must match ${String(ID_VALUE)}`);
  } else if (PAINT_ATTRIBUTES.has(name)) {
    if (!PAINT_KEYWORDS.has(value) && !HEX_COLOR.test(value) && !LOCAL_REFERENCE.test(value)) {
      throw new Error(`Attribute "${name}" must be a #rrggbb colour, a paint keyword or url(#id)`);
    }
  } else if (CSS_ATTRIBUTES.has(name) && URL_OR_ESCAPE.test(value) && !LOCAL_REFERENCE.test(value)) {
    throw new Error(`Attribute "${name}" may only reference url(#id) in this document`);
  }
}

export function assertSafeStyle(property: string, value: string): void {
  if (!STYLE_PROPERTIES.has(property) && !CUSTOM_PROPERTY.test(property)) {
    throw new Error(`Style property "${property}" is not allowlisted in src/ui/dom.ts`);
  }
  if (CSS_ESCAPE_OR_COMMENT.test(value)) {
    throw new Error(`Style property "${property}" may not contain CSS escapes or comments`);
  }
  for (const [, functionName = ""] of value.matchAll(CSS_FUNCTION)) {
    if (!STYLE_FUNCTIONS.has(functionName.toLowerCase())) {
      throw new Error(`Style property "${property}" may not use ${functionName}()`);
    }
  }
}

/** The only way to set an inline style (DESIGN.md 10.3, 10.4). */
export function setStyle(element: HTMLElement | SVGElement, property: string, value: string): void {
  assertSafeStyle(property, value);
  element.style.setProperty(property, value);
}

function build<E extends Element>(element: E, attributes: Attributes, children: readonly Child[]): E {
  for (const [name, value] of Object.entries(attributes)) {
    if (value === false) continue;
    const text = value === true ? "" : String(value);
    assertSafeAttribute(name, text);
    element.setAttribute(name, text);
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
  assertSafeTag(tag, "html");
  return build(document.createElement(tag), attributes, children);
}

export function createSvgElement<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attributes: Attributes = {},
  children: readonly Child[] = [],
): SVGElementTagNameMap[K] {
  assertSafeTag(tag, "svg");
  return build(document.createElementNS(SVG_NS, tag), attributes, children);
}
