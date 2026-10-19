// @ts-check
import js from "@eslint/js";
import globals from "globals";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

// DESIGN.md 10.4: unsafe DOM sinks, dynamic code, navigation and network/storage APIs are banned.
const globalApis =
  "/^(fetch|XMLHttpRequest|WebSocket|EventSource|WebTransport|RTCPeerConnection|indexedDB|eval|Function|importScripts|DOMParser|CSSStyleSheet|open|navigation)$/";

/**
 * Matches a member access by name, whether written el.name or el["name"]. Banning the
 * member itself, not only a call to it, also catches .call/.apply and passing it around.
 * @param {string} names a regex literal such as "/^(a|b)$/"
 */
function member(names) {
  return `MemberExpression:matches([property.name=${names}], [property.value=${names}])`;
}

/**
 * Matches an object key by name, both destructuring (const { innerHTML } = el) and
 * object literals (Object.assign(el, { innerHTML })), which write the member directly.
 * @param {string} names a regex literal such as "/^(a|b)$/"
 */
function objectKey(names) {
  return `Property:matches([key.name=${names}], [key.value=${names}])`;
}

const htmlSinks =
  "/^(innerHTML|outerHTML|insertAdjacentHTML|srcdoc|cssText|setHTMLUnsafe|parseHTMLUnsafe|createContextualFragment|importNode|adoptNode)$/";
const locationOwners = "/^(window|globalThis|self|document)$/";

const bannedSyntax = [
  {
    selector: member(htmlSinks),
    message: "HTML/CSS string sinks and foreign-node imports are banned. Use the helpers in src/ui/dom.ts.",
  },
  {
    selector: objectKey(htmlSinks),
    message: "HTML/CSS string sinks and foreign-node imports are banned. Use the helpers in src/ui/dom.ts.",
  },
  {
    selector: "MemberExpression[object.name='document'][property.name=/^(write|writeln|cookie|implementation|open)$/]",
    message: "document.write, document.open, document.implementation and cookies are banned.",
  },
  {
    selector: "MemberExpression[object.name='Math'][property.name='random']",
    message: "Use crypto.getRandomValues or crypto.randomUUID.",
  },
  {
    selector: member("/^(sendBeacon|serviceWorker|localStorage|sessionStorage)$/"),
    message: "Network beacons, service workers and Web Storage are banned.",
  },
  {
    selector: "CallExpression[callee.property.name=/^(setAttribute|setAttributeNS)$/] > Literal[value='style']",
    message: "Never set a style attribute. Use SVG presentation attributes or setStyle from src/ui/dom.ts.",
  },
  {
    selector: "AssignmentExpression > MemberExpression.left[property.name='style']",
    message: "Never assign element.style. Use setStyle from src/ui/dom.ts.",
  },
  {
    selector: "CallExpression[callee.name=/^(setTimeout|setInterval)$/] > Literal.arguments:first-child",
    message: "String-based timers are banned.",
  },
  {
    selector: "CallExpression[callee.name='importScripts']",
    message: "importScripts is banned.",
  },
  {
    // no-restricted-globals only sees bare names; window.fetch and friends would slip past it.
    selector: `MemberExpression[object.name=/^(window|globalThis|self)$/]:matches([property.name=${globalApis}], [property.value=${globalApis}])`,
    message: "Network, navigation, parsing and dynamic-code APIs are banned, including through window, globalThis or self.",
  },
  // CSP does not govern top-level navigation, so a URL carrying data would leave the
  // machine despite connect-src 'none' (DESIGN.md 10.4). location.reload stays allowed.
  {
    selector: "AssignmentExpression[left.name='location']",
    message: "Navigation is banned: it can carry data off the machine.",
  },
  {
    selector: `AssignmentExpression > MemberExpression.left[object.name=${locationOwners}][property.name='location']`,
    message: "Navigation is banned: it can carry data off the machine.",
  },
  {
    selector: "AssignmentExpression > MemberExpression.left:matches([object.name='location'], [object.property.name='location'])",
    message: "Navigation is banned: it can carry data off the machine.",
  },
  {
    selector: "MemberExpression:matches([object.name='location'], [object.property.name='location'])[property.name=/^(assign|replace)$/]",
    message: "Navigation is banned: it can carry data off the machine.",
  },
  {
    selector: "MemberExpression[object.name='navigation'], MemberExpression[property.name='navigation']",
    message: "The Navigation API is banned: it can carry data off the machine.",
  },
];

const domMethods =
  "/^(setAttribute|setAttributeNS|setAttributeNode|setAttributeNodeNS|toggleAttribute|attributes|getAttributeNode|getAttributeNodeNS|setNamedItem|setNamedItemNS|createElement|createElementNS|setProperty|insertRule|replaceSync|adoptedStyleSheets)$/";

// DESIGN.md 10.4: elements, attributes and inline styles are only created through the
// allowlists in src/ui/dom.ts, so a URL, handler or style value cannot be set anywhere else.
const domSinkSyntax = [
  {
    selector: member(domMethods),
    message: "Create elements and set attributes or styles through the helpers in src/ui/dom.ts.",
  },
  {
    selector: objectKey(domMethods),
    message: "Create elements and set attributes or styles through the helpers in src/ui/dom.ts.",
  },
  {
    selector: "AssignmentExpression > MemberExpression.left[property.name=/^(href|src|srcset|action|formAction|poster|ping|background)$/]",
    message: "URL properties load resources or navigate. Add a reviewed helper to src/ui/dom.ts instead.",
  },
];

