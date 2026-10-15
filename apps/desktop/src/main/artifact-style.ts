// The stylesheet every framed artifact (HTML, React, Mermaid) starts with: the reader's colours and
// font as --quire-* variables (the reader sends its own values once the frame is up, ArtifactFrame.tsx),
// a validated categorical chart palette per scheme, quiet typography for plain HTML, and the classes
// the React kit (src/artifact-kit) is drawn with. Everything sits in the `quire` cascade layer, placed
// between Tailwind's base (its reset) and its utilities, so an artifact's own CSS and utility classes
// always win and the reset never flattens the kit.

/** Categorical chart colours, in a fixed order validated for colour-blind separation and contrast on each scheme's surface. */
export const CHART_COLORS = {
  light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"],
  dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
} as const;

const LIGHT = {
  "--quire-bg": "#ffffff", "--quire-fg": "#0f1115", "--quire-muted": "rgba(28,32,40,.68)", "--quire-subtle": "rgba(28,32,40,.5)",
  "--quire-accent": "#2653c4", "--quire-border": "rgba(28,32,40,.12)", "--quire-surface": "#f7f8fb",
  "--quire-positive": "#1a7f43", "--quire-negative": "#c9302c", "--quire-warning": "#a75600",
};
const DARK = {
  "--quire-bg": "#191b20", "--quire-fg": "#f2f3f7", "--quire-muted": "rgba(226,229,236,.72)", "--quire-subtle": "rgba(226,229,236,.5)",
  "--quire-accent": "#8fb0ff", "--quire-border": "rgba(226,229,236,.14)", "--quire-surface": "#1f2228",
  "--quire-positive": "#34d476", "--quire-negative": "#ff8a87", "--quire-warning": "#ffb466",
};

function declarations(values: Record<string, string>, chart: readonly string[]): string {
  return [...Object.entries(values), ...chart.map((colour, index) => [`--quire-chart-${index + 1}`, colour] as const)].map(([name, value]) => `${name}:${value}`).join(";");
}

/** Plain HTML is typeset like the reader; a React artifact opts in with .q-prose (its Tailwind reset otherwise stands). */
const PROSE = ":where(:root:not([data-kind=react]), .q-prose)";

