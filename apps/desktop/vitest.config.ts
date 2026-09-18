import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

// Main-process engine tests run in Node against the workspace sources; renderer tests declare
// `// @vitest-environment jsdom` per file and render with React Testing Library (see src/renderer/test-setup.ts).
export default defineConfig({
  resolve: { alias: [
    { find: /^@read\/normalize$/, replacement: resolve(__dirname, "../../packages/normalize/src/index.ts") },
    { find: /^@read\/normalize\/contract$/, replacement: resolve(__dirname, "../../packages/normalize/src/contract.ts") },
    { find: /^@read\/ui$/, replacement: resolve(__dirname, "../../packages/ui/src/index.ts") },
    { find: /^@read\/core$/, replacement: resolve(__dirname, "../../packages/core/src/index.ts") },
    { find: /^@read\/reader$/, replacement: resolve(__dirname, "../../packages/reader/src/index.ts") },
    { find: /^@read\/reader-pdf$/, replacement: resolve(__dirname, "../../packages/reader-pdf/src/index.ts") },
  ] },
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    include: ["src/main/**/*.test.ts", "src/renderer/src/**/*.test.{ts,tsx}"],
    setupFiles: ["src/renderer/test-setup.ts"],
  },
});
