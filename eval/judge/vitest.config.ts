import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// The judge runs the desktop engine's captureTextOf and the eval's normalizeSnapshot straight from
// source (run.mjs drives it), so it needs the same workspace aliases as the PDF eval; linkedom
// resolves from the engine file's own node_modules. Cases run JUDGE_CONCURRENCY at a time.
const desktop = resolve(__dirname, "../../apps/desktop");
export default defineConfig({
  resolve: { alias: [
    { find: /^@read\/normalize$/, replacement: resolve(desktop, "../../packages/normalize/src/index.ts") },
    { find: /^@read\/normalize\/contract$/, replacement: resolve(desktop, "../../packages/normalize/src/contract.ts") },
  ] },
  test: {
    environment: "node", root: __dirname, include: ["harness.test.ts"],
    testTimeout: 20 * 60_000, hookTimeout: 20 * 60_000, fileParallelism: false,
    maxConcurrency: Math.max(1, Number(process.env.JUDGE_CONCURRENCY ?? 3) || 3),
  },
});
