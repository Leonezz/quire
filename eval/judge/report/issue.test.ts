import { describe, expect, it } from "vitest";
import { buildReportData } from "./data";
import { AT, corpus, emptyData, hybridData, issue, legacyData, legacyResult, v6Data, visualData } from "./fixtures";
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
    expect(body).toContain("| Invalid issues (discarded) | 0 |");
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
    expect(body).toContain("<details><summary><code>gamma-post</code> — missing_content!, code_or_math!</summary>\n\nSource: https://gamma.example/gamma-post\n\n- **missing_content** (content, major, quote not found verbatim) — missing_content is wrong\n  > `");
    expect(body).toContain("- **metadata** (metadata, major) — metadata is wrong\n  > `<script>alert(1)</script> & \"quotes\"`");
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
    expect(rendered.body).toContain("- **code_or_math** (content, major) — code_or_math is wrong\n  > `quote for code_or_math`");
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
    // An invalid issue is never the one a case is filed under.
    expect(topKind({ ...gamma, issues: [{ kind: "images", severity: "major", note: "", evidence: "", verified: true, invalid: { reason: "contradicts-image-facts", detail: "x" } }, { kind: "layout", severity: "minor", note: "", evidence: "", verified: true }] })).toBe("layout");
    expect(topKind({ ...gamma, issues: [] })).toBe("other");
  });

  it("orders MAJOR cases by their major-issue count, then slug", () => {
    expect(majorCases(data).map((row) => row.slug)).toEqual(["gamma-post", "delta-post"]);
  });
});

describe("visual cases in the issues", () => {
  const data = visualData();
  const alpha = data.cases.find((row) => row.slug === "alpha-post")!;

  it("a case issue lists the facts, each issue's tile and where the screenshots are, in text only", () => {
    const { body } = renderCaseIssue(alpha, { repo: REPO });
    expect(body).toContain("- **images** (content, major) — images is wrong — rendered tile 2");
    expect(body).toContain("- **images** (content, minor) — images is wrong — reference tile 1");
    expect(body).toContain("**Rendering facts** (measured in the reader page): 1 of 3 images broken, 1 element wider than the column, 2 raw-markup samples, 0 math errors; 1 code blocks, 0 tables, 3 figures, 1200 words.");
    expect(body).toContain("- broken images: `https://alpha.example/fig2.png`");
    expect(body).toContain("- overflow: `article > pre` (1500 px)");
    expect(body).toContain("- raw markup: `$$` in `where $$x^2$$ grows`");
    expect(body).toContain("- screenshots: eval/render/out/alpha-post/ (local) — the judge saw rendered tiles 1–3 of 3 and reference tile 1 of 2");
    expect(body).toContain("· visual mode · rubric 2026-10-08.4");
    expect(body).not.toMatch(/!\[|<img/);
  });

  it("the tracking issue totals the facts and folds them into each MAJOR case", () => {
    const { body } = renderReportIssue(data, { repo: REPO });
    expect(body).toContain("| Cases judged with screenshots | 2 |");
    expect(body).toContain("| Broken images (measured) | 1 in 1 case |");
    expect(body).toContain("| Math render errors (measured) | 1 in 1 case |");
    expect(body).toContain("<code>alpha-post</code>");
    expect(body).toContain("- screenshots: eval/render/out/alpha-post/ (local)");
    expect(renderReportIssue(legacyData(), { repo: REPO }).body).not.toContain("screenshots");
  });
});

describe("rubric v6 cases in the issues", () => {
  const data = v6Data();
  const alpha = data.cases.find((row) => row.slug === "alpha-post")!;

  it("a case issue states the layer verdicts and lists only the valid issues, counting the discarded ones", () => {
    const { body, title } = renderCaseIssue(alpha, { repo: REPO });
    expect(title).toBe("Rendering: alpha-post — images");
    expect(body).toContain("Verdict **MAJOR** (baseline MAJOR, regressed); kinds: images!, metadata.");
    expect(body).toContain("Layers: content PASS · metadata MINOR · rendering MAJOR.");
    expect(body).toContain("- **images** (rendering, major) — images is wrong — rendered tile 2 [r2] · both judges");
    expect(body).toContain("- **metadata** (metadata, minor) — metadata is wrong · one judge");
    expect(body).toContain("### Found by\n\nthe judge (merged, disputed)");
    expect(body).toContain("The backends disagreed on the verdict: claude said MAJOR, codex said MINOR; the final verdict comes from their cross-confirmed issues.");
    expect(body).not.toContain("(content, major)");
    expect(body).toContain("1 issue the program discarded as invalid is not listed. They are in `eval/judge/out/alpha-post.json` with their reasons.");
  });

  it("the tracking issue totals each layer and the invalid issues by reason, and shows layer moves against the baseline", () => {
    const { body } = renderReportIssue(data, { repo: REPO });
    expect(body).toContain("| content layer | 2 PASS · 0 MINOR · 0 MAJOR |");
    expect(body).toContain("| metadata layer | 1 PASS · 1 MINOR · 0 MAJOR |");
    expect(body).toContain("| rendering layer | 1 PASS · 0 MINOR · 1 MAJOR |");
    expect(body).toContain("| Issues | 2 (1 major) |");
    expect(body).toContain("| Invalid issues (discarded) | 2 (contradicts-image-facts 1, evidence-not-verbatim 1) |");
    expect(body).toContain("| Cross-confirmed issues | 1 both · 0 one-sided, fact-supported · 0 downgraded · 1 one-sided minor |");
    expect(body).toContain("- `alpha-post` MAJOR → MAJOR (metadata PASS → MINOR)");
    expect(body).toContain("Layers: content PASS · metadata MINOR · rendering MAJOR");
    expect(body).toContain("_1 issue the program discarded as invalid is not listed._");
    expect(body).not.toContain("o1 is in the reader");
  });
});
