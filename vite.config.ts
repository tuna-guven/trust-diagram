import { defineConfig } from "vite";

// The dev server runs under the same CSP as production (connect-src 'none'),
// so HMR and its WebSocket are disabled: reload the page manually.
export default defineConfig({
  // Relative base so the same build works on GitHub Pages and any local static server.
  base: "./",
  server: {
    host: "127.0.0.1",
    strictPort: true,
    hmr: false,
    ws: false,
  },
  preview: {
    host: "127.0.0.1",
    strictPort: true,
  },
  build: {
    target: "es2023",
    sourcemap: false,
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
  },
});