// Application code also may not name a sink in a string, which catches Reflect.set(el,
// "innerHTML", ...) and similar indirection. Tests are exempt: they list sinks as data.
const sourceSyntax = [
  {
    selector: `Literal[value=${htmlSinks}], TemplateElement[value.raw=${htmlSinks}]`,
    message: "Naming an HTML sink in a string is banned. Use the helpers in src/ui/dom.ts.",
  },
];

// Code that builds DOM may not assign id, name or htmlFor directly: dom.ts requires the
// tc- prefix so an element can never clobber a global (DESIGN.md 10.4).
const domPropertySyntax = [
  {
    selector: "AssignmentExpression > MemberExpression.left[property.name=/^(id|name|htmlFor)$/]",
    message: "Set id, name and for through the helpers in src/ui/dom.ts, which enforce the tc- prefix.",
  },
  {
    // Object.assign writes each key as a property, so { id } there is an assignment too.
    // Other object literals with an id key are plain data, such as domain entities.
    selector:
      "CallExpression[callee.object.name='Object'][callee.property.name='assign'] > ObjectExpression > Property:matches([key.name=/^(id|name|htmlFor)$/], [key.value=/^(id|name|htmlFor)$/])",
    message: "Set id, name and for through the helpers in src/ui/dom.ts, which enforce the tc- prefix.",
  },
];

const bannedGlobals = [
  ...["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "WebTransport", "RTCPeerConnection"].map((name) => ({
    name,
    message: "The app makes no network requests (DESIGN.md 2, 10.4).",
  })),
  ...["localStorage", "sessionStorage"].map((name) => ({
    name,
    message: "Only the encrypted vault in IndexedDB may persist data (DESIGN.md 8.1).",
  })),
  ...["open", "navigation"].map((name) => ({
    name,
    message: "Navigation is banned: it can carry data off the machine (DESIGN.md 10.4).",
  })),
  { name: "DOMParser", message: "Parsing HTML is banned. Use the helpers in src/ui/dom.ts." },
  { name: "CSSStyleSheet", message: "Constructable stylesheets are banned. Use setStyle from src/ui/dom.ts." },
  { name: "indexedDB", message: "IndexedDB is only accessed from src/persist/vault.ts." },
  { name: "eval", message: "eval is banned." },
  { name: "Function", message: "new Function is banned." },
];

// CLAUDE.md: ui -> state -> core, persist -> core, export -> core. Never the reverse.
/**
 * @param {...string} forbidden
 * @returns {import("eslint").Linter.RulesRecord}
 */
function layerImports(...forbidden) {
  return {
    "no-restricted-imports": [
      "error",
      {
        patterns: forbidden.map((dir) => ({
          group: [`**/${dir}`, `**/${dir}/**`],
          message: `This layer must not import from src/${dir} (see CLAUDE.md, architecture rules).`,
        })),
      },
    ],
  };
}

export default defineConfig(
  { ignores: ["dist/", "coverage/", "test-results/", "playwright-report/", "node_modules/"] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.js", "*.config.ts"],
          defaultProject: "tsconfig.node.json",
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "no-eval": "error",
      "no-implied-eval": "off",
      "@typescript-eslint/no-implied-eval": "error",
      "no-new-func": "error",
      "no-script-url": "error",
      "no-restricted-syntax": ["error", ...bannedSyntax, ...domSinkSyntax],
      "no-restricted-globals": ["error", ...bannedGlobals],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      eqeqeq: "error",
    },
  },
  {
    files: ["src/**/*.ts"],
    languageOptions: { globals: globals.browser },
    rules: {
      "no-console": "error",
      "no-restricted-syntax": ["error", ...bannedSyntax, ...domSinkSyntax, ...sourceSyntax],
    },
  },
  {
    files: ["src/main.ts", "src/ui/**/*.ts", "src/export/**/*.ts"],
    rules: { "no-restricted-syntax": ["error", ...bannedSyntax, ...domSinkSyntax, ...sourceSyntax, ...domPropertySyntax] },
  },
  {
    files: ["src/core/**/*.ts"],
    rules: {
      ...layerImports("state", "persist", "ui", "export", "workers"),
      "no-restricted-globals": [
        "error",
        ...bannedGlobals,
        ...["window", "document", "navigator", "self", "crypto", "location", "history", "performance"].map((name) => ({
          name,
          message: "src/core is pure: no DOM or browser APIs.",
        })),
      ],
    },
  },
  { files: ["src/state/**/*.ts"], rules: layerImports("persist", "ui", "export", "workers") },
  { files: ["src/persist/**/*.ts"], rules: layerImports("state", "ui", "export", "workers") },
  { files: ["src/export/**/*.ts"], rules: layerImports("state", "persist", "ui", "workers") },
  {
    files: ["src/persist/vault.ts"],
    rules: {
      "no-restricted-globals": ["error", ...bannedGlobals.filter((g) => g.name !== "indexedDB")],
    },
  },
  {
    files: ["src/ui/dom.ts"],
    rules: { "no-restricted-syntax": ["error", ...bannedSyntax, ...sourceSyntax] },
  },
  {
    files: ["tests/**/*.ts", "e2e/**/*.ts"],
    rules: { "@typescript-eslint/no-non-null-assertion": "off" },
  },
  {
    files: ["*.config.ts", "eslint.config.js"],
    languageOptions: { globals: globals.node },
  },
);
