import { describe, expect, it } from "vitest";
import { buildReportData } from "./data";
import { AT, corpus, emptyData, hybridData, issue, legacyData, legacyResult } from "./fixtures";
import { BODY_LIMIT, majorCases, renderCaseIssue, renderReportIssue, topKind } from "./issue";

const REPO = "Leonezz/quire";

describe("renderReportIssue", () => {
  const data = legacyData();
  const { title, body } = renderReportIssue(data, { repo: REPO, runLabel: "nightly" });

  it("titles the issue with the date and the verdict counts", () => {
    expect(title).toBe("Extraction quality report — 2026-09-23 (2/1/2)");
    expect(body).toContain("(nightly)");
  });

  it("carries the summary table and both Mermaid charts", () => {
    expect(body).toContain("| Cases judged | 5 |");
    expect(body).toContain("| MAJOR | 2 (40%) |");
    expect(body).toContain("| Not judged (errors) | 1 |");
    expect(body).toContain("| Issues | 6 (3 major) |");
    expect(body).toContain('```mermaid\npie showData\n    title Verdicts\n    "PASS" : 2\n    "MINOR" : 1\n    "MAJOR" : 2\n    "error" : 1\n```');
    expect(body).toContain('```mermaid\nxychart-beta horizontal\n    title "Issues by kind (all, then major)"\n    x-axis ["missing_content", "code_or_math", "metadata", "images", "layout"]\n    y-axis "issues" 0 --> 2\n    bar [2, 1, 1, 1, 1]\n    bar [1, 1, 1, 0, 0]\n```');
    // Every quoted Mermaid label is free of colons and quotes.
    for (const label of body.matchAll(/^\s+"([^"]*)"/gm)) expect(label[1]).not.toMatch(/[:"]/);
  });

  it("lists regressions, improvements and errors against the baseline", () => {
    expect(body).toContain("**Regressed (2)**\n\n- `delta-post` MINOR → MAJOR\n- `gamma-post` PASS → MAJOR");
    expect(body).toContain("**Improved (1)**\n\n- `beta-post` MAJOR → MINOR");
    expect(body).toContain("**Not judged (1):** `zeta-post`");
    expect(body).not.toContain("### Backends");
  });

  it("folds every MAJOR case into details with its issues, evidence and source link", () => {
    expect(body).toContain("## Top cases (2 MAJOR)");
    expect(body).toContain("<details><summary><code>gamma-post</code> — missing_content!, code_or_math!</summary>\n\nSource: https://gamma.example/gamma-post\n\n- **missing_content** (major, quote not found verbatim) — missing_content is wrong\n  > `");
    expect(body).toContain("- **metadata** (major) — metadata is wrong\n  > `<script>alert(1)</script> & \"quotes\"`");
    expect(body).toContain("_delta-post reads badly._\n\n</details>");
    expect(body).not.toContain("<code>beta-post</code>");
    expect(body.indexOf("gamma-post</code>")).toBeLessThan(body.indexOf("delta-post</code>"));
  });

  it("ends with how to reproduce and the link to report.md on main", () => {
    expect(body).toContain("Reproduce: `pnpm --filter @read/eval judge`");
    expect(body).toContain(`https://github.com/${REPO}/blob/main/eval/judge/report.md`);
  });

  it("adds the agreement matrix and backend cost lines for hybrid data", () => {
    const hybrid = renderReportIssue(hybridData(), { repo: REPO });
    expect(hybrid.title).toBe("Extraction quality report — 2026-09-23 (3/0/2)");
    expect(hybrid.body).toContain("| Escalated to a second opinion | 3 |");
    expect(hybrid.body).toContain("### Backends\n\nScreen vs confirm on 3 escalated cases: 1 agree (33%), 2 disagree.");
    expect(hybrid.body).toContain("| MINOR | 1 | 0 | 1 |");
    expect(hybrid.body).toContain("- **claude** (claude-haiku-4-5): 4 opinions, decided 1, 2.0k tokens, $0.04, 3.2s wall");
    expect(hybrid.body).toContain("- **codex** (gpt-5.6-sol): 4 opinions, decided 4, 5.5k tokens, cost not reported, 11.0s wall");
  });

  it("renders an empty run without charts that Mermaid would reject", () => {
    const empty = renderReportIssue(emptyData(), { repo: REPO });
    expect(empty.title).toBe("Extraction quality report — 2026-09-23 (0/0/0)");
    expect(empty.body).not.toContain("pie showData");
    expect(empty.body).toContain("No issues reported.");
    expect(empty.body).toContain("No MAJOR cases.");
  });

  it("stays under GitHub's body limit by cutting the case list with a note", () => {
    const results = Array.from({ length: 400 }, (_, i) => legacyResult(`case-${String(i).padStart(3, "0")}`, "MAJOR", [issue("missing_content", "major", { evidence: "e".repeat(200), note: "n".repeat(150) }), issue("layout", "major", { evidence: "f".repeat(200) })]));
    const big = renderReportIssue(buildReportData({ results, baseline: {}, corpus, generatedAt: AT }), { repo: REPO });
    expect(big.body.length).toBeLessThan(BODY_LIMIT);
    expect(big.body).toMatch(/_\d+ more MAJOR cases omitted to stay under GitHub's body limit/);
    expect(big.body).toContain("<code>case-000</code>");
    expect(big.body).not.toContain("<code>case-399</code>");
  });
});

