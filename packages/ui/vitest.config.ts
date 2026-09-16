import { defineConfig, mergeConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";
import { storybookTest } from "@storybook/addon-vitest/vitest-plugin";
import viteConfig from "./vite.config";

// Every story is a test: it renders in real Chromium, runs its play function,
// and fails on a11y violations (see .storybook/preview.ts).
export default mergeConfig(viteConfig, defineConfig({
  plugins: [storybookTest({ configDir: ".storybook" })],
  test: {
    name: "storybook",
    browser: { enabled: true, headless: true, provider: playwright(), instances: [{ browser: "chromium" }] },
    setupFiles: [".storybook/vitest.setup.ts"],
  },
}));
