// --rescore (docs/design/eval-rubric.md §7): a stored result scored again from its opinions under the
// current program rules, with no model call. Rescoring is idempotent, undoes the program's
// normalization before applying it again, follows changed facts, and refuses what it cannot score.
import { describe, expect, it } from "vitest";
import type { ReferenceImage } from "../render/types";
import type { JudgeBackend } from "./backends/types";
import { isJudged, type JudgedCase } from "./cache";
import { judgeCase, type EffectivePolicy } from "./policy";
import { inputsChanged, rawIssueOf, rescoreBlocker, rescoreCase } from "./rescore";
import type { PromptInput } from "./rubric";
import { SCORING_VERSION } from "./verdict";
import type { VisualInput } from "./visual";

const EXTRACTED = "# Title\n\nBy Ada\n\nThe loss curve below shows training.\n\nBody text.";
const originals = (contextOfO2: string): ReferenceImage[] => [
  { id: "o1", tile: 1, src: "https://x.test/a.png", candidates: [], alt: "", width: 640, height: 420, matchedBy: "r1", context: "Body text." },
  { id: "o2", tile: 2, src: "https://x.test/c.png", candidates: [], alt: "Loss curve", width: 800, height: 500, matchedBy: null, context: contextOfO2 },
];
const visual = (contextOfO2 = "The loss curve below shows training."): VisualInput => ({
  manifestKey: "mk", renderedTiles: ["/cap/rendered-01.png", "/cap/rendered-02.png"], referenceTiles: ["/cap/reference-01.png"],
  metrics: { images: { total: 1, broken: 0, brokenSrc: [] }, overflow: { count: 0, samples: [] }, rawMarkup: { count: 0, samples: [] }, mathErrors: 0, unmarkedLists: 0, collapsedCode: 0, emptyCellTables: { count: 0, samples: [] }, emptyHeadings: 0, duplicateTitleHeadings: 0, counts: { codeBlocks: 0, tables: 0, figures: 1, lists: 0, footnotes: 0, headings: 1, words: 10 }, height: 3000 },
  warnings: [], truncated: { rendered: false, reference: false }, failedReferenceRequests: 0, renderedText: "Title\nBody text.", renderedTextTruncated: false, viewport: { width: 1280, height: 1600 },
  images: { rendered: [{ id: "r1", tile: 1, src: "https://x.test/a.png", alt: "", caption: "", broken: false }], reference: originals(contextOfO2) }, embeds: [], tables: [], code: [],
});
const input = (contextOfO2?: string): PromptInput => ({ slug: "s", url: "https://x.test/p", source: "# Title\n\nBy Ada\n\nThe loss curve below shows training.\n\nBody text.", extracted: EXTRACTED, truncated: { source: false, extracted: false }, visual: visual(contextOfO2) });
const SCREEN: EffectivePolicy = { policy: "screen-then-confirm", screen: { backend: "claude", model: "s" }, confirm: { backend: "codex", model: "c" }, escalateOn: ["MINOR", "MAJOR"] };

const missingFigure = { layer: "rendering", kind: "images", severity: "major", subject: null, evidence: "The loss curve below shows training.", note: "the loss curve is missing", where: null, refs: ["o2"] };
const author = { layer: "content", kind: "missing_content", severity: "major", subject: "author", evidence: "By Ada", note: "the byline is gone", where: null, refs: [] };
const fake = (id: "claude" | "codex", issues: unknown[]): JudgeBackend => ({ id, model: id === "claude" ? "s" : "c", preflight: async () => {}, run: async () => ({ raw: JSON.stringify({ issues, summary: `${id} summary` }), tokens: 10 }) });

async function judged(): Promise<JudgedCase> {
  const result = await judgeCase(input(), { policy: SCREEN, backend: (spec) => (spec.backend === "claude" ? fake("claude", [missingFigure, author]) : fake("codex", [missingFigure])), timeoutMs: 1000, maxImages: 10, now: () => new Date("2026-10-10T00:00:00Z") });
  if (!isJudged(result)) throw new Error(result.error);
  return result;
}
const at = (iso: string) => () => new Date(iso);

