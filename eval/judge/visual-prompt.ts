// The visual rubric's prompt (RUBRIC_VERSION): the English version of the evaluation standard v6,
// docs/design/eval-rubric.md (§1 sources of truth, §2 the article boundary, §3 the three layers, §4
// severity), then the attached tiles, the capture's measured facts and inventories, and the texts.
// The two must agree: change one, change the other, and bump RUBRIC_VERSION. The model only lists
// issues; verdict.ts validates them and computes the verdicts (§5).
import type { Embed, ReferenceImage, RenderedCode, RenderedImage, RenderedTable } from "../render/types";
import { EVIDENCE_MAX_CHARS, EXTRACTED_LINE, KIND_LINES, SOURCE_LINE, truncationNoteOf, type PromptInput } from "./rubric";
import { embedId, hasEmptyCells, LARGE_IMAGE_PX } from "./verdict";
import type { ImagePlan, SideCount, VisualInput } from "./visual";

const range = (count: number) => (count === 1 ? "1" : `1–${count}`);
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const clipText = (text: string, max: number) => { const flat = text.replace(/\s+/g, " ").trim(); return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`; };
const listOf = (items: readonly string[], max = 6) => `${items.slice(0, max).join("; ")}${items.length > max ? `; and ${items.length - max} more` : ""}`;
/** Inventory lines per list; a page with more lists the first ones and says how many it left out (validation still knows them all). */
export const INVENTORY_MAX = 100;

export const SOURCES_OF_TRUTH = [
  "1. SOURCES OF TRUTH",
  "- Content: the original page snapshot — SOURCE, and the REFERENCE tiles — is the page the extractor saw. Content the snapshot itself does not have is outside this evaluation.",
  "- Display: the reader's actual rendering — the RENDERED tiles (default reading settings, light theme, 1280 px wide).",
  "- Measured facts: the FACTS below (broken images, overflow, raw markup, math errors, unmarked lists, tables with empty cells, the image inventories, the embed inventory) were measured by a program and are ground truth. An issue that contradicts a fact does not count.",
];

export const ARTICLE_BOUNDARY = [
  "2. THE ARTICLE BOUNDARY",
  "| Must keep (missing it is an issue) | Must drop (keeping it is a minor issue; dropping it is never an issue) |",
  "|---|---|",
  "| Body paragraphs and headings, lists, quotes | Navigation, breadcrumbs, table-of-contents sidebars |",
  "| Code blocks, formulas, tables | Related posts, recommended reading, \"More from …\" |",
  "| Images and their captions | Comment sections, \"Discuss on HN\" and other off-site link blocks |",
  "| Footnotes | Share, subscribe, newsletter, ads |",
  "| Callouts, notes, admonitions, key points | Author bio cards, avatar cards |",
  "| Body content that needs JavaScript to show — interactive examples, embedded videos or tweets, dynamic charts: the reader must show the thing itself, or at least a link to it or a placeholder for it | Copyright, licence and trademark footers |",
  "| | \"Cite this article\" / BibTeX blocks a site template adds to every post |",
  "| | Embeds of subscribe, comment, like and share services (newsletter forms, Disqus, like widgets) |",
];

export const THREE_LAYERS = [
  "3. THREE LAYERS, EACH WITH ITS OWN VERDICT",
  "| Layer | What it checks |",
  "|---|---|",
  "| content (the extractor) | The body starts at the first real paragraph of the article and ends where the article ends; everything inside the boundary is there, in order, not duplicated; nothing outside the boundary got in |",
  "| metadata (the extractor) | Title, author, publication date |",
  "| rendering (the reader) | Every element displays correctly in the reader: no raw markup, broken images, content wider than the column, unrendered formulas, mangled tables, code collapsed onto one line, lost list markers; the images, tables, code and formulas of the original are all in the reader and readable |",
  "The overall verdict is the worst of the three. Title, author and date are metadata (a missing or wrong byline or date is a metadata issue, never missing content).",
  "Content or rendering — look at whether EXTRACTED has the element:",
  "- Absent from EXTRACTED or incomplete there → content (the extractor must be fixed). Examples: a missing figure; a missing callout; ✓/✗ icons that were not extracted, so the table cells are empty; an embed left without even a link.",
  "- Intact in EXTRACTED but shown wrong by the reader → rendering (the reader must be fixed). Examples: an image that fails to load; a formula that is not typeset; code whose line breaks are in EXTRACTED but lost on display; a list shown without markers; content wider than the column.",
  "The program also sets the layer from the facts: an issue citing an original image that is not in the reader, or an embed the reader does not show, is content; one citing a broken reader image is rendering.",
];

export const SEVERITY_RULES = [
  "4. SEVERITY: BY WHAT THE READER LOSES",
  "major — information is lost, or an element cannot be read:",
  "- a body paragraph, section, callout, image, table, footnote, code block or formula is missing",
  "- body content that needs JavaScript (an interactive example, an embed, a dynamic chart) is entirely gone from the reader, with not even a link or a placeholder",
  "- a code block collapsed onto one line or cut off; a formula shown as source or garbled; a table whose cells lost their content or whose structure collapsed; a broken image",
  "- the title is wrong (not this article's title, the site name or interface text mixed in, the wrong heading taken)",
  "- the body is out of order, or a whole passage is duplicated",
  "- something else was extracted (only a summary, a navigation page)",
  "minor — the information is all there, but visibly wrong:",
  "- the author or the publication date is missing or wrong (when the page clearly shows one)",
  "- content outside the boundary left in the body (an author card, a subscribe block, a licence footer)",
  "- wrong heading levels, permalink residue in a heading, paragraphs split or merged, a list flattened with its content intact",
  "- a missing caption, an empty heading, the title repeated once as a body heading",
  "- spacing, line breaks and similar typesetting blemishes",
  "Not issues — never list them:",
  "- content outside the boundary that was dropped",
  "- a defect the original page has itself (the REFERENCE tiles show it broken the same way)",
  "- differences in how the markdown is written, as long as the reader displays it correctly",
];

const MARKDOWN_LINE = "The markdown is the GFM representation the reading agent is given; the reader itself renders a document model. Inline HTML that markdown must escape (MathML, <table>, <figure>) is not a defect by itself: judge what the reader page displays.";

/** The images paragraph: what the tiles are, in which order they are attached, and which were left out. */
export function describeImages(plan: ImagePlan, visual: Pick<VisualInput, "truncated" | "viewport" | "metrics">): string[] {
  const { rendered, reference } = plan;
  const span = (from: number, count: number, label: string) => (count === 1 ? `image ${from} is ${label} tile 1` : `images ${from}–${from + count - 1} are ${label} tiles 1–${count}`);
  const order = [
    rendered.sent ? span(1, rendered.sent, "RENDERED") : "",
    reference.sent ? `${rendered.sent ? "then " : ""}${span(rendered.sent + 1, reference.sent, "REFERENCE")}` : "",
  ].filter(Boolean).join(", ");
  const omitted = (label: string, side: SideCount) => (side.sent < side.total ? `${label} tile${side.total - side.sent === 1 ? ` ${side.total}` : `s ${side.sent + 1}–${side.total}`} of ${side.total}` : "");
  const left = [omitted("rendered", rendered), omitted("reference", reference)].filter(Boolean);
  const cut = [visual.truncated.rendered ? `the rendered page is ${visual.metrics.height} px tall and its capture stops after ${plural(rendered.total, "tile")}` : "", visual.truncated.reference ? `the reference capture stops after ${plural(reference.total, "tile")}` : ""].filter(Boolean);
  return [
    `RENDERED tiles ${rendered.sent ? range(rendered.sent) : "(none)"} are the Quire reader exactly as a reader sees it (top to bottom, ${visual.viewport.width} px wide); REFERENCE tiles ${reference.sent ? range(reference.sent) : "(none)"} are the original page rendered from the snapshot with JavaScript off and network CSS/images — the reference may lack styles or images; never blame the extractor for what the reference itself lacks.`,
    `The ${plural(plan.images.length, "image")} are attached in this order: ${order || "none"}. Each tile is ${visual.viewport.height} px of the page; consecutive tiles continue it without overlap.`,
    ...(left.length ? [`OMITTED: to stay within ${plan.maxImages} images per call, ${left.join(" and ")} ${rendered.total - rendered.sent + reference.total - reference.sent > 1 ? "were" : "was"} captured but not attached. Judge that part of the page from the texts and the facts, which cover the whole page; do not report it as missing.`] : []),
    ...(cut.length ? [`CAPTURE CUT: ${cut.join("; ")}. Judge what lies below the last tile from the texts and the facts only.`] : []),
  ];
}

/** The capture's measured facts about the rendered page, one line each. */
export function describeFacts(visual: Pick<VisualInput, "metrics" | "warnings" | "failedReferenceRequests">): string[] {
  const { images, overflow, rawMarkup, mathErrors, unmarkedLists, emptyCellTables, emptyHeadings, duplicateTitleHeadings, counts, height } = visual.metrics;
  return [
    `- Images: ${images.total} in the article, ${images.broken} broken (failed to load)${images.broken ? `: ${listOf(images.brokenSrc.map((src) => clipText(src, 160)))}` : ""}.`,
    `- Horizontal overflow: ${plural(overflow.count, "element")} wider than the reading column${overflow.count ? `: ${listOf(overflow.samples.map((sample) => `${sample.path} (${sample.width} px)`))}` : ""}.`,
    `- Raw markup visible as text: ${rawMarkup.count}${rawMarkup.count ? ` — ${listOf(rawMarkup.samples.map((sample) => `${JSON.stringify(sample.pattern)} in "${clipText(sample.text, 120)}"`))} (the samples are verbatim rendered text and may be quoted as evidence)` : ""}.`,
    `- Math that failed to render: ${mathErrors}.`,
    `- Lists whose items show no bullet or number: ${unmarkedLists} of ${counts.lists}.`,
    `- Tables with a quarter or more of their cells empty: ${emptyCellTables.count}${emptyCellTables.count ? ` — ${listOf(emptyCellTables.samples.map((sample) => `table ${sample.table} (${sample.empty} of ${sample.cells} cells empty)`))}` : ""}.`,
    `- Code blocks shown as one long line (several lines run together): ${visual.metrics.collapsedCode}.`,
    `- Headings: ${counts.headings} (${emptyHeadings} empty, ${duplicateTitleHeadings} repeating the title).`,
    `- The reader shows ${plural(counts.codeBlocks, "code block")}, ${plural(counts.tables, "table")}, ${plural(counts.figures, "figure")}, ${plural(counts.lists, "list")}, ${plural(counts.footnotes, "footnote")} and ${counts.words} words; the article is ${height} px tall.`,
    `- Reference page: ${plural(visual.failedReferenceRequests, "network request")} failed while it loaded${visual.failedReferenceRequests ? " (missing styles or images in the reference are expected)" : ""}.`,
    ...(visual.warnings.length ? [`- Capture warnings: ${listOf(visual.warnings.map((warning) => clipText(warning, 200)))}.`] : []),
  ];
}

const tileOf = (tile: number | null) => (tile === null ? "below the captured tiles" : `tile ${tile}`);
const quoted = (label: string, text: string, max = 80) => (text.trim() ? `, ${label} "${clipText(text, max)}"` : "");
const capped = (lines: string[], total: number, what: string) => (total > INVENTORY_MAX ? [...lines.slice(0, INVENTORY_MAX), `- … and ${total - INVENTORY_MAX} more ${what} not listed`] : lines);

/** "r2 (tile 3, alt "…", caption "…", BROKEN)": every image the reader page shows. */
export function describeRenderedImages(images: readonly RenderedImage[]): string[] {
  if (!images.length) return ["- (none: the reader page shows no images)"];
  return capped(images.map((image) => `- ${image.id} (${tileOf(image.tile)}${quoted("alt", image.alt)}${quoted("caption", image.caption)}${image.broken ? ", BROKEN" : ""})`), images.length, "reader images");
}

/** "o4 (tile 3, 640×420, alt "…") ↔ r2" or "… — not in the reader": every sizeable image of the original. */
export function describeReferenceImages(images: readonly ReferenceImage[]): string[] {
  if (!images.length) return ["- (none: the original shows no sizeable images with JavaScript off)"];
  return capped(images.map((image) => `- ${image.id} (${tileOf(image.tile)}, ${image.width && image.height ? `${image.width}×${image.height}` : "unsized"}${quoted("alt", image.alt)}) ${image.matchedBy ? `↔ ${image.matchedBy}` : "— not in the reader"}`), images.length, "original images");
}

/** "e3 iframe youtube.com, after "Training setup…", shown in reader: no": every embed in the snapshot. */
export function describeEmbeds(embeds: readonly Embed[]): string[] {
  if (!embeds.length) return ["- (none: the snapshot has no JavaScript or plugin content)"];
  return capped(embeds.map((embed, index) => `- ${embedId(index)} ${embed.kind}${embed.tag && embed.tag !== embed.kind ? ` <${embed.tag}>` : ""} ${embed.host || "(no host)"}, after "${clipText(embed.context, 100) || "(start of page)"}", shown in reader: ${embed.representedInReader ? "yes" : "no"}`), embeds.length, "embeds");
}

/** "t2 (tile 4, 9×4, 13 of 20 cells empty, "Metric | Chrome…")": every table the reader shows. */
export function describeTables(tables: readonly RenderedTable[]): string[] {
  if (!tables.length) return ["- (none: the reader page shows no tables)"];
  return capped(tables.map((table) => `- ${table.id} (${tileOf(table.tile)}, ${table.rows}×${table.cols}, ${table.emptyCells} of ${table.cells} cells empty${hasEmptyCells(table) ? " — EMPTY CELLS" : ""}${quoted("first row", table.head)})`), tables.length, "tables");
}

/** "c3 (tile 3) shown as ONE line of 212 chars: "def clipped_error(x): …"": every code block the reader shows. */
export function describeCode(code: readonly RenderedCode[]): string[] {
  if (!code.length) return ["- (none: the reader page shows no code blocks)"];
  return capped(code.map((block) => `- ${block.id} (${tileOf(block.tile)}) ${block.collapsed ? `shown as ONE line of ${block.chars} chars` : `${block.lines} line${block.lines === 1 ? "" : "s"}`}: "${clipText(block.head, 60)}"`), code.length, "code blocks");
}

/** The issue rules: the fields of each issue, and what the program checks before an issue counts. */
function issueRules(plan: ImagePlan): string[] {
  const tiles = `rendered tiles ${plan.rendered.sent ? range(plan.rendered.sent) : "none"}, reference tiles ${plan.reference.sent ? range(plan.reference.sent) : "none"}`;
  return [
    "- layer: content, metadata or rendering, by section 3.",
    "- kind: from the vocabulary above. Visual problems use the same kinds: a broken, missing or doubled image → images; raw markup, unrendered math or collapsed code → code_or_math; a mangled table → tables; horizontal overflow, broken headings, lists or spacing → layout.",
    "- severity: major or minor, by section 4.",
    "- subject: for a metadata issue, what it is about: \"title\", \"author\" or \"date\" — every metadata issue must name it; null for every other issue. A wrong title is a major metadata issue; a missing or wrong author or date is a minor metadata issue, never a content issue. The program sets the layer and severity of metadata issues from the subject.",
    `- evidence: a verbatim quote of at most ${EVIDENCE_MAX_CHARS} characters copied from SOURCE, EXTRACTED or RENDERED TEXT; never paraphrase. For a problem you see in a tile, quote the visible text nearest to it (the broken block's first words, its caption, or the heading above it).`,
    `- where: the tile the problem shows in, { "image": "rendered" | "reference", "tile": n } with n among the tiles attached (${tiles}): the RENDERED tile where the defect is visible; a REFERENCE tile only for something the reader lacks entirely; null when the problem shows only in the texts. Report a visual problem only after seeing it in a tile.`,
    "- refs: the ids of the images (r…, o…), embeds (e…), tables (t…) and code blocks (c…) the issue is about, from the inventories above; [] when it is about none. An issue about a specific image, embed, table or code block must cite its id.",
    "- note: what is wrong, in one sentence.",
    `- Claiming an image is missing requires an original image id that has no match (\"not in the reader\"); an original image with a match (↔ r…) is in the reader and is not missing. A broken image cites its r id. An image issue that cites no id counts only while an unmatched original image of ${LARGE_IMAGE_PX} px or more on a side exists.`,
    "- Every embed that belongs to the article and is not shown in the reader (shown in reader: no) is a major content issue citing its e id. An embed shown in the reader is not an issue; neither is one outside the boundary (an ad, a comment widget, a newsletter form).",
    "- Facts override impressions: when a tile seems to contradict a fact, the fact is right. A non-zero broken-image, raw-markup, unmarked-list or empty-cell-table fact must appear as an issue unless the reference shows the same defect. Overflow and math errors are defects when a reader would see them (a scrollable code block is fine; text cut off at the column edge is not).",
    "- A difference that comes from the reference lacking styles, scripts or images (unstyled layout, empty image boxes, a consent banner) is not a defect of the reader.",
    "- The program discards an issue whose evidence is not verbatim, that contradicts the facts, that points at a tile not attached, or that cites an id no inventory has.",
    "- List every defect once; an empty list when the page is clean. Do not grade: the verdicts are computed from your issues.",
  ];
}

