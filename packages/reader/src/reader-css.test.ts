import { describe, expect, it } from "vitest";

import css from "./reader.css?raw";

// jsdom does not paint ::marker, so the rule is read as text.
describe("reader.css", () => {
  it("draws list numbers and bullets in the secondary label tone, which stays readable (hillelwayne, regehr)", () => {
    expect(css).toMatch(/\.reader-body li::marker \{ color: var\(--label-2\); \}/u);
  });
});
