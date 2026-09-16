import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()] },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: {
    // Exact-match aliases so "@read/ui/tokens.css" still resolves through the package exports.
    resolve: { alias: [{ find: /^@read\/ui$/, replacement: resolve(__dirname, "../../packages/ui/src/index.ts") }, { find: /^@read\/core$/, replacement: resolve(__dirname, "../../packages/core/src/index.ts") }] },
    plugins: [react(), tailwindcss()],
  },
});
