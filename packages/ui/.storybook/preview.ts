import type { Preview } from "@storybook/react-vite";
import "../src/styles.css";

const preview: Preview = {
  parameters: {
    layout: "padded",
    a11y: { test: "error" },
    backgrounds: { disable: true },
  },
};
export default preview;
