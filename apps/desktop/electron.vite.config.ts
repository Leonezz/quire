import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

const workspace = [
  { find: /^@read\/ui$/, replacement: resolve(__dirname, "../../packages/ui/src/index.ts") },
  { find: /^@read\/core$/, replacement: resolve(__dirname, "../../packages/core/src/index.ts") },
  { find: /^@read\/reader$/, replacement: resolve(__dirname, "../../packages/reader/src/index.ts") },
  { find: /^@read\/normalize$/, replacement: resolve(__dirname, "../../packages/normalize/src/index.ts") },
  { find: /^@read\/normalize\/contract$/, replacement: resolve(__dirname, "../../packages/normalize/src/contract.ts") },
];

export default defineConfig({
  // The normalization engine and its deps are bundled into main (like the old
  // esbuild engine bundle); only electron and native modules stay external.
  main: { resolve: { alias: workspace }, build: { rollupOptions: { external: ["electron", "canvas", "jsdom", "mathml-to-latex", "temml"] } } },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: { resolve: { alias: workspace }, plugins: [react(), tailwindcss()] },
});
