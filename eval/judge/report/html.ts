// eval/judge/report.html: the structured report as one self-contained page (inline CSS, JS and SVG,
// nothing fetched). It carries evidence quotes from third-party pages, so the file is gitignored.
// The table is rendered here in full; the script only filters, sorts and expands what is already
// on the page, so the report reads without JavaScript too. A visual case shows its rendered and
// reference tiles as lazy thumbnails linked (relatively, from eval/judge/report.html) to the local
// captures in eval/render/out/<slug>/, with the tiles its issues point at marked. Each case shows its
// three layer verdicts as badges; issues the program discarded are struck through with their reason;
// the expanded case lists the image inventories (reader images, original images with their match)
// and the embeds the issues were checked against.
import type { Agreement, BackendStat, CaseIssue, CaseOpinion, CaseRow, KindStat, LayerTotals, RenderTotals, ReportData, Totals } from "./data";
import type { LayerVerdicts } from "../verdict";

// Local rather than imported from ./data: this module must load under Node's type stripping, which needs
// an explicit .ts extension the TypeScript config does not allow, so it keeps to type-only imports.
const VERDICT_ORDER = ["PASS", "MINOR", "MAJOR"] as const;
const LAYER_ORDER = ["content", "metadata", "rendering"] as const;

const esc = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const attr = (text: string) => esc(text).replace(/'/g, "&#39;");
const fmtInt = (value: number) => value.toLocaleString("en-US");
const fmtTokens = (value: number | undefined) => (value === undefined ? "–" : value >= 1e6 ? `${(value / 1e6).toFixed(1)}M` : value >= 1e3 ? `${(value / 1e3).toFixed(1)}k` : String(value));
const fmtCost = (value: number | undefined) => (value === undefined ? "–" : `$${value.toFixed(2)}`);
const fmtMs = (value: number) => (value >= 60_000 ? `${Math.floor(value / 60_000)}m ${Math.round((value % 60_000) / 1000)}s` : `${(value / 1000).toFixed(1)}s`);
const verdictClass = (verdict: string) => `v-${verdict.toLowerCase()}`;

// Status colors from the palette; text never wears them, only marks do.
const STYLE = `
:root { color-scheme: light dark; --bg: #fcfcfb; --surface: #ffffff; --line: #e4e2dd; --ink: #1c1c1a; --ink-2: #55534d; --ink-3: #8a8780; --accent: #2a63c9;
  --good: #0ca30c; --warning: #fab219; --critical: #d03b3b; --neutral: #9a978f; --good-bg: #e6f6e6; --warning-bg: #fff3d6; --critical-bg: #fbe3e3; --neutral-bg: #ecebe8; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg: #1a1a19; --surface: #232321; --line: #3a3936; --ink: #ecebe6; --ink-2: #b5b2aa; --ink-3: #807d75; --accent: #7fa7ec;
  --good-bg: #163d16; --warning-bg: #4a3a10; --critical-bg: #4b1d1d; --neutral-bg: #34332f; } }
:root[data-theme="dark"] { --bg: #1a1a19; --surface: #232321; --line: #3a3936; --ink: #ecebe6; --ink-2: #b5b2aa; --ink-3: #807d75; --accent: #7fa7ec;
  --good-bg: #163d16; --warning-bg: #4a3a10; --critical-bg: #4b1d1d; --neutral-bg: #34332f; }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px 16px 64px; background: var(--bg); color: var(--ink); font: 14px/1.45 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
main { max-width: 1200px; margin: 0 auto; }
h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 16px; margin: 32px 0 12px; } h3 { font-size: 14px; margin: 0 0 8px; }
.muted { color: var(--ink-2); } .small { font-size: 12px; color: var(--ink-3); }
code { font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
a { color: var(--accent); }
.tiles { display: flex; flex-wrap: wrap; gap: 8px; margin: 16px 0; }
.tile { flex: 1 1 120px; min-width: 120px; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; }
.tile .label { font-size: 12px; color: var(--ink-2); } .tile .value { font-size: 24px; font-weight: 600; margin-top: 2px; } .tile .sub { font-size: 12px; color: var(--ink-3); }
.tile .value .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 6px; vertical-align: 2px; }
.backends { display: flex; flex-wrap: wrap; gap: 8px; } .backends .tile { flex: 1 1 260px; }
.charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; }
figure { margin: 0; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 12px; }
figcaption { font-weight: 600; margin-bottom: 8px; }
svg { display: block; max-width: 100%; height: auto; } svg text { fill: var(--ink-2); font-size: 12px; } svg .val { fill: var(--ink); } svg .grid { stroke: var(--line); stroke-width: 1; }
.legend { display: flex; gap: 16px; font-size: 12px; color: var(--ink-2); margin-top: 8px; } .legend span::before { content: ""; display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; vertical-align: -1px; background: var(--c); }
table { border-collapse: collapse; width: 100%; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; }
th, td { text-align: left; padding: 6px 10px; border-top: 1px solid var(--line); vertical-align: top; } thead th { border-top: 0; font-size: 12px; color: var(--ink-2); white-space: nowrap; }
th button { all: unset; cursor: pointer; font: inherit; color: inherit; } th button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; } th button[aria-sort]::after { content: " ↕"; color: var(--ink-3); } th button[aria-sort="ascending"]::after { content: " ↑"; } th button[aria-sort="descending"]::after { content: " ↓"; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
.badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; border: 1px solid transparent; }
.v-pass { background: var(--good-bg); } .v-minor { background: var(--warning-bg); } .v-major { background: var(--critical-bg); } .v-error { background: var(--neutral-bg); }
.kind { display: inline-block; padding: 0 6px; border-radius: 4px; background: var(--neutral-bg); font-size: 12px; margin: 1px 2px 1px 0; } .kind.major { background: var(--critical-bg); }
.delta { font-size: 12px; } .delta.regressed { color: var(--critical); font-weight: 600; } .delta.improved { color: var(--good); font-weight: 600; }
.matrix td, .matrix th { text-align: center; } .matrix td.diag { background: var(--good-bg); } .matrix td.off:not(.zero) { background: var(--warning-bg); }
.filters { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: end; margin: 0 0 12px; padding: 12px; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; }
.filters label { display: flex; flex-direction: column; gap: 2px; font-size: 12px; color: var(--ink-2); } .filters label.check { flex-direction: row; align-items: center; gap: 6px; padding-bottom: 6px; }
.filters input, .filters select { font: inherit; color: var(--ink); background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 4px 8px; }
.filters .count { margin-left: auto; align-self: center; color: var(--ink-2); font-size: 12px; }
button.expand { all: unset; cursor: pointer; width: 22px; height: 22px; line-height: 22px; text-align: center; border-radius: 4px; color: var(--ink-2); } button.expand:hover { background: var(--neutral-bg); } button.expand:focus-visible { outline: 2px solid var(--accent); }
button.expand::before { content: "▸"; } button.expand[aria-expanded="true"]::before { content: "▾"; }
tr.detail td { background: var(--bg); padding: 12px 16px 16px 44px; }
tbody[hidden] { display: none; }
.opinions { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; margin-top: 8px; }
.opinion { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; } .opinion.final { border-color: var(--accent); }
.opinion h4 { margin: 0 0 6px; font-size: 13px; } .opinion h4 .badge { margin-left: 6px; }
ul.issues { margin: 6px 0 0; padding-left: 18px; } ul.issues li { margin-bottom: 6px; }
blockquote { margin: 4px 0 0; padding: 4px 10px; border-left: 3px solid var(--line); color: var(--ink-2); font-size: 12px; white-space: pre-wrap; word-break: break-word; }
.unverified { color: var(--critical); font-size: 11px; } .verified { color: var(--good); font-size: 11px; }
details { margin: 8px 0; } summary { cursor: pointer; font-weight: 600; } summary:focus-visible { outline: 2px solid var(--accent); }
ul.plain { margin: 6px 0; padding-left: 18px; }
.table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
.facts { margin: 8px 0; font-size: 12px; color: var(--ink-2); } .facts ul { margin: 4px 0 0; padding-left: 18px; } .facts code { word-break: break-all; }
.fact { display: inline-block; padding: 0 6px; border-radius: 4px; background: var(--neutral-bg); font-size: 12px; margin: 1px 2px 1px 0; } .fact.bad { background: var(--critical-bg); }
.shots { margin: 10px 0; } .shots h4 { margin: 8px 0 4px; font-size: 12px; color: var(--ink-2); font-weight: 600; }
.strip { display: flex; gap: 6px; overflow-x: auto; padding-bottom: 4px; }
.shot { flex: 0 0 auto; width: 112px; text-decoration: none; color: var(--ink-2); font-size: 11px; text-align: center; }
.shot img { display: block; width: 112px; height: 140px; object-fit: cover; object-position: top; border: 1px solid var(--line); border-radius: 4px; background: var(--surface); }
.shot.hit img { border: 2px solid var(--critical); } .shot.unsent img { opacity: .55; } .shot .n { display: block; margin-top: 2px; } .shot.hit .n { color: var(--critical); font-weight: 600; }
a.where { font-size: 11px; margin-left: 4px; white-space: nowrap; }
.layers { white-space: nowrap; } .layers .badge { font-weight: 500; padding: 0 6px; margin-right: 2px; } .badge.v-none { background: var(--neutral-bg); color: var(--ink-3); }
.layer-tag { font-size: 11px; color: var(--ink-2); border: 1px solid var(--line); border-radius: 4px; padding: 0 4px; margin-left: 2px; } .refs { font-size: 11px; color: var(--ink-2); margin-left: 4px; }
li.invalid > del { color: var(--ink-3); } li.invalid blockquote { text-decoration: line-through; color: var(--ink-3); } .reason { display: inline-block; font-size: 11px; color: var(--critical); margin-left: 4px; }
.origin { font-size: 11px; border-radius: 4px; padding: 0 5px; margin-left: 4px; background: var(--neutral-bg); color: var(--ink-2); } .origin.both { background: var(--good-bg); } .origin.one-sided-fact { background: var(--warning-bg); } .origin.one-sided-downgraded { text-decoration: none; background: var(--neutral-bg); }
.inventory { margin: 8px 0; font-size: 12px; } .inventory table { margin: 4px 0 8px; font-size: 12px; } .inventory td, .inventory th { padding: 3px 8px; } .inventory .missing { color: var(--critical); font-weight: 600; } .inventory code { word-break: break-all; }
@media (max-width: 720px) { th.opt, td.opt { display: none; } }
`;

const SCRIPT = `
(function () {
  var rows = Array.prototype.slice.call(document.querySelectorAll("tbody.case"));
  var controls = { verdict: byId("f-verdict"), kind: byId("f-kind"), backend: byId("f-backend"), disputed: byId("f-disputed"), delta: byId("f-delta"), q: byId("f-q") };
  var count = byId("f-count");
  function byId(id) { return document.getElementById(id); }
  function matches(row) {
    var d = row.dataset;
    if (controls.verdict.value && d.verdict !== controls.verdict.value) return false;
    if (controls.kind.value && (" " + d.kinds + " ").indexOf(" " + controls.kind.value + " ") < 0) return false;
    if (controls.backend.value && d.backend !== controls.backend.value) return false;
    if (controls.disputed.checked && d.disputed !== "1") return false;
    if (controls.delta.value && d.delta !== controls.delta.value) return false;
    var q = controls.q.value.trim().toLowerCase();
    if (q && d.text.indexOf(q) < 0) return false;
    return true;
  }
  function applyFilters() {
    var shown = 0;
    rows.forEach(function (row) { var on = matches(row); row.hidden = !on; if (on) shown += 1; });
    count.textContent = shown + " of " + rows.length + " cases";
  }
  Object.keys(controls).forEach(function (key) { controls[key].addEventListener("input", applyFilters); controls[key].addEventListener("change", applyFilters); });
  var table = byId("cases");
  var sortButtons = Array.prototype.slice.call(table.querySelectorAll("th button[data-key]"));
  sortButtons.forEach(function (button) {
    button.addEventListener("click", function () {
      var key = button.dataset.key, numeric = button.dataset.numeric === "1";
      var dir = button.getAttribute("aria-sort") === "ascending" ? "descending" : "ascending";
      sortButtons.forEach(function (other) { other.setAttribute("aria-sort", "none"); });
      button.setAttribute("aria-sort", dir);
      var sorted = rows.slice().sort(function (a, b) {
        var x = a.dataset["sort" + key], y = b.dataset["sort" + key];
        var c = numeric ? Number(x) - Number(y) : x < y ? -1 : x > y ? 1 : 0;
        return dir === "ascending" ? c : -c;
      });
      sorted.forEach(function (row) { table.appendChild(row); });
    });
  });
  rows.forEach(function (row) {
    var button = row.querySelector("button.expand"), detail = row.querySelector("tr.detail");
    if (!button || !detail) return;
    button.addEventListener("click", function () { var open = button.getAttribute("aria-expanded") !== "true"; button.setAttribute("aria-expanded", String(open)); detail.hidden = !open; });
  });
  byId("expand-all").addEventListener("click", function () { rows.forEach(function (row) { if (row.hidden) return; row.querySelector("button.expand").setAttribute("aria-expanded", "true"); row.querySelector("tr.detail").hidden = false; }); });
  byId("collapse-all").addEventListener("click", function () { rows.forEach(function (row) { row.querySelector("button.expand").setAttribute("aria-expanded", "false"); row.querySelector("tr.detail").hidden = true; }); });
  applyFilters();
})();
`;

const VERDICT_COLOR: Record<string, string> = { PASS: "var(--good)", MINOR: "var(--warning)", MAJOR: "var(--critical)", error: "var(--neutral)" };

function tile(label: string, value: string, sub = "", dotColor?: string): string {
  return `<div class="tile"><div class="label">${esc(label)}</div><div class="value">${dotColor ? `<span class="dot" style="background:${dotColor}"></span>` : ""}${value}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ""}</div>`;
}

function headerTiles(totals: Totals): string {
  const pct = (n: number) => (totals.cases ? `${Math.round((n / totals.cases) * 100)}% of judged` : "");
  return `<div class="tiles">${[
    tile("Cases", fmtInt(totals.cases), totals.errors ? `+ ${totals.errors} not judged` : "all judged"),
    tile("PASS", fmtInt(totals.PASS), pct(totals.PASS), VERDICT_COLOR.PASS),
    tile("MINOR", fmtInt(totals.MINOR), pct(totals.MINOR), VERDICT_COLOR.MINOR),
    tile("MAJOR", fmtInt(totals.MAJOR), pct(totals.MAJOR), VERDICT_COLOR.MAJOR),
    tile("Errors", fmtInt(totals.errors), "judge calls that failed", VERDICT_COLOR.error),
    tile("Issues", fmtInt(totals.issues), `${totals.majorIssues} major · ${totals.invalid} invalid (not counted) · ${totals.unverified} unverified quote${totals.unverified === 1 ? "" : "s"}`),
    tile("Escalated", fmtInt(totals.escalated), "cases with a second opinion"),
    tile("Disputed", fmtInt(totals.disputed), "backends disagreed on the verdict"),
  ].join("")}</div>`;
}

/** One tile per layer with its verdict counts; nothing when no case carries layers (all judged before rubric v6). */
function layerTiles(layers: LayerTotals): string {
  const judged = LAYER_ORDER.filter((layer) => layers[layer].judged > 0);
  if (!judged.length) return "";
  return `<div class="tiles">${judged.map((layer) => tile(`${layer} layer`, VERDICT_ORDER.map((verdict) => `<span class="badge ${verdictClass(verdict)}">${layers[layer][verdict]} ${verdict}</span>`).join(" "), `${layers[layer].judged} case${layers[layer].judged === 1 ? "" : "s"} judged on this layer`)).join("")}</div>`;
}

/** The discarded issues by reason; nothing when none. */
function invalidLine(totals: Totals): string {
  if (!totals.invalid) return "";
  return `<p class="small">Invalid issues, never counted: ${Object.entries(totals.invalidByReason).map(([reason, n]) => `${esc(reason)} ${n}`).join(" · ")}.</p>`;
}

/** The capture facts over the corpus; nothing when no case was judged with a capture. */
function renderTiles(totals: RenderTotals): string {
  if (!totals.captured) return "";
  const sub = (cases: number) => `in ${cases} of ${totals.captured} captured case${totals.captured === 1 ? "" : "s"}`;
  return `<div class="tiles">${[
    tile("Broken images", fmtInt(totals.brokenImages), sub(totals.brokenCases)),
    tile("Overflowing elements", fmtInt(totals.overflow), sub(totals.overflowCases)),
    tile("Raw markup", fmtInt(totals.rawMarkup), sub(totals.rawMarkupCases)),
    tile("Math errors", fmtInt(totals.mathErrors), sub(totals.mathErrorCases)),
  ].join("")}</div>`;
}

function backendTiles(backends: readonly BackendStat[]): string {
  if (!backends.length) return "";
  return `<div class="backends">${backends.map((backend) => `<div class="tile"><div class="label">${esc(backend.backend)} · ${esc(backend.models.join(", ") || "–")}</div><div class="value">${fmtTokens(backend.tokens)} <span class="small">tokens</span> · ${backend.costUsd === undefined ? '<span class="small">cost not reported</span>' : fmtCost(backend.costUsd)}</div><div class="sub">${backend.opinions} opinion${backend.opinions === 1 ? "" : "s"} · decided ${backend.decided} · ${fmtMs(backend.wallMs)} wall</div></div>`).join("")}</div>`;
}

/** Verdict donut: four status-colored arcs with a 2px surface gap between them, the judged count in the middle. */
function donut(totals: Totals): string {
  const parts = [["PASS", totals.PASS], ["MINOR", totals.MINOR], ["MAJOR", totals.MAJOR], ["error", totals.errors]] as const;
  const total = parts.reduce((s, [, n]) => s + n, 0);
  const r = 44, c = 2 * Math.PI * r, gap = 2;
  const arcs = parts.reduce<{ svg: string[]; offset: number }>((acc, [name, n]) => {
    if (!n) return acc;
    const len = (n / total) * c;
    const dash = Math.max(0, len - (parts.filter(([, v]) => v).length > 1 ? gap : 0));
    const svg = `<circle r="${r}" cx="60" cy="60" fill="none" stroke="${VERDICT_COLOR[name]}" stroke-width="14" stroke-dasharray="${dash.toFixed(2)} ${(c - dash).toFixed(2)}" stroke-dashoffset="${(-acc.offset).toFixed(2)}" transform="rotate(-90 60 60)"><title>${esc(name)}: ${n} (${Math.round((n / total) * 100)}%)</title></circle>`;
    return { svg: [...acc.svg, svg], offset: acc.offset + len };
  }, { svg: [], offset: 0 });
  const legend = parts.map(([name, n]) => `<span style="--c:${VERDICT_COLOR[name]}">${esc(name)} ${n}</span>`).join("");
  return `<figure><figcaption>Verdicts</figcaption><svg viewBox="0 0 120 120" width="160" height="160" role="img" aria-label="Verdicts: ${parts.map(([name, n]) => `${name} ${n}`).join(", ")}">${total ? arcs.svg.join("") : `<circle r="${r}" cx="60" cy="60" fill="none" stroke="var(--line)" stroke-width="14"/>`}<text x="60" y="56" text-anchor="middle" class="val" font-size="22" font-weight="600">${total}</text><text x="60" y="74" text-anchor="middle" font-size="10">cases</text></svg><div class="legend">${legend}</div></figure>`;
}

/** Issues by kind: one horizontal bar per kind, major (critical) then minor (warning) segments, a 2px surface gap between them, the total at the tip. */
function kindChart(byKind: readonly KindStat[]): string {
  if (!byKind.length) return `<figure><figcaption>Issues by kind</figcaption><p class="muted">No issues reported.</p></figure>`;
  const labelW = 130, barMax = 300, rowH = 28, barH = 20, gap = 2, top = 8;
  const max = Math.max(...byKind.map((row) => row.issues));
  const scale = (n: number) => (n / max) * barMax;
  const height = top + byKind.length * rowH + 20;
  const ticks = [0, max / 2, max].map((t) => Math.round(t));
  const bars = byKind.map((row, i) => {
    const y = top + i * rowH + (rowH - barH) / 2;
    const majorW = scale(row.major), minorW = scale(row.minor);
    const segments: string[] = [];
    const roundedEnd = (x: number, w: number, color: string, title: string) => `<path d="M${x.toFixed(1)} ${y} h${Math.max(0, w - 4).toFixed(1)} a4 4 0 0 1 4 4 v${barH - 8} a4 4 0 0 1 -4 4 h-${Math.max(0, w - 4).toFixed(1)} z" fill="${color}"><title>${esc(title)}</title></path>`;
    if (row.major && row.minor) {
      segments.push(`<rect x="${labelW}" y="${y}" width="${Math.max(0, majorW - gap).toFixed(1)}" height="${barH}" fill="var(--critical)"><title>${esc(row.kind)} major: ${row.major}</title></rect>`);
      segments.push(roundedEnd(labelW + majorW, minorW, "var(--warning)", `${row.kind} minor: ${row.minor}`));
    } else if (row.major) segments.push(roundedEnd(labelW, majorW, "var(--critical)", `${row.kind} major: ${row.major}`));
    else segments.push(roundedEnd(labelW, minorW, "var(--warning)", `${row.kind} minor: ${row.minor}`));
    return `<g><text x="${labelW - 8}" y="${y + barH / 2 + 4}" text-anchor="end">${esc(row.kind)}</text>${segments.join("")}<text x="${(labelW + scale(row.issues) + 6).toFixed(1)}" y="${y + barH / 2 + 4}" class="val">${row.issues}<tspan fill="var(--ink-3)"> · ${row.cases} case${row.cases === 1 ? "" : "s"}</tspan></text></g>`;
  });
  const grid = ticks.map((t) => `<line class="grid" x1="${(labelW + scale(t)).toFixed(1)}" x2="${(labelW + scale(t)).toFixed(1)}" y1="${top}" y2="${top + byKind.length * rowH}"/><text x="${(labelW + scale(t)).toFixed(1)}" y="${height - 4}" text-anchor="middle" font-size="10">${t}</text>`).join("");
  return `<figure><figcaption>Issues by kind</figcaption><svg viewBox="0 0 ${labelW + barMax + 120} ${height}" role="img" aria-label="Issues by kind, major and minor">${grid}${bars.join("")}</svg><div class="legend"><span style="--c:var(--critical)">major</span><span style="--c:var(--warning)">minor</span></div></figure>`;
}

function matrix(agreement: Agreement): string {
  if (!agreement.compared) return "";
  const pct = Math.round((agreement.agree / agreement.compared) * 100);
  return `<h2>Screen vs confirm</h2><p class="muted">${agreement.compared} case${agreement.compared === 1 ? "" : "s"} with a second opinion: ${agreement.agree} agree (${pct}%), ${agreement.disagree} disagree. Rows are the screener's verdict, columns the confirmer's.</p>
<div class="table-wrap"><table class="matrix" style="max-width:420px"><thead><tr><th>screen ↓ / confirm →</th>${VERDICT_ORDER.map((v) => `<th>${v}</th>`).join("")}</tr></thead><tbody>${VERDICT_ORDER.map((row) => `<tr><th>${row}</th>${VERDICT_ORDER.map((col) => { const n = agreement.matrix[row][col]; return `<td class="${row === col ? "diag" : "off"}${n ? "" : " zero"}">${n}</td>`; }).join("")}</tr>`).join("")}</tbody></table></div>`;
}

function baselineSection(data: ReportData): string {
  const list = (items: ReportData["regressions"]) => (items.length ? `<ul class="plain">${items.map((c) => `<li><code>${esc(c.slug)}</code> ${c.from} → ${c.to}</li>`).join("")}</ul>` : `<p class="muted">None.</p>`);
  const errors = data.errors.length ? `<details><summary>Not judged (${data.errors.length})</summary><ul class="plain">${data.errors.map((e) => `<li><code>${esc(e.slug)}</code> — ${esc(e.error)}</li>`).join("")}</ul></details>` : "";
  const fresh = data.cases.filter((row) => row.delta === "new").length;
  return `<h2>Against the baseline</h2><details ${data.regressions.length ? "open" : ""}><summary>Regressed (${data.regressions.length})</summary>${list(data.regressions)}</details><details ${data.improvements.length ? "open" : ""}><summary>Improved (${data.improvements.length})</summary>${list(data.improvements)}</details>${fresh ? `<p class="small">${fresh} case${fresh === 1 ? "" : "s"} not in the baseline yet.</p>` : ""}${errors}`;
}

/** A capture file as a link relative to eval/judge/report.html. */
const capturePath = (slug: string, file: string) => `../render/out/${encodeURIComponent(slug)}/${file.split("/").map(encodeURIComponent).join("/")}`;
type Side = "rendered" | "reference";
const tileFile = (row: CaseRow, side: Side, tile: number) => row.render?.tiles[side][tile - 1];

/** "rendered tile 3", linked to the full-size tile when the case has a capture. */
function whereChip(issue: CaseIssue, row: CaseRow | undefined): string {
  if (!issue.where) return "";
  const label = `${issue.where.image} tile ${issue.where.tile}`;
  const file = row ? tileFile(row, issue.where.image, issue.where.tile) : undefined;
  return file && row ? ` <a class="where" href="${attr(capturePath(row.slug, file))}" target="_blank" rel="noopener">${esc(label)} ↗</a>` : ` <span class="where small">${esc(label)}</span>`;
}

const ORIGIN_LABEL: Record<string, string> = { both: "both", "one-sided-fact": "one-sided + fact", "one-sided-downgraded": "downgraded", "one-sided": "one-sided" };
const ORIGIN_TITLE: Record<string, string> = { both: "both judges reported it", "one-sided-fact": "one judge reported it; a measured fact keeps it major", "one-sided-downgraded": "one judge reported it as major; no measured fact supports it, so it counts as minor", "one-sided": "one judge reported it" };
/** Who reported a cross-confirmed issue; nothing on single-opinion cases. */
function originChip(issue: CaseIssue): string {
  if (!issue.origin) return "";
  const label = `${ORIGIN_LABEL[issue.origin] ?? issue.origin}${issue.originalSeverity && issue.originalSeverity !== issue.severity ? ` (was ${issue.originalSeverity})` : ""}`;
  return `<span class="origin ${attr(issue.origin)}" title="${attr(ORIGIN_TITLE[issue.origin] ?? issue.origin)}">${esc(label)}</span>`;
}

/** One issue; a discarded one is struck through with the program's reason and counts for nothing. */
function issueItem(issue: CaseIssue, row?: CaseRow): string {
  const head = `<span class="kind ${issue.severity}">${esc(issue.kind)}</span>${issue.layer ? `<span class="layer-tag">${esc(issue.layer)}</span>` : ""} <strong>${issue.severity}</strong> — ${esc(issue.note)}`;
  const refs = `${issue.refs?.length ? `<span class="refs">[${issue.refs.map(esc).join(", ")}]</span>` : ""}${originChip(issue)}`;
  const quote = `<blockquote>${esc(issue.evidence)} <span class="${issue.verified ? "verified" : "unverified"}">${issue.verified ? "✓ verbatim" : "⚠ not found verbatim"}</span></blockquote>`;
  if (!issue.invalid) return `<li>${head}${refs}${whereChip(issue, row)}${quote}</li>`;
  return `<li class="invalid" title="not counted"><del>${head}</del>${refs}${whereChip(issue, row)} <span class="reason">invalid: ${esc(issue.invalid.reason)} — ${esc(issue.invalid.detail)}</span>${quote}</li>`;
}

/** The three layer verdicts as small badges ("–" for a layer not judged); a dash for results from before rubric v6. */
function layerBadges(layers: LayerVerdicts | undefined): string {
  if (!layers) return '<span class="small">–</span>';
  return `<span class="layers">${LAYER_ORDER.map((layer) => { const verdict = layers[layer]; return `<span class="badge ${verdict ? verdictClass(verdict) : "v-none"}" title="${layer} ${verdict ?? "not judged"}">${layer[0]!.toUpperCase()} ${verdict ?? "–"}</span>`; }).join("")}</span>`;
}

const INVENTORY_ROWS = 60;
const clipCell = (text: string, max = 90) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);
/** The inventories the case's issues were checked against: original images with their reader match, reader images, embeds. */
function inventoryBlock(row: CaseRow): string {
  const images = row.render?.images;
  const embeds = row.render?.embeds;
  const tables = row.render?.tables;
  const code = row.render?.code;
  if (!images && !embeds && !tables && !code) return "";
  const more = (total: number) => (total > INVENTORY_ROWS ? `<p class="small">and ${total - INVENTORY_ROWS} more</p>` : "");
  const tileText = (tile: number | null) => (tile === null ? "below" : String(tile));
  const reference = images ? `<h4>Original images (${images.reference.length}, ${images.reference.filter((image) => image.matchedBy === null).length} not in the reader)</h4>${images.reference.length ? `<div class="table-wrap"><table><thead><tr><th>id</th><th>tile</th><th>size</th><th>alt</th><th>in the reader</th></tr></thead><tbody>${images.reference.slice(0, INVENTORY_ROWS).map((image) => `<tr><td><code>${esc(image.id)}</code></td><td>${tileText(image.tile)}</td><td>${image.width}×${image.height}</td><td>${esc(clipCell(image.alt))}</td><td>${image.matchedBy ? `↔ <code>${esc(image.matchedBy)}</code>` : '<span class="missing">not in the reader</span>'}</td></tr>`).join("")}</tbody></table></div>${more(images.reference.length)}` : '<p class="small">None.</p>'}` : "";
  const rendered = images ? `<h4>Reader images (${images.rendered.length}, ${images.rendered.filter((image) => image.broken).length} broken)</h4>${images.rendered.length ? `<div class="table-wrap"><table><thead><tr><th>id</th><th>tile</th><th>alt / caption</th><th>src</th><th>state</th></tr></thead><tbody>${images.rendered.slice(0, INVENTORY_ROWS).map((image) => `<tr><td><code>${esc(image.id)}</code></td><td>${tileText(image.tile)}</td><td>${esc(clipCell([image.alt, image.caption].filter(Boolean).join(" / ")))}</td><td><code>${esc(clipCell(image.src, 70))}</code></td><td>${image.broken ? '<span class="missing">broken</span>' : "ok"}</td></tr>`).join("")}</tbody></table></div>${more(images.rendered.length)}` : '<p class="small">None.</p>'}` : "";
  const embedTable = embeds ? `<h4>Embeds (${embeds.length}, ${embeds.filter((embed) => !embed.representedInReader).length} not shown in the reader)</h4>${embeds.length ? `<div class="table-wrap"><table><thead><tr><th>id</th><th>kind</th><th>host</th><th>after</th><th>in the reader</th></tr></thead><tbody>${embeds.slice(0, INVENTORY_ROWS).map((embed, index) => `<tr><td><code>e${index + 1}</code></td><td>${esc(embed.kind)}${embed.tag && embed.tag !== embed.kind ? ` <code>&lt;${esc(embed.tag)}&gt;</code>` : ""}</td><td>${esc(embed.host || "–")}</td><td>${esc(clipCell(embed.context, 80))}</td><td>${embed.representedInReader ? "shown" : '<span class="missing">not shown</span>'}</td></tr>`).join("")}</tbody></table></div>${more(embeds.length)}` : '<p class="small">None.</p>'}` : "";
  const tableTable = tables ? `<h4>Tables (${tables.length}, ${tables.filter((table) => table.emptyCells > 0).length} with empty cells)</h4>${tables.length ? `<div class="table-wrap"><table><thead><tr><th>id</th><th>tile</th><th>size</th><th>empty cells</th><th>first row</th></tr></thead><tbody>${tables.slice(0, INVENTORY_ROWS).map((table) => `<tr><td><code>${esc(table.id)}</code></td><td>${tileText(table.tile)}</td><td>${table.rows}×${table.cols}</td><td>${table.emptyCells ? `<span class="missing">${table.emptyCells} of ${table.cells}</span>` : `0 of ${table.cells}`}</td><td>${esc(clipCell(table.head))}</td></tr>`).join("")}</tbody></table></div>${more(tables.length)}` : '<p class="small">None.</p>'}` : "";
  const codeTable = code ? `<h4>Code blocks (${code.length}, ${code.filter((block) => block.collapsed).length} shown as one line)</h4>${code.length ? `<div class="table-wrap"><table><thead><tr><th>id</th><th>tile</th><th>lines</th><th>first characters</th></tr></thead><tbody>${code.slice(0, INVENTORY_ROWS).map((block) => `<tr><td><code>${esc(block.id)}</code></td><td>${tileText(block.tile)}</td><td>${block.collapsed ? `<span class="missing">one line of ${block.chars} chars</span>` : String(block.lines)}</td><td><code>${esc(clipCell(block.head, 70))}</code></td></tr>`).join("")}</tbody></table></div>${more(code.length)}` : '<p class="small">None.</p>'}` : "";
  return `<details class="inventory"><summary>Image, embed, table and code inventories</summary>${reference}${rendered}${embedTable}${tableTable}${codeTable}</details>`;
}

