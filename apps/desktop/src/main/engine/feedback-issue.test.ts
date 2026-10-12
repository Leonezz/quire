import { describe, expect, it } from "vitest";
import type { RenderingFeedback } from "../../shared/contracts";
import { MAX_ISSUE_URL_LENGTH, attachmentsTextFor, issueTitleFor, issueUrlFor, reportLineOf, versionsTextFor } from "./feedback-issue";

const repo = { owner: "Leonezz", repo: "quire" };
const feedback: RenderingFeedback = {
  id: "0123456789abcdef", createdAt: "2026-09-23T12:00:00.000Z", materialId: "fedcba9876543210",
  url: "https://www.acoup.blog/2019/05/10/collections-the-siege-of-gondor/", title: "Collections: The Siege of Gondor, Part I: Professionals Talk Logistics",
  view: "web", kinds: ["missing_content", "tables"], note: "The logistics table near the end is gone.",
  app: { version: "0.1.0-alpha.3", platform: "darwin", normalize: "0.0.1" },
  quality: { completeness: "ambiguous", conformance: "recoverable", identityConfidence: "medium", safety: "safe", warnings: [] },
  problems: [{ code: "MAIN_CANDIDATE_AMBIGUOUS", recoverBy: "none", scope: "candidate", severity: "warning" }, { code: "TABLE_DROPPED", recoverBy: "none", scope: "representation", severity: "warning" }],
  capture: { included: true, byteLength: 245313, mediaType: "text/html; charset=UTF-8" },
  bundleDir: "/Users/reader/Library/Application Support/quire/feedback/0123456789abcdef",
};

function fieldsOf(url: string): { base: string; params: URLSearchParams } {
  const parsed = new URL(url);
  return { base: `${parsed.origin}${parsed.pathname}`, params: parsed.searchParams };
}

describe("issueTitleFor", () => {
  it("names the host without www and truncates the title to sixty characters", () => {
    expect(issueTitleFor(feedback)).toBe("Rendering: acoup.blog — Collections: The Siege of Gondor, Part I: Professionals Tal…");
    expect(issueTitleFor({ url: "https://example.test/x", title: "Short" })).toBe("Rendering: example.test — Short");
    expect(issueTitleFor({ url: "quire://artifact/abc", title: "  Many   spaces  " })).toBe("Rendering: artifact — Many spaces");
    expect(issueTitleFor({ url: "nope", title: "T" })).toBe("Rendering: unknown site — T");
  });
});

describe("versionsTextFor", () => {
  it("lists app, platform, normalize, view, quality, problem codes and the capture", () => {
    expect(versionsTextFor(feedback)).toBe([
      "Quire 0.1.0-alpha.3 (darwin)", "normalize 0.0.1", "view: web",
      "quality: completeness=ambiguous, conformance=recoverable, safety=safe",
      "problems: MAIN_CANDIDATE_AMBIGUOUS, TABLE_DROPPED",
      "capture: included in the bundle (245313 bytes, text/html; charset=UTF-8)",
    ].join("\n"));
  });

  it("adds the text view's report on one line and says when there are no problems", () => {
    const text = versionsTextFor({ ...feedback, view: "text", problems: [], capture: { included: false }, report: { pages: 12, columns: 2, furnitureLines: 24, headings: 9, paragraphs: 80, figures: 5, degradedPages: [3, 7], judged: { provider: "jev", asked: 40, changed: 6 } } });
    expect(text).toContain("problems: none");
    expect(text).toContain("text view: 12 pages, 2 columns, 24 furniture lines, 9 headings, 80 paragraphs, 5 figures, degraded pages 3, 7, judged by jev: 6/40 changed");
    expect(text).toContain("capture: not included");
    expect(reportLineOf({ pages: 1, columns: 1, furnitureLines: 0, headings: 0, paragraphs: 1, figures: 0, degradedPages: [] })).toBe("1 pages, 1 columns, 0 furniture lines, 0 headings, 1 paragraphs, 0 figures");
  });
});

