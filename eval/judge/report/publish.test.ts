// The publisher's decisions (create vs update, dedupe, cap, dry-run) with an injected gh runner; no gh here.
import { describe, expect, it } from "vitest";
import { TRACKING_LABEL, deltaSummary, gh, parseArgs, publish, publishCaseIssues, publishTrackingIssue, repoFromRemote } from "../publish.mjs";
import { hybridData, legacyData } from "./fixtures";

const REPO = "Leonezz/quire";
type Call = string[];
type Reply = { stdout?: string; stderr?: string; status?: number };

/** A gh that answers by the first words of the command and records every call. */
function fakeGh(replies: Record<string, Reply | ((args: string[]) => Reply)>) {
  const calls: Call[] = [];
  const run = (args: string[]) => {
    calls.push(args);
    const key = [args.slice(0, 2).join(" "), args[0]].find((candidate) => candidate !== undefined && candidate in replies);
    const reply = key ? replies[key]! : undefined;
    const resolved = typeof reply === "function" ? reply(args) : reply ?? { stdout: "[]" };
    return { stdout: resolved.stdout ?? "", stderr: resolved.stderr ?? "", status: resolved.status ?? 0 };
  };
  return { run, calls };
}
const logger = () => { const lines: string[] = []; return { lines, log: (line: string) => { lines.push(line); } }; };
const trackingTitle = "Extraction quality report — 2026-09-01 (1/1/1)";

describe("parseArgs", () => {
  it("reads the flags and their defaults", () => {
    expect(parseArgs(["--html", "--issue", "--cases", "--dry-run"])).toEqual({ html: true, issue: true, cases: true, dryRun: true, maxCases: 5 });
    expect(parseArgs(["--cases", "--max-cases", "2", "--repo", "a/b", "--run-label", "nightly"])).toEqual({ html: false, issue: false, cases: true, dryRun: false, maxCases: 2, repo: "a/b", runLabel: "nightly" });
  });

  it("refuses unknown options, missing values and doing nothing", () => {
    expect(() => parseArgs(["--html", "--bogus"])).toThrow(/Unknown option --bogus/);
    expect(() => parseArgs(["--cases", "--max-cases"])).toThrow(/--max-cases needs a value/);
    expect(() => parseArgs(["--cases", "--max-cases", "many"])).toThrow(/non-negative integer/);
    expect(() => parseArgs(["--dry-run"])).toThrow(/Nothing to do/);
    expect(() => parseArgs(["--html", "extra"])).toThrow(/Unexpected argument extra/);
  });
});

describe("repoFromRemote", () => {
  it("reads owner/name from https and ssh remotes", () => {
    expect(repoFromRemote("https://github.com/Leonezz/quire.git\n")).toBe(REPO);
    expect(repoFromRemote("git@github.com:Leonezz/quire.git")).toBe(REPO);
    expect(repoFromRemote("https://github.com/Leonezz/quire")).toBe(REPO);
    expect(() => repoFromRemote("https://gitlab.com/x/y.git")).toThrow(/pass --repo/);
  });
});

describe("gh", () => {
  it("returns stdout on success and throws with stderr on failure", () => {
    expect(gh(() => ({ stdout: "ok\n", stderr: "", status: 0 }), ["issue", "list"])).toBe("ok\n");
    expect(() => gh(() => ({ stdout: "", stderr: "HTTP 401: Bad credentials", status: 1 }), ["issue", "create", "--repo", REPO])).toThrow(/gh issue create --repo failed \(exit 1\): HTTP 401: Bad credentials/);
    expect(() => gh(() => ({ stdout: "", stderr: "", status: null, error: new Error("spawn gh ENOENT") }), ["auth"])).toThrow(/spawn gh ENOENT/);
  });
});

describe("publishTrackingIssue", () => {
  it("creates the label and the issue when neither exists", () => {
    const { run, calls } = fakeGh({ "label list": { stdout: "[]" }, "issue list": { stdout: "[]" }, "issue create": { stdout: "https://github.com/Leonezz/quire/issues/12\n" } });
    const { log, lines } = logger();
    const result = publishTrackingIssue({ data: legacyData(), repo: REPO, run, dryRun: false, log });
    expect(result).toEqual({ action: "created", url: "https://github.com/Leonezz/quire/issues/12" });
    expect(calls.map((call) => call.slice(0, 2).join(" "))).toEqual(["label list", "label create", "issue list", "issue create"]);
    expect(calls[1]).toEqual(["label", "create", TRACKING_LABEL, "--repo", REPO, "--color", "0E8A16", "--description", "Automated extraction quality report from the judge"]);
    expect(calls[3]!.slice(0, 6)).toEqual(["issue", "create", "--repo", REPO, "--title", "Extraction quality report — 2026-09-23 (2/1/2)"]);
    expect(calls[3]).toContain("--body-file");
    expect(calls[3]!.slice(-2)).toEqual(["--label", TRACKING_LABEL]);
    expect(lines).toEqual(["Created label quality-report.", "Created https://github.com/Leonezz/quire/issues/12: Extraction quality report — 2026-09-23 (2/1/2)"]);
  });

  it("edits the open tracking issue in place and comments the delta", () => {
    const { run, calls } = fakeGh({ "label list": { stdout: JSON.stringify([{ name: TRACKING_LABEL }]) }, "issue list": { stdout: JSON.stringify([{ number: 3, title: "Rendering: something" }, { number: 7, title: trackingTitle }]) }, "issue edit": {}, "issue comment": {} });
    const { log, lines } = logger();
    const result = publishTrackingIssue({ data: legacyData(), repo: REPO, run, dryRun: false, log });
    expect(result).toEqual({ action: "updated", number: 7 });
    expect(calls.map((call) => call.slice(0, 2).join(" "))).toEqual(["label list", "issue list", "issue edit", "issue comment"]);
    expect(calls[2]!.slice(0, 6)).toEqual(["issue", "edit", "7", "--repo", REPO, "--title"]);
    expect(calls[3]).toEqual(["issue", "comment", "7", "--repo", REPO, "--body", "Updated 2026-09-23: 2 PASS / 1 MINOR / 2 MAJOR / 1 errors; 2 regressed (delta-post, gamma-post), 1 improved (beta-post) vs baseline."]);
    expect(lines).toEqual(["Updated issue #7: Extraction quality report — 2026-09-23 (2/1/2)"]);
  });

  it("prints the title and body and calls nothing on a dry run", () => {
    const { run, calls } = fakeGh({});
    const { log, lines } = logger();
    expect(publishTrackingIssue({ data: legacyData(), repo: REPO, run, dryRun: true, log })).toEqual({ action: "dry-run" });
    expect(calls).toEqual([]);
    expect(lines[0]).toMatch(/^\[dry-run\] tracking issue \(\d+ chars, label quality-report\)$/);
    expect(lines[1]).toBe("Title: Extraction quality report — 2026-09-23 (2/1/2)");
    expect(lines.join("\n")).toContain("## Top cases (2 MAJOR)");
  });

  it("stops loudly when gh fails", () => {
    const { run } = fakeGh({ "label list": { stdout: "", stderr: "gh: not logged in", status: 4 } });
    expect(() => publishTrackingIssue({ data: legacyData(), repo: REPO, run, dryRun: false, log: () => {} })).toThrow(/gh label list --repo failed \(exit 4\): gh: not logged in/);
  });
});