/** One side's thumbnails: every captured tile, the ones the judge did not get dimmed, the ones an issue points at marked. */
function strip(row: CaseRow, side: Side): string {
  const render = row.render;
  if (!render || !render.tiles[side].length) return "";
  const sent = render.sent[side];
  const shots = render.tiles[side].map((file, index) => {
    const tile = index + 1;
    const hits = row.issues.filter((issue) => issue.where?.image === side && issue.where.tile === tile);
    const title = hits.length ? hits.map((issue) => `${issue.kind} (${issue.severity}): ${issue.note}`).join("\n") : `${side} tile ${tile}${tile > sent ? " (not sent to the judge)" : ""}`;
    return `<a class="shot${hits.length ? " hit" : ""}${tile > sent ? " unsent" : ""}" href="${attr(capturePath(row.slug, file))}" target="_blank" rel="noopener" title="${attr(title)}"><img loading="lazy" decoding="async" src="${attr(capturePath(row.slug, file))}" alt="${attr(`${side} tile ${tile}`)}"><span class="n">${tile}${hits.length ? ` · ${hits.length} issue${hits.length === 1 ? "" : "s"}` : ""}${tile > sent ? " · not sent" : ""}</span></a>`;
  }).join("");
  const truncated = render.truncated[side] ? " · capture stops before the end of the page" : "";
  return `<h4>${side === "rendered" ? "Rendered (Quire reader)" : "Reference (original, JS off)"} — ${sent} of ${render.tiles[side].length} sent${truncated}</h4><div class="strip">${shots}</div>`;
}

