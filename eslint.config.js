// @ts-check
import js from "@eslint/js";
import globals from "globals";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

// DESIGN.md 10.4: unsafe DOM sinks, dynamic code and network/storage APIs are banned.
const bannedSyntax = [
  {
    selector: "MemberExpression[property.name=/^(innerHTML|outerHTML|insertAdjacentHTML|srcdoc|cssText)$/]",
    message: "HTML/CSS string sinks are banned. Use the helpers in src/ui/dom.ts.",
  },
  {
    selector: "MemberExpression[object.name='document'][property.name=/^(write|writeln|cookie)$/]",
    message: "document.write and cookies are banned.",
  },
  {
    selector: "MemberExpression[object.name='Math'][property.name='random']",
    message: "Use crypto.getRandomValues or crypto.randomUUID.",
  },
  {
    selector: "MemberExpression[property.name=/^(sendBeacon|serviceWorker|localStorage|sessionStorage)$/]",
    message: "Network beacons, service workers and Web Storage are banned.",
  },
  {
    selector: "CallExpression[callee.property.name=/^(setAttribute|setAttributeNS)$/] > Literal[value='style']",
    message: "Never set a style attribute. Use SVG presentation attributes or element.style.setProperty.",
  },
  {
    selector: "AssignmentExpression > MemberExpression.left[property.name='style']",
    message: "Never assign element.style. Use element.style.setProperty.",
  },
  {
    selector: "CallExpression[callee.name=/^(setTimeout|setInterval)$/] > Literal.arguments:first-child",
    message: "String-based timers are banned.",
  },
  {
    selector: "CallExpression[callee.name='importScripts']",
    message: "importScripts is banned.",
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
      "no-restricted-syntax": ["error", ...bannedSyntax],
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
    rules: { "no-console": "error" },
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
    files: ["tests/**/*.ts", "e2e/**/*.ts"],
    rules: { "@typescript-eslint/no-non-null-assertion": "off" },
  },
  {
    files: ["*.config.ts", "eslint.config.js"],
    languageOptions: { globals: globals.node },
  },
);
