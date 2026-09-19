import { defineConfig, mergeConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";
import { storybookTest } from "@storybook/addon-vitest/vitest-plugin";
import viteConfig from "./vite.config";

// Two projects: every story is a test (it renders in real Chromium, runs its play function, and fails
// on a11y violations — see .storybook/preview.ts), and the source guards (src/**/*.test.ts) run in Node.
export default mergeConfig(viteConfig, defineConfig({
  test: {
    projects: [
      {
        extends: true,
        plugins: [storybookTest({ configDir: ".storybook" })],
        test: {
          name: "storybook",
          browser: { enabled: true, headless: true, provider: playwright(), instances: [{ browser: "chromium" }] },
          setupFiles: [".storybook/vitest.setup.ts"],
        },
      },
      // No `extends`: the guards read sources as text (`?raw`), which the Tailwind plugin would otherwise
      // compile; `css: true` keeps Vitest from blanking the token files on the way in.
      { test: { name: "guards", include: ["src/**/*.test.ts"], environment: "node", css: true } },
    ],
  },
}));