const FACT_LIMIT = 5;
/** The measured facts with their samples. */
function factsBlock(row: CaseRow): string {
  const render = row.render;
  if (!render) return "";
  const { images, overflow, rawMarkup, mathErrors, counts } = render.metrics;
  const chip = (count: number, label: string) => `<span class="fact${count ? " bad" : ""}">${count} ${esc(label)}</span>`;
  const samples = [
    ...images.brokenSrc.slice(0, FACT_LIMIT).map((src) => `broken image <code>${esc(src)}</code>`),
    ...overflow.samples.slice(0, FACT_LIMIT).map((sample) => `overflow <code>${esc(sample.path)}</code> (${sample.width} px)`),
    ...rawMarkup.samples.slice(0, FACT_LIMIT).map((sample) => `raw <code>${esc(sample.pattern)}</code> in “${esc(sample.text)}”`),
    ...render.warnings.map((warning) => `capture warning: ${esc(warning)}`),
  ];
  return `<div class="facts">Facts: ${chip(images.broken, `broken image${images.broken === 1 ? "" : "s"} of ${images.total}`)}${chip(overflow.count, "overflow")}${chip(rawMarkup.count, "raw markup")}${chip(mathErrors, "math errors")} <span class="small">${counts.codeBlocks} code · ${counts.tables} tables · ${counts.figures} figures · ${fmtInt(counts.words)} words · reference ${render.failedReferenceRequests} failed request${render.failedReferenceRequests === 1 ? "" : "s"}</span>${samples.length ? `<ul>${samples.map((item) => `<li>${item}</li>`).join("")}</ul>` : ""}</div>`;
}