describe("publishCaseIssues", () => {
  it("files MAJOR cases, skips slugs already named by an open issue and caps at max-cases", () => {
    const { run, calls } = fakeGh({
      "label list": { stdout: JSON.stringify([{ name: "judge" }]) },
      "issue list": (args) => ({ stdout: args.includes("gamma-post in:title") ? JSON.stringify([{ title: "Rendering: gamma-post — tables" }]) : "[]" }),
      "issue create": { stdout: "https://github.com/Leonezz/quire/issues/20\n" },
    });
    const { log, lines } = logger();
    const outcome = publishCaseIssues({ data: legacyData(), repo: REPO, run, dryRun: false, maxCases: 5, log });
    expect(outcome).toEqual({ filed: ["delta-post"], skipped: ["gamma-post"], left: [] });
    const created = calls.filter((call) => call[1] === "create");
    expect(created).toHaveLength(1);
    expect(created[0]!.slice(0, 6)).toEqual(["issue", "create", "--repo", REPO, "--title", "Rendering: delta-post — metadata"]);
    expect(created[0]!.slice(-4)).toEqual(["--label", "rendering", "--label", "judge"]);
    expect(lines).toEqual(["Skipped gamma-post: an open issue already names it.", "Filed https://github.com/Leonezz/quire/issues/20: Rendering: delta-post — metadata", "Filed 1 of 2 MAJOR cases, skipped 1 already open."]);
  });

  it("leaves the rest when the cap is reached and says so", () => {
    const { run, calls } = fakeGh({ "label list": { stdout: JSON.stringify([{ name: "judge" }]) }, "issue create": { stdout: "https://github.com/Leonezz/quire/issues/21\n" } });
    const { log, lines } = logger();
    const outcome = publishCaseIssues({ data: legacyData(), repo: REPO, run, dryRun: false, maxCases: 1, log });
    expect(outcome).toEqual({ filed: ["gamma-post"], skipped: [], left: ["delta-post"] });
    expect(calls.filter((call) => call[1] === "create")).toHaveLength(1);
    expect(lines.at(-1)).toBe("Filed 1 of 2 MAJOR cases, 1 left (raise --max-cases).");
  });

  it("prints every case body and calls nothing on a dry run", () => {
    const { run, calls } = fakeGh({});
    const { log, lines } = logger();
    const outcome = publishCaseIssues({ data: hybridData(), repo: REPO, run, dryRun: true, maxCases: 5, log });
    expect(calls).toEqual([]);
    expect(outcome.filed).toEqual(["beta-post", "gamma-post"]);
    expect(lines.filter((line) => line.startsWith("Title: "))).toEqual(["Title: Rendering: beta-post — missing_content", "Title: Rendering: gamma-post — tables"]);
    expect(lines.at(-1)).toBe("Would file 2 of 2 MAJOR cases.");
  });
});

describe("publish", () => {
  it("writes the html, then the issue, then the cases as the flags ask", () => {
    const { run, calls } = fakeGh({});
    const written: { path: string; size: number }[] = [];
    const { log, lines } = logger();
    const flags = parseArgs(["--html", "--issue", "--cases", "--dry-run"]);
    const result = publish({ flags, data: hybridData(), repo: REPO, run, log, htmlPath: "/tmp/report.html", writeFile: (path: string, text: string) => { written.push({ path, size: text.length }); } });
    expect(written).toEqual([{ path: "/tmp/report.html", size: expect.any(Number) }]);
    expect(lines[0]).toBe("Wrote /tmp/report.html (5 cases, 0 errors).");
    expect(result.tracking).toEqual({ action: "dry-run" });
    expect(result.cases?.filed).toEqual(["beta-post", "gamma-post"]);
    expect(calls).toEqual([]);
  });

  it("summarizes the delta for the update comment", () => {
    expect(deltaSummary(hybridData())).toBe("3 PASS / 0 MINOR / 2 MAJOR; 1 regressed (gamma-post), 1 improved (delta-post) vs baseline.");
  });
});
