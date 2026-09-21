import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// The PDF reflow eval runs the desktop engine's buildTextView straight from source (run.mjs
// drives it), so it needs the desktop's workspace aliases; everything else resolves from the
// engine files' own node_modules.
const desktop = resolve(__dirname, "../../apps/desktop");
export default defineConfig({
  resolve: { alias: [
    { find: /^@read\/normalize$/, replacement: resolve(desktop, "../../packages/normalize/src/index.ts") },
    { find: /^@read\/normalize\/contract$/, replacement: resolve(desktop, "../../packages/normalize/src/contract.ts") },
  ] },
  test: { environment: "node", root: __dirname, include: ["harness.test.ts"], testTimeout: 900_000, hookTimeout: 900_000, fileParallelism: false },
});