const shotsBlock = (row: CaseRow) => (row.render ? `<div class="shots">${strip(row, "rendered")}${strip(row, "reference")}</div>` : "");

/** The table cell: non-zero facts as chips, "–" without a capture. */
function factsCell(row: CaseRow): string {
  if (!row.render) return '<span class="small">–</span>';
  const { images, overflow, rawMarkup, mathErrors } = row.render.metrics;
  const parts = [[images.broken, "img"], [overflow.count, "overflow"], [rawMarkup.count, "raw"], [mathErrors, "math"]] as const;
  const bad = parts.filter(([count]) => count > 0);
  return bad.length ? bad.map(([count, label]) => `<span class="fact bad">${count} ${label}</span>`).join("") : '<span class="small">clean</span>';
}

function opinionCard(opinion: CaseOpinion, final: boolean, row: CaseRow): string {
  return `<div class="opinion${final ? " final" : ""}"><h4>${esc(opinion.backend)} <span class="small">${esc(opinion.model)}</span><span class="badge ${verdictClass(opinion.verdict)}">${opinion.verdict}</span>${final ? ` <span class="small">· final</span>` : ""}</h4>${opinion.layers ? `<div>${layerBadges(opinion.layers)}</div>` : ""}<div class="small">${fmtTokens(opinion.tokens)} tokens · ${fmtCost(opinion.costUsd)} · ${fmtMs(opinion.wallMs)}${opinion.images ? ` · ${opinion.images} images` : ""}</div><p class="muted" style="margin:6px 0">${esc(opinion.summary)}</p>${opinion.issues.length ? `<ul class="issues">${opinion.issues.map((issue) => issueItem(issue, row)).join("")}</ul>` : `<p class="small">No issues.</p>`}</div>`;
}