describe("issueUrlFor", () => {
  it("targets the template on the given repository with url, note (kinds first) and versions", () => {
    const { base, params } = fieldsOf(issueUrlFor(feedback, repo));
    expect(base).toBe("https://github.com/Leonezz/quire/issues/new");
    expect(params.get("template")).toBe("rendering.yml");
    expect(params.get("title")).toBe(issueTitleFor(feedback));
    expect(params.get("url")).toBe(feedback.url);
    expect(params.get("note")).toBe("- Body text, sections or the ending are missing\n- Tables mangled or dropped\n\nThe logistics table near the end is gone.");
    expect(params.get("versions")).toBe(versionsTextFor(feedback));
    expect([...params.keys()].sort()).toEqual(["note", "template", "title", "url", "versions"]);
  });

  it("lists only the kinds when the note is blank", () => {
    const { params } = fieldsOf(issueUrlFor({ ...feedback, kinds: ["other"], note: "  " }, repo));
    expect(params.get("note")).toBe("- Other");
  });

  it("never carries the bundle path, the capture or extracted text", () => {
    const url = issueUrlFor(feedback, repo);
    expect(url).not.toContain(encodeURIComponent("Application Support"));
    expect(url).not.toContain("feedback%2F0123456789abcdef");
    expect(url).not.toContain("bundleDir");
  });

  it("truncates the note so the URL stays under the limit, keeping the kinds", () => {
    const long = { ...feedback, note: "A very long paragraph of detail. ".repeat(400) };
    const url = issueUrlFor(long, repo);
    expect(url.length).toBeLessThanOrEqual(MAX_ISSUE_URL_LENGTH);
    const note = fieldsOf(url).params.get("note")!;
    expect(note.startsWith("- Body text, sections or the ending are missing\n- Tables mangled or dropped\n\nA very long paragraph")).toBe(true);
    expect(note.endsWith("…")).toBe(true);
    expect(fieldsOf(url).params.get("versions")).toBe(versionsTextFor(long));
  });

  it("copes with a note of multibyte characters, which encode long", () => {
    const url = issueUrlFor({ ...feedback, note: "最后一节不见了。".repeat(600) }, repo);
    expect(url.length).toBeLessThanOrEqual(MAX_ISSUE_URL_LENGTH);
    expect(fieldsOf(url).params.get("note")).toContain("最后一节不见了。");
  });
});

describe("the attachments paragraph of a one-step report", () => {
  const pack = {
    zipPath: "/Users/reader/Library/Application Support/Quire/feedback/0123456789abcdef/quire-report-acoup-blog-x-0123456789abcdef.zip", zipBytes: 1_234_567,
    screenshots: ["screenshots/reader-viewport.png"], composite: "screenshots/composite.png", issueOpened: false, revealed: false, copiedToClipboard: true, warnings: [],
  };
  const submitted: RenderingFeedback = { ...feedback, package: pack };

  it("ends the note: paste the screenshot, then drag in the zip by name (never its path)", () => {
    const note = fieldsOf(issueUrlFor(submitted, repo)).params.get("note")!;
    expect(note).toBe([
      "- Body text, sections or the ending are missing\n- Tables mangled or dropped",
      "The logistics table near the end is gone.",
      "**Attachments**\nThe screenshot is on your clipboard: press ⌘V here. Then drag quire-report-acoup-blog-x-0123456789abcdef.zip (shown in Finder) into this box.",
    ].join("\n\n"));
    expect(issueUrlFor(submitted, repo)).not.toContain(encodeURIComponent("Application Support"));
  });

  it("only asks for the zip when the screenshot is not on the clipboard, and speaks the platform's keys", () => {
    expect(attachmentsTextFor({ ...submitted, package: { ...pack, copiedToClipboard: false } })).toBe("**Attachments**\nDrag quire-report-acoup-blog-x-0123456789abcdef.zip (shown in Finder) into this box.");
    expect(attachmentsTextFor({ ...submitted, app: { ...submitted.app, platform: "win32" } })).toContain("press Ctrl+V here. Then drag quire-report-acoup-blog-x-0123456789abcdef.zip (shown in your file manager)");
    expect(attachmentsTextFor(feedback)).toBeUndefined();
  });

  it("works without kinds or a note", () => {
    const note = fieldsOf(issueUrlFor({ ...submitted, kinds: [], note: "" }, repo)).params.get("note");
    expect(note).toBe(attachmentsTextFor(submitted));
  });

  it("is kept whole when a long note is cut to fit the URL", () => {
    const url = issueUrlFor({ ...submitted, note: "Detail. ".repeat(2_000) }, repo);
    expect(url.length).toBeLessThanOrEqual(MAX_ISSUE_URL_LENGTH);
    const note = fieldsOf(url).params.get("note")!;
    expect(note.endsWith(attachmentsTextFor(submitted)!)).toBe(true);
    expect(note).toContain("…\n\n**Attachments**");
  });
});
