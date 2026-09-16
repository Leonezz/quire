import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

// Main-process engine tests run in Node against the workspace sources.
export default defineConfig({
  resolve: { alias: [
    { find: /^@read\/normalize$/, replacement: resolve(__dirname, "../../packages/normalize/src/index.ts") },
    { find: /^@read\/normalize\/contract$/, replacement: resolve(__dirname, "../../packages/normalize/src/contract.ts") },
  ] },
  test: { environment: "node", include: ["src/main/**/*.test.ts"] },
});
