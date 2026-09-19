import { describe, expect, it } from "vitest";
import { compareSemver, formatSemver, isPrerelease, parseSemver } from "./semver";

const v = (text: string) => {
  const parsed = parseSemver(text);
  if (!parsed) throw new Error(`not semver: ${text}`);
  return parsed;
};

describe("parseSemver", () => {
  it("accepts a leading v, a prerelease tail and build metadata", () => {
    expect(parseSemver("v0.1.0-alpha.2")).toEqual({ major: 0, minor: 1, patch: 0, prerelease: ["alpha", 2] });
    expect(parseSemver("1.2.3+build.7")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
    expect(parseSemver(" 2.0.0-rc.1+sha ")).toEqual({ major: 2, minor: 0, patch: 0, prerelease: ["rc", 1] });
  });

  it("refuses tags that are not versions", () => {
    for (const tag of ["latest", "1.2", "v1", "1.2.3-", "1.2.3-alpha..2", "preview", ""]) expect(parseSemver(tag), tag).toBeUndefined();
  });

  it("formats back without the v", () => {
    expect(formatSemver(v("v0.1.0-alpha.2"))).toBe("0.1.0-alpha.2");
    expect(formatSemver(v("1.2.3+build"))).toBe("1.2.3");
    expect(isPrerelease(v("1.0.0-beta"))).toBe(true);
    expect(isPrerelease(v("1.0.0"))).toBe(false);
  });
});

describe("compareSemver", () => {
  it("orders major, minor and patch numerically", () => {
    expect(compareSemver(v("1.0.0"), v("0.9.9"))).toBeGreaterThan(0);
    expect(compareSemver(v("0.10.0"), v("0.9.0"))).toBeGreaterThan(0);
    expect(compareSemver(v("0.1.10"), v("0.1.9"))).toBeGreaterThan(0);
    expect(compareSemver(v("1.2.3"), v("v1.2.3"))).toBe(0);
  });

  it("puts a prerelease before the same final version, and orders prerelease identifiers", () => {
    expect(compareSemver(v("0.1.0-alpha.1"), v("0.1.0"))).toBeLessThan(0);
    expect(compareSemver(v("0.1.0-alpha.2"), v("0.1.0-alpha.1"))).toBeGreaterThan(0);
    expect(compareSemver(v("0.1.0-alpha.10"), v("0.1.0-alpha.9"))).toBeGreaterThan(0);
    expect(compareSemver(v("0.1.0-beta.1"), v("0.1.0-alpha.9"))).toBeGreaterThan(0);
    expect(compareSemver(v("0.1.0-alpha"), v("0.1.0-alpha.1"))).toBeLessThan(0);
    expect(compareSemver(v("0.1.0-1"), v("0.1.0-alpha"))).toBeLessThan(0);
    expect(compareSemver(v("0.2.0-alpha.1"), v("0.1.0"))).toBeGreaterThan(0);
  });
});
