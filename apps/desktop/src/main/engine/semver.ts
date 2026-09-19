// A small semver: major.minor.patch with a prerelease tail, enough to order GitHub release tags.
// Build metadata (+sha) is accepted and ignored, as the specification says.

export interface SemVer {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** Dot-separated prerelease identifiers; empty for a final release. Numeric identifiers are numbers. */
  readonly prerelease: readonly (number | string)[];
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Parses "1.2.3", "v1.2.3-alpha.2" or "1.2.3+build"; undefined for anything else (a tag that is not a version). */
export function parseSemver(text: string): SemVer | undefined {
  const match = SEMVER.exec(text.trim());
  if (!match) return undefined;
  const [, major, minor, patch, tail] = match;
  if (major === undefined || minor === undefined || patch === undefined) return undefined;
  const prerelease = tail === undefined ? [] : tail.split(".").map((id) => (/^\d+$/.test(id) ? Number(id) : id));
  if (prerelease.some((id) => id === "")) return undefined;
  return { major: Number(major), minor: Number(minor), patch: Number(patch), prerelease };
}

export function isPrerelease(version: SemVer): boolean {
  return version.prerelease.length > 0;
}

function compareIdentifier(a: number | string, b: number | string): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  // A numeric identifier is always lower than an alphanumeric one.
  if (typeof a === "number") return -1;
  if (typeof b === "number") return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function comparePrerelease(a: readonly (number | string)[], b: readonly (number | string)[]): number {
  // A version without a prerelease tail is newer than the same version with one.
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const shared = Math.min(a.length, b.length);
  for (let index = 0; index < shared; index += 1) {
    const left = a[index];
    const right = b[index];
    if (left === undefined || right === undefined) break;
    const order = compareIdentifier(left, right);
    if (order !== 0) return order;
  }
  // The longer prerelease list is newer when every shared identifier is equal.
  return a.length - b.length;
}

/** Negative when a is older than b, positive when newer, 0 when equal. */
export function compareSemver(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  return comparePrerelease(a.prerelease, b.prerelease);
}

export function formatSemver(version: SemVer): string {
  const base = `${version.major}.${version.minor}.${version.patch}`;
  return version.prerelease.length === 0 ? base : `${base}-${version.prerelease.join(".")}`;
}
