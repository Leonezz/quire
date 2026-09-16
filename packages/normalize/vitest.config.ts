import { defineConfig } from "vitest/config";

// The engine is Node-only; its contract tests run in the node environment.
export default defineConfig({ test: { environment: "node", include: ["src/**/*.test.ts"] } });
