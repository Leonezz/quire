import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const pkg = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf8")) as { version: string };
const outDir = resolve(__dirname, "out/renderer");

const workspace = [
  { find: /^@read\/ui$/, replacement: resolve(__dirname, "../../packages/ui/src/index.ts") },
  { find: /^@read\/core$/, replacement: resolve(__dirname, "../../packages/core/src/index.ts") },
  { find: /^@read\/reader$/, replacement: resolve(__dirname, "../../packages/reader/src/index.ts") },
  { find: /^@read\/reader-pdf$/, replacement: resolve(__dirname, "../../packages/reader-pdf/src/index.ts") },
  { find: /^@read\/normalize$/, replacement: resolve(__dirname, "../../packages/normalize/src/index.ts") },
  { find: /^@read\/normalize\/contract$/, replacement: resolve(__dirname, "../../packages/normalize/src/contract.ts") },
];

export default defineConfig({
  root: resolve(__dirname, "src/renderer"),
  clearScreen: false,
  define: {
    __QUIRE_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: { alias: workspace },
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "strip-dev-corpus-from-bundle",
      closeBundle() {
        rmSync(resolve(outDir, "dev"), { recursive: true, force: true });
      },
    },
  ],
  worker: {
    format: "es",
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: resolve(__dirname, "out/renderer"),
    emptyOutDir: true,
    target: "safari17",
  },
});