describe("rescoreCase", () => {
  it("is idempotent: rescoring an unchanged case gives the same verdicts and issues, a new scoredAt and the same key", async () => {
    const original = await judged();
    expect(original).toMatchObject({ scoringVersion: SCORING_VERSION, scoredAt: "2026-10-10T00:00:00.000Z", verdict: "MAJOR" });
    const once = rescoreCase(original, input(), 10, at("2026-10-11T00:00:00Z"));
    expect({ ...once, scoredAt: original.scoredAt }).toEqual(original);
    expect(once.scoredAt).toBe("2026-10-11T00:00:00.000Z");
    expect(once.key).toBe(original.key);
    expect(once.judgedAt).toBe(original.judgedAt);
    const twice = rescoreCase(once, input(), 10, at("2026-10-12T00:00:00Z"));
    expect({ ...twice, scoredAt: once.scoredAt }).toEqual(once);
  });

  it("undoes the program's normalization before scoring again (the model's layer and severity)", async () => {
    const original = await judged();
    const authorIssue = original.opinions![0]!.issues.find((issue) => issue.subject === "author")!;
    expect(authorIssue).toMatchObject({ layer: "metadata", severity: "minor", originalLayer: "content", originalSeverity: "major" });
    expect(rawIssueOf(authorIssue)).toEqual({ layer: "content", kind: "missing_content", severity: "major", subject: "author", evidence: "By Ada", note: "the byline is gone", where: null, refs: [] });
    const figure = original.opinions![1]!.issues[0]!;
    expect(figure).toMatchObject({ layer: "content", originalLayer: "rendering" });
    expect(rawIssueOf(figure).layer).toBe("rendering");
  });

  it("follows the current facts: an original image now known to be page chrome stops counting", async () => {
    const original = await judged();
    const rescored = rescoreCase(original, input("More posts from this blog"), 10);
    expect(rescored.opinions!.every((opinion) => opinion.issues.find((issue) => issue.refs?.includes("o2"))?.invalid?.reason === "outside-boundary")).toBe(true);
    expect(rescored.issues.filter((issue) => !issue.invalid).map((issue) => issue.subject)).toEqual(["author"]);
    expect(rescored).toMatchObject({ verdict: "MINOR", layers: { content: "PASS", metadata: "MINOR", rendering: "PASS" }, resolution: { from: "merged" } });
  });

  it("accepts a re-capture (new capture key, same tiles) and moves the key to it; refuses new texts, a new policy or other tiles", async () => {
    const original = await judged();
    expect(inputsChanged(original, input(), SCREEN, 10)).toBeUndefined();
    const recaptured: PromptInput = { ...input(), visual: { ...visual(), manifestKey: "mk-2" } };
    expect(inputsChanged(original, recaptured, SCREEN, 10)).toBeUndefined();
    const rescored = rescoreCase(original, recaptured, 10, at("2026-10-11T00:00:00Z"), SCREEN);
    expect(rescored.key).not.toBe(original.key);
    expect(rescored.render?.manifestKey).toBe("mk-2");
    // The rescored result now passes the same check against the new capture: it is "judged on" it.
    expect(inputsChanged(rescored, recaptured, SCREEN, 10)).toBeUndefined();
    expect(inputsChanged(original, { ...input(), extracted: `${EXTRACTED}\n\nMore.` }, SCREEN, 10)).toMatch(/texts, policy or the tiles sent changed/);
    expect(inputsChanged(original, input(), { ...SCREEN, confirm: { backend: "codex", model: "other" } }, 10)).toMatch(/changed/);
    expect(inputsChanged(original, { ...input(), visual: { ...visual(), renderedTiles: ["/cap/rendered-01.png"] } }, SCREEN, 10)).toMatch(/changed/);
  });

  it("refuses results it cannot score, saying why", async () => {
    const original = await judged();
    expect(rescoreBlocker(original)).toBeUndefined();
    expect(rescoreBlocker({ ...original, opinions: undefined })).toMatch(/no stored opinions/);
    expect(rescoreBlocker({ ...original, opinions: original.opinions!.map(({ layers: _layers, ...opinion }) => opinion) })).toMatch(/before rubric v6/);
    expect(() => rescoreCase({ ...original, opinions: [] }, input(), 10)).toThrow(/cannot rescore s: it has no stored opinions/);
  });
});
