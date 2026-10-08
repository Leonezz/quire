// GitHub issue bodies from the report: one tracking "quality report" issue (charts as Mermaid, which
// GitHub renders; every MAJOR case folded into <details>) and one "Rendering: <slug>" issue per MAJOR
// case, on the shape of .github/ISSUE_TEMPLATE/rendering.yml. Pure; publish.mjs sends them with gh.
// A visual case lists its measured rendering facts and each issue's tile in text; the screenshots
// themselves stay local (gh cannot upload images), named by their path under eval/render/out/.
import type { CaseIssue, CaseRow, ReportData, VerdictChange } from "./data";

/** GitHub rejects bodies over 65,536 characters; the case list is cut before that with a note. */
export const BODY_LIMIT = 65_536;
const BODY_BUDGET = 60_000;
export const CASE_LABELS = ["rendering", "judge"] as const;

export interface IssueOptions { repo: string; runLabel?: string }
export interface RenderedIssue { title: string; body: string }
export interface CaseIssueRendered extends RenderedIssue { labels: string[] }

const VERDICTS = ["PASS", "MINOR", "MAJOR"] as const;
const md = (text: string) => text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
/** Text inside a quoted Mermaid label: quotes and colons would end the label or the statement. */
const mermaidLabel = (text: string) => text.replace(/["':]/g, " ").replace(/\s+/g, " ").trim();
/** The quote as one inline code span so its own markdown (a leading #, |, [![image]) stays literal; the span's fence outruns any backticks inside. */
function codeSpan(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const fence = "`".repeat(Math.max(0, ...[...flat.matchAll(/`+/g)].map((run) => run[0].length)) + 1);
  const padded = flat.startsWith("`") || flat.endsWith("`") ? ` ${flat} ` : flat;
  return `${fence}${padded}${fence}`;
}
const quote = (text: string) => `> ${codeSpan(text)}`;
const fmtTokens = (value: number) => (value >= 1e6 ? `${(value / 1e6).toFixed(1)}M` : value >= 1e3 ? `${(value / 1e3).toFixed(1)}k` : String(value));
const fmtMs = (value: number) => (value >= 60_000 ? `${Math.floor(value / 60_000)}m ${Math.round((value % 60_000) / 1000)}s` : `${(value / 1000).toFixed(1)}s`);
const kindList = (row: CaseRow) => row.kinds.map((kind) => `${kind.kind}${kind.severity === "major" ? "!" : ""}`).join(", ") || "no issues";

function summaryTable(data: ReportData): string[] {
  const { totals } = data;
  const percent = (n: number) => (totals.cases ? ` (${Math.round((n / totals.cases) * 100)}%)` : "");
  return [
    "| | count |", "|---|---:|",
    `| Cases judged | ${totals.cases} |`,
    ...VERDICTS.map((verdict) => `| ${verdict} | ${totals[verdict]}${percent(totals[verdict])} |`),
    `| Not judged (errors) | ${totals.errors} |`,
    `| Issues | ${totals.issues} (${totals.majorIssues} major) |`,
    `| Evidence quotes not found verbatim | ${totals.unverified} |`,
    ...(totals.escalated ? [`| Escalated to a second opinion | ${totals.escalated} |`, `| Disputed verdicts | ${totals.disputed} |`] : []),
    ...renderRows(data),
  ];
}

/** The capture facts over the corpus, as summary-table rows; none when no case was judged with a capture. */
function renderRows({ renderTotals: t }: ReportData): string[] {
  if (!t.captured) return [];
  const cases = (n: number) => (n ? ` in ${n} case${n === 1 ? "" : "s"}` : "");
  return [
    `| Cases judged with screenshots | ${t.captured} |`,
    `| Broken images (measured) | ${t.brokenImages}${cases(t.brokenCases)} |`,
    `| Overflowing elements (measured) | ${t.overflow}${cases(t.overflowCases)} |`,
    `| Raw markup shown as text (measured) | ${t.rawMarkup}${cases(t.rawMarkupCases)} |`,
    `| Math render errors (measured) | ${t.mathErrors}${cases(t.mathErrorCases)} |`,
  ];
}

function verdictPie(data: ReportData): string[] {
  const slices = [...VERDICTS.map((verdict) => [verdict, data.totals[verdict]] as const), ["error", data.totals.errors] as const].filter(([, n]) => n > 0);
  if (!slices.length) return [];
  return ["```mermaid", "pie showData", `    title ${mermaidLabel("Verdicts")}`, ...slices.map(([name, n]) => `    "${mermaidLabel(name)}" : ${n}`), "```"];
}

function kindChart(data: ReportData): string[] {
  if (!data.byKind.length) return ["No issues reported."];
  const max = Math.max(...data.byKind.map((kind) => kind.issues));
  return [
    "```mermaid", "xychart-beta horizontal",
    `    title "${mermaidLabel("Issues by kind (all, then major)")}"`,
    `    x-axis [${data.byKind.map((kind) => `"${mermaidLabel(kind.kind)}"`).join(", ")}]`,
    `    y-axis "${mermaidLabel("issues")}" 0 --> ${max}`,
    `    bar [${data.byKind.map((kind) => kind.issues).join(", ")}]`,
    `    bar [${data.byKind.map((kind) => kind.major).join(", ")}]`,
    "```",
    "",
    "| kind | cases | issues | major |", "|---|---:|---:|---:|",
    ...data.byKind.map((kind) => `| ${kind.kind} | ${kind.cases} | ${kind.issues} | ${kind.major} |`),
  ];
}

const changeList = (title: string, changes: readonly VerdictChange[]) => (changes.length ? [`**${title} (${changes.length})**`, "", ...changes.map((change) => `- \`${change.slug}\` ${change.from} → ${change.to}`), ""] : [`**${title}:** none.`, ""]);

function backendLines(data: ReportData): string[] {
  const { agreement } = data;
  if (!agreement.compared) return [];
  const pct = Math.round((agreement.agree / agreement.compared) * 100);
  return [
    "### Backends",
    "",
    `Screen vs confirm on ${agreement.compared} escalated case${agreement.compared === 1 ? "" : "s"}: ${agreement.agree} agree (${pct}%), ${agreement.disagree} disagree.`,
    "",
    "| screen ↓ confirm → | PASS | MINOR | MAJOR |", "|---|---:|---:|---:|",
    ...VERDICTS.map((row) => `| ${row} | ${VERDICTS.map((column) => agreement.matrix[row][column]).join(" | ")} |`),
    "",
    ...data.byBackend.map((backend) => `- **${backend.backend}** (${backend.models.join(", ") || "–"}): ${backend.opinions} opinions, decided ${backend.decided}, ${fmtTokens(backend.tokens)} tokens, ${backend.costUsd === undefined ? "cost not reported" : `$${backend.costUsd.toFixed(2)}`}, ${fmtMs(backend.wallMs)} wall`),
    "",
  ];
}

const whereText = (issue: CaseIssue) => (issue.where ? ` — ${issue.where.image} tile ${issue.where.tile}` : "");
const issueLines = (issue: CaseIssue) => [`- **${issue.kind}** (${issue.severity}${issue.verified ? "" : ", quote not found verbatim"}) — ${md(issue.note)}${whereText(issue)}`, ...(issue.evidence.trim() ? [`  ${quote(issue.evidence)}`] : [])];

const FACT_SAMPLES = 3;
function sideText(row: CaseRow, side: "rendered" | "reference"): string {
  const sent = row.render?.sent[side] ?? 0;
  const total = row.render?.tiles[side].length ?? 0;
  return sent === 0 ? `no ${side} tiles (${total} captured)` : `${side} tile${sent === 1 ? " 1" : `s 1–${sent}`} of ${total}`;
}

/** The case's measured facts and where its screenshots are, in text; nothing for a case judged without a capture. */
export function factLines(row: CaseRow): string[] {
  const render = row.render;
  if (!render) return [];
  const { images, overflow, rawMarkup, mathErrors, counts } = render.metrics;
  const samples = (items: readonly string[]) => `${items.slice(0, FACT_SAMPLES).join(", ")}${items.length > FACT_SAMPLES ? `, and ${items.length - FACT_SAMPLES} more` : ""}`;
  return [
    `**Rendering facts** (measured in the reader page): ${images.broken} of ${images.total} images broken, ${overflow.count} element${overflow.count === 1 ? "" : "s"} wider than the column, ${rawMarkup.count} raw-markup sample${rawMarkup.count === 1 ? "" : "s"}, ${mathErrors} math error${mathErrors === 1 ? "" : "s"}; ${counts.codeBlocks} code blocks, ${counts.tables} tables, ${counts.figures} figures, ${counts.words} words.`,
    ...(images.broken ? [`- broken images: ${samples(images.brokenSrc.map(codeSpan))}`] : []),
    ...(overflow.count ? [`- overflow: ${samples(overflow.samples.map((sample) => `${codeSpan(sample.path)} (${sample.width} px)`))}`] : []),
    ...(rawMarkup.count ? [`- raw markup: ${samples(rawMarkup.samples.map((sample) => `${codeSpan(sample.pattern)} in ${codeSpan(sample.text)}`))}`] : []),
    `- screenshots: eval/render/out/${row.slug}/ (local) — the judge saw ${sideText(row, "rendered")} and ${sideText(row, "reference")}`,
  ];
}

function caseDetails(row: CaseRow): string {
  return [
    `<details><summary><code>${row.slug}</code> — ${kindList(row)}</summary>`,
    "",
    ...(row.url ? [`Source: ${row.url}`, ""] : []),
    ...row.issues.flatMap(issueLines),
    "",
    ...(row.render ? [...factLines(row), ""] : []),
    `_${md(row.summary)}_`,
    "",
    "</details>",
  ].join("\n");
}

/** The case list, cut to the budget with a note on what was left out. */
function topCases(rows: readonly CaseRow[], budget: number): string[] {
  const blocks = rows.map(caseDetails);
  const kept = blocks.reduce<{ blocks: string[]; used: number }>((acc, block) => (acc.used + block.length + 1 > budget ? acc : { blocks: [...acc.blocks, block], used: acc.used + block.length + 1 }), { blocks: [], used: 0 });
  const omitted = rows.length - kept.blocks.length;
  return [...kept.blocks, ...(omitted ? [`_${omitted} more MAJOR case${omitted === 1 ? "" : "s"} omitted to stay under GitHub's body limit; see \`eval/judge/report.html\` locally for all of them._`] : [])];
}

/** The MAJOR cases, the ones with the most major issues first; the order the tracking issue lists them and the publisher files them. */
export function majorCases(data: ReportData): CaseRow[] {
  const majorCount = (row: CaseRow) => row.issues.filter((issue) => issue.severity === "major").length;
  return data.cases.filter((row) => row.verdict === "MAJOR").sort((a, b) => majorCount(b) - majorCount(a) || a.slug.localeCompare(b.slug));
}

export function renderReportIssue(data: ReportData, { repo, runLabel }: IssueOptions): RenderedIssue {
  const date = data.generatedAt.slice(0, 10);
  const { totals } = data;
  const title = `Extraction quality report — ${date} (${totals.PASS}/${totals.MINOR}/${totals.MAJOR})`;
  const majors = majorCases(data);
  const head = [
    `Automated extraction quality report from the judge over the eval corpus, generated ${data.generatedAt}${runLabel ? ` (${runLabel})` : ""}. Numbers are PASS/MINOR/MAJOR verdicts per case; issue kinds use the app's rendering-problem vocabulary.`,
    "",
    "## Summary",
    "",
    ...summaryTable(data),
    "",
    ...verdictPie(data),
    "",
    "## Issues by kind",
    "",
    ...kindChart(data),
    "",
    "## Against the baseline",
    "",
    ...changeList("Regressed", data.regressions),
    ...changeList("Improved", data.improvements),
    ...(data.errors.length ? [`**Not judged (${data.errors.length}):** ${data.errors.map((error) => `\`${error.slug}\``).join(", ")}`, ""] : []),
    ...backendLines(data),
    `## Top cases (${majors.length} MAJOR)`,
    "",
  ];
  const foot = [
    "",
    "---",
    "",
    "Reproduce: `pnpm --filter @read/eval judge` (then `pnpm --filter @read/eval judge:publish --issue` to refresh this issue).",
    `Structural report without evidence quotes: [eval/judge/report.md](https://github.com/${repo}/blob/main/eval/judge/report.md).`,
    "",
  ];
  const budget = BODY_BUDGET - head.join("\n").length - foot.join("\n").length;
  const body = [...head, ...(majors.length ? topCases(majors, budget) : ["No MAJOR cases."]), ...foot].join("\n");
  if (body.length > BODY_LIMIT) throw new Error(`report issue body is ${body.length} characters, over GitHub's ${BODY_LIMIT}`);
  return { title, body };
}

/** The kind the issue is filed under: the first major issue's kind, else the first kind reported. */
export function topKind(row: CaseRow): string {
  return row.issues.find((issue) => issue.severity === "major")?.kind ?? row.issues[0]?.kind ?? "other";
}

export function renderCaseIssue(row: CaseRow, { repo }: { repo: string }): CaseIssueRendered {
  // Sections mirror .github/ISSUE_TEMPLATE/extraction-defect.yml so hand-filed and judge-filed cases read alike.
  const body = [
    "### Case",
    "",
    `\`${row.slug}\``,
    "",
    "### URL",
    "",
    row.url || "_not in corpus.json_",
    "",
    "### Found by",
    "",
    `the judge (${row.decidedBy}${row.disputed ? ", disputed" : ""})`,
    "",
    "### What went wrong",
    "",
    `Verdict **${row.verdict}**${row.baselineVerdict ? ` (baseline ${row.baselineVerdict}, ${row.delta})` : ""}; kinds: ${kindList(row)}.`,
    "",
    ...(row.issues.length ? row.issues.flatMap(issueLines) : ["No issues listed."]),
    "",
    ...(row.render ? [...factLines(row), ""] : []),
    "### Details",
    "",
    md(row.summary),
    "",
    ...(row.disputed ? [`The backends disagreed on the verdict: ${row.opinions.map((opinion) => `${opinion.backend} said ${opinion.verdict}`).join(", ")}; the final follows ${row.decidedBy}.`, ""] : []),
    "### Judge line",
    "",
    "```",
    `judge: ${row.decidedBy} ${row.model}${row.mode === "visual" ? " · visual mode" : ""} · rubric ${row.rubricVersion} · judged ${row.judgedAt}${row.truncated ? " · input truncated to fit the prompt" : ""}`,
    "```",
    "",
    "### Done when",
    "",
    `- [ ] \`pnpm --filter @read/eval judge ${row.slug}\` gives PASS (or a verdict agreed here) with the issues above gone`,
    `- [ ] \`pnpm --filter @read/eval eval\` stays green (golden regenerated for this case only and reviewed)`,
    "- [ ] no regression against `eval/judge/baseline.json`; baseline updated with `--update-baseline`",
    "",
    "---",
    "",
    `Filed by the judge; reproduce with \`pnpm --filter @read/eval judge ${row.slug}\`. Structural report: [eval/judge/report.md](https://github.com/${repo}/blob/main/eval/judge/report.md). Template for hand-filed cases: [extraction-defect](https://github.com/${repo}/issues/new?template=extraction-defect.yml).`,
    "",
  ].join("\n");
  return { title: `Rendering: ${row.slug} — ${topKind(row)}`, body, labels: [...CASE_LABELS] };
}