describe("renderCaseIssue", () => {
  const data = legacyData();
  const gamma = data.cases.find((row) => row.slug === "gamma-post")!;

  it("files one rendering issue in the template's shape", () => {
    const rendered = renderCaseIssue(gamma, { repo: REPO });
    expect(rendered.title).toBe("Rendering: gamma-post — missing_content");
    expect(rendered.labels).toEqual(["rendering", "judge"]);
    expect(rendered.body).toContain("### Case\n\n`gamma-post`");
    expect(rendered.body).toContain("### URL\n\nhttps://gamma.example/gamma-post");
    expect(rendered.body).toContain("### Found by\n\nthe judge (codex)");
    expect(rendered.body).toContain("### Done when\n\n- [ ] `pnpm --filter @read/eval judge gamma-post` gives PASS");
    expect(rendered.body).toContain("Verdict **MAJOR** (baseline PASS, regressed); kinds: missing_content!, code_or_math!.");
    expect(rendered.body).toContain("- **code_or_math** (major) — code_or_math is wrong\n  > `quote for code_or_math`");
    expect(rendered.body).toContain("### Details\n\ngamma-post reads badly.");
    expect(rendered.body).toContain("judge: codex gpt-5.6-sol · rubric 2026-09-23.3 · judged 2026-09-23T10:00:00.000Z");
    expect(rendered.body).toContain("Filed by the judge; reproduce with `pnpm --filter @read/eval judge gamma-post`.");
  });

  it("names the disagreement when the backends disputed the verdict", () => {
    const beta = hybridData().cases.find((row) => row.slug === "beta-post")!;
    const rendered = renderCaseIssue(beta, { repo: REPO });
    expect(rendered.body).toContain("The backends disagreed on the verdict: claude said MINOR, codex said MAJOR; the final follows codex.");
  });

  it("picks the first major kind, else the first kind, else other", () => {
    expect(topKind(gamma)).toBe("missing_content");
    expect(topKind({ ...gamma, issues: [{ kind: "layout", severity: "minor", note: "", evidence: "", verified: true }] })).toBe("layout");
    expect(topKind({ ...gamma, issues: [] })).toBe("other");
  });

  it("orders MAJOR cases by their major-issue count, then slug", () => {
    expect(majorCases(data).map((row) => row.slug)).toEqual(["gamma-post", "delta-post"]);
  });
});
