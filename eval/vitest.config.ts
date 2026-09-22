import { defineConfig } from "vitest/config";

// The corpus eval (src) plus the unit tests of the judge and the scripts; the judge's own run
// (judge/harness.test.ts, needs Codex) has its own config and is driven by judge/run.mjs.
export default defineConfig({ test: { environment: "node", include: ["src/**/*.test.ts", "judge/judge.test.ts", "scripts/*.test.ts"], testTimeout: 60_000, hookTimeout: 60_000 } });