/** The visual rubric's prompt (RUBRIC_VERSION, standard v6): the standard, the attached tiles, the facts and inventories, the texts. */
export function buildVisualPrompt(input: PromptInput, plan: ImagePlan): string {
  const { visual } = input;
  if (!visual) throw new Error(`buildVisualPrompt: ${input.slug} has no render capture`);
  return [
    "You are evaluating how well Quire turned a web page into a reader page: what its article extractor kept, and how the reader displays it.",
    "Your job is only to find problems and give evidence for each; a program computes the verdicts from the issues you list.",
    "Everything you need is in this message and its attached images. Do not run commands, read files or browse; answer from these inputs only.",
    "",
    `Case: ${input.slug} — ${input.url}`,
    "",
    "THE STANDARD",
    ...SOURCES_OF_TRUTH,
    "",
    ...ARTICLE_BOUNDARY,
    "",
    ...THREE_LAYERS,
    "",
    ...SEVERITY_RULES,
    "",
    "TEXTS",
    SOURCE_LINE,
    EXTRACTED_LINE,
    MARKDOWN_LINE,
    `RENDERED TEXT is the reader page's visible text (innerText), in reading order${visual.renderedTextTruncated ? ", cut at the end to fit this prompt" : ""}. It is there only so visual problems can be quoted: formulas show in it with duplicated or split symbols and table cells on separate lines even when they render correctly, so never judge how anything looks from it. SOURCE and EXTRACTED decide completeness; the RENDERED tiles and the FACTS decide rendering.`,
    truncationNoteOf(input),
    "IMAGES",
    ...describeImages(plan, visual),
    "How to look: go through every RENDERED tile top to bottom. Elements continue across tiles, so before calling a figure, table, formula or list missing or broken, find where it belongs and check the tiles before and after. Compare with the REFERENCE tiles for what the original shows: list markers (bullets, numbers), what table cells contain (text, check marks, icons), figure images, code layout and line breaks, formula typesetting.",
    "",
    "FACTS measured in the rendered reader page by the capture program (ground truth, not opinions):",
    ...describeFacts(visual),
    "",
    "READER IMAGES — every image the reader page shows, in document order (id, tile, alt / caption, BROKEN when it failed to load):",
    ...describeRenderedImages(visual.images.rendered),
    "",
    "ORIGINAL IMAGES — the sizeable images of the original page with JavaScript off, in document order (id, tile, laid-out size, alt), each with the reader image that is the same picture (matched by URL, lazy-load candidates included) or \"not in the reader\":",
    ...describeReferenceImages(visual.images.reference),
    "",
    "TABLES — every table the reader page shows, in document order (id, tile, rows×columns, empty body cells, first row):",
    ...describeTables(visual.tables),
    "",
    "CODE BLOCKS — every code block the reader page shows, in document order (id, tile, lines, or ONE line when several lines run together, first characters):",
    ...describeCode(visual.code),
    "",
    "EMBEDS — content the original page fills in with JavaScript or a plugin, found in the snapshot HTML, in document order (id, kind, host, the text it follows, whether the reader shows it or a link to it):",
    ...describeEmbeds(visual.embeds),
    "",
    "List every defect as an issue with a kind from this vocabulary:",
    ...KIND_LINES(),
    "",
    "Rules for issues:",
    ...issueRules(plan),
    "",
    "Answer with JSON only, matching the schema you were given: { issues: [{ layer, kind, severity, subject, evidence, where, refs, note }], summary }.",
    "",
    "===== SOURCE =====",
    input.source,
    "===== END SOURCE =====",
    "",
    "===== EXTRACTED =====",
    input.extracted,
    "===== END EXTRACTED =====",
    "",
    "===== RENDERED TEXT =====",
    visual.renderedText,
    "===== END RENDERED TEXT =====",
  ].join("\n");
}
