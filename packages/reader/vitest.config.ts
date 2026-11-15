import { defineConfig } from "vitest/config";

// reader.css is loaded, not blanked, so its test can read the rules as text (`?raw`).
export default defineConfig({ test: { css: { include: [/reader\.css/u] }, environment: "jsdom", globals: true, include: ["src/**/*.test.ts", "src/**/*.test.tsx"] } });