const RULES = `
:root{${declarations(LIGHT, CHART_COLORS.light)};--quire-font:-apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",sans-serif;--quire-mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;--quire-radius:12px;color-scheme:light}
:root[data-scheme=dark]{${declarations(DARK, CHART_COLORS.dark)};color-scheme:dark}
html,body{margin:0;background:var(--quire-bg);color:var(--quire-fg);font:400 16px/1.6 var(--quire-font);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;font-feature-settings:"kern"}
html{overflow-y:hidden}
${PROSE} :where(h1){margin:0 0 12px;font:700 30px/1.15 var(--quire-font);letter-spacing:-.022em;text-wrap:balance}
${PROSE} :where(h2){margin:32px 0 10px;font:700 21px/1.3 var(--quire-font);letter-spacing:-.016em;text-wrap:balance}
${PROSE} :where(h3){margin:24px 0 8px;font:600 17px/1.35 var(--quire-font);letter-spacing:-.01em}
${PROSE} :where(p,ul,ol){margin:0 0 14px}
${PROSE} :where(ul,ol){padding-left:22px}
${PROSE} :where(li){margin:3px 0}
${PROSE} :where(li)::marker{color:var(--quire-subtle)}
${PROSE} :where(a){color:var(--quire-accent);text-decoration:underline;text-decoration-color:color-mix(in srgb,var(--quire-accent) 35%,transparent);text-underline-offset:3px}
${PROSE} :where(strong,b){font-weight:600}
${PROSE} :where(table){width:100%;margin:0 0 18px;border-collapse:collapse;font-size:14px}
${PROSE} :where(th){padding:8px 12px;border-bottom:1px solid var(--quire-border);color:var(--quire-muted);font:600 11.5px/16px var(--quire-font);letter-spacing:.06em;text-align:left;text-transform:uppercase}
${PROSE} :where(td){padding:9px 12px;border-bottom:1px solid var(--quire-border);vertical-align:top}
${PROSE} :where(code){font-family:var(--quire-mono);font-size:.88em}
${PROSE} :where(:not(pre)>code){padding:1px 5px;border-radius:5px;background:var(--quire-surface)}
${PROSE} :where(pre){margin:0 0 18px;padding:14px 16px;border-radius:10px;background:var(--quire-surface);font:13px/1.6 var(--quire-mono);overflow:auto}
${PROSE} :where(blockquote){margin:0 0 16px;padding:2px 0 2px 16px;border-left:2px solid var(--quire-accent);color:var(--quire-muted)}
${PROSE} :where(hr){margin:28px 0;border:0;border-top:1px solid var(--quire-border)}
${PROSE} :where(figure){margin:24px 0}
${PROSE} :where(figcaption){margin-top:8px;color:var(--quire-muted);font-size:12.5px;line-height:1.5}
${PROSE} :where(img,svg,video){max-width:100%;height:auto}
:where(button,input,select,textarea){font:inherit;color:inherit}
:where(:focus-visible){outline:2px solid color-mix(in srgb,var(--quire-accent) 60%,transparent);outline-offset:2px;border-radius:4px}

.q-page{box-sizing:border-box;max-width:var(--quire-measure,720px);margin:0 auto;padding:4px 0 12px}
.q-page[data-wide]{max-width:min(100%,1080px)}
.q-page>:first-child{margin-top:0}
.q-eyebrow{margin:0 0 6px;color:var(--quire-accent);font:600 12px/16px var(--quire-font);letter-spacing:.06em;text-transform:uppercase}
.q-title{margin:0 0 10px;font:700 28px/1.18 var(--quire-font);letter-spacing:-.022em;text-wrap:balance}
.q-lead{max-width:68ch;margin:0 0 24px;color:var(--quire-muted);font-size:18px;line-height:1.55;letter-spacing:-.006em;text-wrap:pretty}
.q-section{margin:36px 0 0}
.q-section-title{margin:0 0 4px;font:700 20px/1.3 var(--quire-font);letter-spacing:-.016em;text-wrap:balance}
.q-section-description{max-width:68ch;margin:0 0 14px;color:var(--quire-muted);font-size:15px;line-height:1.55}
.q-section-body{margin-top:14px}
.q-columns{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr));gap:16px}
.q-card{box-sizing:border-box;padding:16px 18px;border:1px solid var(--quire-border);border-radius:var(--quire-radius);background:var(--quire-bg)}
.q-card-title{margin:0 0 6px;font:600 15px/1.4 var(--quire-font)}
.q-muted{color:var(--quire-muted)}

.q-callout{--q-tone:var(--quire-accent);margin:20px 0;padding:14px 18px;border-radius:var(--quire-radius);background:color-mix(in srgb,var(--q-tone) 7%,var(--quire-bg));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--q-tone) 16%,transparent)}
.q-callout[data-tone=tip]{--q-tone:var(--quire-positive)}
.q-callout[data-tone=important]{--q-tone:var(--quire-chart-7)}
.q-callout[data-tone=warning]{--q-tone:var(--quire-warning)}
.q-callout[data-tone=caution]{--q-tone:var(--quire-negative)}
.q-callout-title{margin:0 0 4px;color:color-mix(in srgb,var(--q-tone) 78%,var(--quire-fg));font:600 12.5px/18px var(--quire-font);letter-spacing:.04em;text-transform:uppercase}
.q-callout-body{font-size:15px;line-height:1.55}
.q-callout-body>:last-child{margin-bottom:0}

.q-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,170px),1fr));gap:12px;margin:20px 0}
.q-stat{padding:14px 16px 15px;border-radius:var(--quire-radius);background:var(--quire-surface)}
.q-stat-label{margin:0;color:var(--quire-muted);font:600 11.5px/16px var(--quire-font);letter-spacing:.06em;text-transform:uppercase}
.q-stat-value{margin:6px 0 0;font:700 28px/1.12 var(--quire-font);font-variant-numeric:tabular-nums;letter-spacing:-.022em}
.q-stat-change{margin:4px 0 0;color:var(--quire-muted);font:500 13px/18px var(--quire-font);font-variant-numeric:tabular-nums}
.q-stat-change[data-tone=positive]{color:var(--quire-positive)}
.q-stat-change[data-tone=negative]{color:var(--quire-negative)}
.q-stat-hint{margin:6px 0 0;color:var(--quire-muted);font-size:13px;line-height:1.45}

.q-figure{margin:28px 0}
.q-figure-title{margin:0;font:600 15.5px/1.4 var(--quire-font);letter-spacing:-.005em}
.q-figure-subtitle{margin:2px 0 0;color:var(--quire-muted);font-size:13.5px;line-height:1.45}
.q-figure-body{margin-top:14px}
.q-figure-caption{margin:10px 0 0;color:var(--quire-muted);font-size:12.5px;line-height:1.5}
.q-legend{display:flex;flex-wrap:wrap;gap:6px 16px;margin:10px 0 0;padding:0;list-style:none;color:var(--quire-muted);font-size:13px}
.q-legend li{display:inline-flex;align-items:center;gap:6px;margin:0}
.q-legend-swatch{width:10px;height:10px;border-radius:3px;flex:none}

.q-cite{color:var(--quire-accent);text-decoration:underline;text-decoration-color:color-mix(in srgb,var(--quire-accent) 35%,transparent);text-underline-offset:3px;cursor:pointer}
.q-cite:hover{text-decoration-color:var(--quire-accent)}
.q-quote{margin:24px 0;padding:2px 0 2px 18px;border-left:3px solid var(--quire-accent)}
.q-quote-text{margin:0;font-size:19px;line-height:1.5;letter-spacing:-.008em;text-wrap:pretty}
.q-quote-source{margin:8px 0 0;color:var(--quire-muted);font-size:13px}

.q-table{margin:16px 0 20px;border:1px solid var(--quire-border);border-radius:10px;overflow:auto}
.q-table table{width:100%;margin:0;border-collapse:collapse;font-size:14px}
.q-table th{padding:0;border-bottom:1px solid var(--quire-border);background:var(--quire-surface);color:var(--quire-muted);font:600 11.5px/16px var(--quire-font);letter-spacing:.06em;text-align:left;text-transform:uppercase;white-space:nowrap}
.q-table th>span,.q-table th>button{display:flex;align-items:center;gap:4px;width:100%;padding:9px 12px;border:0;background:none;color:inherit;font:inherit;letter-spacing:inherit;text-align:inherit;text-transform:inherit}
.q-table th>button{cursor:pointer}
.q-table th>button:hover{color:var(--quire-fg)}
.q-table th[data-align=right]>*{justify-content:flex-end}
.q-table td{padding:9px 12px;border-bottom:1px solid var(--quire-border);vertical-align:top}
.q-table tr:last-child td{border-bottom:0}
.q-table td[data-align=right]{font-variant-numeric:tabular-nums;text-align:right}
.q-table tbody tr:hover td{background:color-mix(in srgb,var(--quire-surface) 70%,transparent)}
.q-sort{opacity:.5;font-size:10px}

.q-tabs-list{display:inline-flex;gap:2px;margin:0 0 16px;padding:3px;border-radius:10px;background:var(--quire-surface)}
.q-tab{padding:5px 12px;border:0;border-radius:7px;background:none;color:var(--quire-muted);font:500 13.5px/20px var(--quire-font);cursor:pointer;transition:background-color 160ms cubic-bezier(.22,1,.36,1),color 160ms cubic-bezier(.22,1,.36,1)}
.q-tab:hover{color:var(--quire-fg)}
.q-tab[aria-selected=true]{background:var(--quire-bg);color:var(--quire-fg);box-shadow:0 1px 2px rgba(0,0,0,.08),0 0 0 1px var(--quire-border)}

.q-timeline{position:relative;margin:20px 0;padding:0;list-style:none}
.q-timeline-item{position:relative;margin:0;padding:0 0 18px 26px}
.q-timeline-item::before{content:"";position:absolute;left:5px;top:20px;bottom:-2px;width:1px;background:var(--quire-border)}
.q-timeline-item:last-child::before{display:none}
.q-timeline-item::after{content:"";position:absolute;left:0;top:7px;width:9px;height:9px;border-radius:50%;background:var(--quire-bg);box-shadow:inset 0 0 0 2px var(--quire-accent)}
.q-timeline-date{margin:0;color:var(--quire-muted);font:600 12px/18px var(--quire-font);font-variant-numeric:tabular-nums;letter-spacing:.04em;text-transform:uppercase}
.q-timeline-title{margin:2px 0 0;font:600 15.5px/1.4 var(--quire-font)}
.q-timeline-body{margin:4px 0 0;color:var(--quire-muted);font-size:14.5px;line-height:1.55}

.q-badge{display:inline-flex;align-items:center;padding:1px 8px;border-radius:999px;background:color-mix(in srgb,var(--q-tone,var(--quire-muted)) 12%,transparent);color:var(--q-tone,var(--quire-muted));font:600 12px/20px var(--quire-font)}
.q-badge[data-tone=positive]{--q-tone:var(--quire-positive)}
.q-badge[data-tone=negative]{--q-tone:var(--quire-negative)}
.q-badge[data-tone=warning]{--q-tone:var(--quire-warning)}
.q-badge[data-tone=accent]{--q-tone:var(--quire-accent)}

.q-chart-tooltip{padding:8px 10px;border-radius:8px;background:var(--quire-bg);box-shadow:0 4px 16px rgba(0,0,0,.12),0 0 0 1px var(--quire-border);font-size:12.5px;line-height:1.5}
.recharts-cartesian-axis-tick-value,.recharts-legend-item-text{fill:var(--quire-muted)}
.recharts-text{font-family:var(--quire-font)}

@media (prefers-reduced-motion:reduce){*,*::before,*::after{transition:none!important;animation:none!important}}
`;

/**
 * The stylesheet a framed artifact starts with. The layer order puts `quire` after Tailwind's reset
 * and before its utilities; declaring it first fixes that order for the Tailwind sheet added later.
 */
export function artifactStyle(): string {
  return `@layer theme, base, quire, components, utilities;\n@layer quire {${RULES}}`;
}

/** Tailwind's theme for a React artifact: utilities that follow the reader (bg-surface, text-muted, border-line, text-accent, bg-chart-1…). */
export const TAILWIND_THEME = `@theme {
  --color-bg: var(--quire-bg); --color-fg: var(--quire-fg); --color-muted: var(--quire-muted); --color-subtle: var(--quire-subtle);
  --color-accent: var(--quire-accent); --color-line: var(--quire-border); --color-surface: var(--quire-surface);
  --color-positive: var(--quire-positive); --color-negative: var(--quire-negative); --color-warning: var(--quire-warning);
  ${CHART_COLORS.light.map((_, index) => `--color-chart-${index + 1}: var(--quire-chart-${index + 1});`).join(" ")}
  --font-sans: var(--quire-font); --font-mono: var(--quire-mono);
}`;