const validCount = (row: CaseRow) => row.issues.filter((issue) => !issue.invalid).length;

function caseBody(row: CaseRow): string {
  const showOpinions = row.opinions.length >= 2;
  const opinions = showOpinions ? `<h3 style="margin-top:12px">Opinions${row.disputed ? ' <span class="badge v-minor">disputed</span>' : ""}</h3><div class="opinions">${row.opinions.map((opinion, i) => opinionCard(opinion, opinion.backend === row.decidedBy && row.opinions.findIndex((o) => o.backend === row.decidedBy) === i, row)).join("")}</div>` : "";
  return `<tbody class="case" data-verdict="${row.verdict}" data-kinds="${attr(row.kinds.map((k) => k.kind).join(" "))}" data-backend="${row.decidedBy}" data-disputed="${row.disputed ? 1 : 0}" data-delta="${row.delta}" data-text="${attr(`${row.slug} ${row.url}`.toLowerCase())}" data-sortslug="${attr(row.slug)}" data-sortverdict="${VERDICT_ORDER.indexOf(row.verdict)}" data-sortkinds="${row.kinds.length}" data-sortissues="${validCount(row)}" data-sortbackend="${row.decidedBy}" data-sortmajor="${row.issues.filter((i) => !i.invalid && i.severity === "major").length}" data-sorttokens="${row.tokens ?? 0}" data-sortfacts="${row.render ? row.render.metrics.images.broken + row.render.metrics.overflow.count + row.render.metrics.rawMarkup.count + row.render.metrics.mathErrors : -1}" data-sortdelta="${["regressed", "new", "same", "improved"].indexOf(row.delta)}">
<tr><td><button class="expand" aria-expanded="false" aria-label="Show details for ${attr(row.slug)}"></button></td><td><code>${esc(row.slug)}</code>${row.url ? ` <a class="small" href="${attr(row.url)}" target="_blank" rel="noopener">↗</a>` : ""}</td><td><span class="badge ${verdictClass(row.verdict)}">${row.verdict}</span>${row.disputed ? ' <span class="badge v-minor" title="backends disagreed">?</span>' : ""}</td><td class="opt">${layerBadges(row.layers)}</td><td>${row.kinds.map((k) => `<span class="kind ${k.severity}">${esc(k.kind)}</span>`).join("") || '<span class="small">–</span>'}</td><td class="num">${validCount(row)}${row.issues.length > validCount(row) ? ` <span class="small" title="discarded as invalid">+${row.issues.length - validCount(row)}</span>` : ""}</td><td class="opt">${factsCell(row)}</td><td class="opt">${esc(row.decidedBy)}${row.opinions.length >= 2 ? ` <span class="small">(${row.opinions.length})</span>` : ""}</td><td class="opt"><span class="delta ${row.delta}">${row.delta}${row.baselineVerdict && row.delta !== "same" ? ` <span class="small">(${row.baselineVerdict})</span>` : ""}</span></td><td class="num opt">${fmtTokens(row.tokens)}</td></tr>
<tr class="detail" hidden><td colspan="10"><p class="muted" style="margin:0 0 6px">${esc(row.summary)}</p><div class="small">${esc(row.model)} · rubric ${esc(row.rubricVersion)} · ${esc(row.judgedAt)} · ${fmtMs(row.wallMs)}${row.truncated ? " · input truncated" : ""} · ${row.mode} mode${row.url ? ` · <a href="${attr(row.url)}" target="_blank" rel="noopener">${esc(row.url)}</a>` : ""}</div>${factsBlock(row)}${row.issues.length ? `<ul class="issues">${row.issues.map((issue) => issueItem(issue, row)).join("")}</ul>` : `<p class="small">No issues.</p>`}${inventoryBlock(row)}${shotsBlock(row)}${opinions}</td></tr>
</tbody>`;
}

function casesSection(data: ReportData): string {
  const kinds = data.byKind.map((k) => k.kind);
  const backends = [...data.byBackend.map((b) => b.backend as string), ...(data.cases.some((row) => row.decidedBy === "merged") ? ["merged"] : [])];
  const option = (value: string, label = value) => `<option value="${attr(value)}">${esc(label)}</option>`;
  const th = (label: string, key: string, numeric = false, cls = "") => `<th class="${cls}"><button type="button" data-key="${key}" data-numeric="${numeric ? 1 : 0}" aria-sort="none">${esc(label)}</button></th>`;
  return `<h2>Cases</h2>
<form class="filters" onsubmit="return false">
<label>Verdict<select id="f-verdict"><option value="">all</option>${VERDICT_ORDER.map((v) => option(v)).join("")}</select></label>
<label>Kind<select id="f-kind"><option value="">all</option>${kinds.map((k) => option(k)).join("")}</select></label>
<label>Decided by<select id="f-backend"><option value="">all</option>${backends.map((b) => option(b)).join("")}</select></label>
<label>Delta<select id="f-delta"><option value="">all</option>${["regressed", "improved", "same", "new"].map((d) => option(d)).join("")}</select></label>
<label class="check"><input type="checkbox" id="f-disputed"> disputed only</label>
<label>Search<input type="search" id="f-q" placeholder="slug or url" size="24"></label>
<button type="button" id="expand-all">Expand all</button><button type="button" id="collapse-all">Collapse all</button>
<span class="count" id="f-count">${data.cases.length} of ${data.cases.length} cases</span>
</form>
<div class="table-wrap"><table id="cases"><thead><tr><th></th>${th("slug", "slug")}${th("verdict", "verdict", true)}<th class="opt">layers</th>${th("kinds", "kinds", true)}${th("issues", "issues", true, "num")}${th("render facts", "facts", true, "opt")}${th("decided by", "backend", false, "opt")}${th("vs baseline", "delta", true, "opt")}${th("tokens", "tokens", true, "num opt")}</tr></thead>
${data.cases.map(caseBody).join("\n")}
</table></div>`;
}

export function renderHtml(data: ReportData): string {
  const date = data.generatedAt.slice(0, 10);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Extraction quality ${esc(date)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>Extraction quality report</h1>
<p class="muted">Generated ${esc(data.generatedAt)} from <code>eval/judge/out</code>. Verdicts, issue kinds and evidence quotes are the judge's; quotes come from third-party pages, so this file stays local. Screenshots load from <code>eval/render/out</code> next to it.</p>
${headerTiles(data.totals)}
${layerTiles(data.totals.layers)}
${invalidLine(data.totals)}
${renderTiles(data.renderTotals)}
${backendTiles(data.byBackend)}
<h2>Overview</h2>
<div class="charts">${donut(data.totals)}${kindChart(data.byKind)}</div>
${matrix(data.agreement)}
${baselineSection(data)}
${casesSection(data)}
</main>
<script>${SCRIPT.replace(/<\/script/gi, "<\\/script")}</script>
</body>
</html>
`;
}
