use crate::images::{parse_image_url, ImageCache, ImageTarget};
use crate::materials::{valid_hex_16, MaterialStore};
use crate::normalizer_bridge::{CompiledReact, Normalizer};
use regex::Regex;
use std::fs;
use std::path::Path;
use tauri::http::{header, Response, StatusCode};
use url::Url;

pub const IMAGE_RESPONSE_CSP: &str =
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";

pub const ARTIFACT_CSP: &str = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' quire-artifact://runtime; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'";

pub const RUNTIME_FILES: &[&str] = &[
    "react", "quire", "recharts", "d3", "lucide", "lodash", "mermaid", "tailwind",
];

const LIGHT_VARS: &str = "--quire-bg:#ffffff;--quire-fg:#0f1115;--quire-muted:rgba(28,32,40,.68);--quire-subtle:rgba(28,32,40,.5);--quire-accent:#2653c4;--quire-border:rgba(28,32,40,.12);--quire-surface:#f7f8fb;--quire-positive:#1a7f43;--quire-negative:#c9302c;--quire-warning:#a75600;--quire-chart-1:#2a78d6;--quire-chart-2:#eb6834;--quire-chart-3:#1baf7a;--quire-chart-4:#eda100;--quire-chart-5:#e87ba4;--quire-chart-6:#008300;--quire-chart-7:#6250d6;--quire-chart-8:#e34948";
const DARK_VARS: &str = "--quire-bg:#191b20;--quire-fg:#f2f3f7;--quire-muted:rgba(226,229,236,.72);--quire-subtle:rgba(226,229,236,.5);--quire-accent:#8fb0ff;--quire-border:rgba(226,229,236,.14);--quire-surface:#1f2228;--quire-positive:#34d476;--quire-negative:#ff8a87;--quire-warning:#ffb466;--quire-chart-1:#3987e5;--quire-chart-2:#d95926;--quire-chart-3:#199e70;--quire-chart-4:#c98500;--quire-chart-5:#d55181;--quire-chart-6:#008300;--quire-chart-7:#9085e9;--quire-chart-8:#e66767";

pub const TAILWIND_THEME: &str = "@theme {\n  --color-bg: var(--quire-bg); --color-fg: var(--quire-fg); --color-muted: var(--quire-muted); --color-subtle: var(--quire-subtle);\n  --color-accent: var(--quire-accent); --color-line: var(--quire-border); --color-surface: var(--quire-surface);\n  --color-positive: var(--quire-positive); --color-negative: var(--quire-negative); --color-warning: var(--quire-warning);\n  --color-chart-1: var(--quire-chart-1); --color-chart-2: var(--quire-chart-2); --color-chart-3: var(--quire-chart-3); --color-chart-4: var(--quire-chart-4); --color-chart-5: var(--quire-chart-5); --color-chart-6: var(--quire-chart-6); --color-chart-7: var(--quire-chart-7); --color-chart-8: var(--quire-chart-8);\n  --font-sans: var(--quire-font); --font-mono: var(--quire-mono);\n}";

pub fn artifact_style() -> String {
    format!(
        "@layer theme, base, quire, components, utilities;\n@layer quire {{\n:root{{{LIGHT_VARS};--quire-font:-apple-system,BlinkMacSystemFont,\"SF Pro Text\",\"Helvetica Neue\",sans-serif;--quire-mono:ui-monospace,\"SF Mono\",Menlo,Consolas,monospace;--quire-radius:12px;color-scheme:light}}\n:root[data-scheme=dark]{{{DARK_VARS};color-scheme:dark}}\n{STYLE_RULES}\n}}"
    )
}

const STYLE_RULES: &str = r#"html,body{margin:0;background:var(--quire-bg);color:var(--quire-fg);font:400 16px/1.6 var(--quire-font);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;font-feature-settings:"kern"}
html{overflow-y:hidden}
:root:not([data-kind]){display:grid;justify-items:safe center}
:root:not([data-kind])>body{width:stretch;min-width:0;max-width:var(--quire-measure,720px)}
:root:not([data-kind])>body[data-wide]{max-width:min(100%,1080px)}
:where(:root:not([data-kind=react]), .q-prose) :where(h1){margin:0 0 12px;font:700 30px/1.15 var(--quire-font);letter-spacing:-.022em;text-wrap:balance}
:where(:root:not([data-kind=react]), .q-prose) :where(h2){margin:32px 0 10px;font:700 21px/1.3 var(--quire-font);letter-spacing:-.016em;text-wrap:balance}
:where(:root:not([data-kind=react]), .q-prose) :where(h3){margin:24px 0 8px;font:600 17px/1.35 var(--quire-font);letter-spacing:-.01em}
:where(:root:not([data-kind=react]), .q-prose) :where(p,ul,ol){margin:0 0 14px}
:where(:root:not([data-kind=react]), .q-prose) :where(ul,ol){padding-left:22px}
:where(:root:not([data-kind=react]), .q-prose) :where(li){margin:3px 0}
:where(:root:not([data-kind=react]), .q-prose) :where(li)::marker{color:var(--quire-subtle)}
:where(:root:not([data-kind=react]), .q-prose) :where(a){color:var(--quire-accent);text-decoration:underline;text-decoration-color:color-mix(in srgb,var(--quire-accent) 35%,transparent);text-underline-offset:3px}
:where(:root:not([data-kind=react]), .q-prose) :where(strong,b){font-weight:600}
:where(:root:not([data-kind=react]), .q-prose) :where(table){width:100%;margin:0 0 18px;border-collapse:collapse;font-size:14px}
:where(:root:not([data-kind=react]), .q-prose) :where(th){padding:8px 12px;border-bottom:1px solid var(--quire-border);color:var(--quire-muted);font:600 11.5px/16px var(--quire-font);letter-spacing:.06em;text-align:left;text-transform:uppercase}
:where(:root:not([data-kind=react]), .q-prose) :where(td){padding:9px 12px;border-bottom:1px solid var(--quire-border);vertical-align:top}
:where(:root:not([data-kind=react]), .q-prose) :where(code){font-family:var(--quire-mono);font-size:.88em}
:where(:root:not([data-kind=react]), .q-prose) :where(:not(pre)>code){padding:1px 5px;border-radius:5px;background:var(--quire-surface)}
:where(:root:not([data-kind=react]), .q-prose) :where(pre){margin:0 0 18px;padding:14px 16px;border-radius:10px;background:var(--quire-surface);font:13px/1.6 var(--quire-mono);overflow:auto}
:where(:root:not([data-kind=react]), .q-prose) :where(blockquote){margin:0 0 16px;padding:2px 0 2px 16px;border-left:2px solid var(--quire-accent);color:var(--quire-muted)}
:where(:root:not([data-kind=react]), .q-prose) :where(hr){margin:28px 0;border:0;border-top:1px solid var(--quire-border)}
:where(:root:not([data-kind=react]), .q-prose) :where(figure){margin:24px 0}
:where(:root:not([data-kind=react]), .q-prose) :where(figcaption){margin-top:8px;color:var(--quire-muted);font-size:12.5px;line-height:1.5}
:where(:root:not([data-kind=react]), .q-prose) :where(img,svg,video){max-width:100%;height:auto}
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
@media (prefers-reduced-motion:reduce){*,*::before,*::after{transition:none!important;animation:none!important}}"#;

const BRIDGE_SCRIPT: &str = r##"(() => {
  const post = (message) => parent.postMessage({ quire: 1, ...message }, "*");
  let last = 0;
  const report = () => {
    const height = Math.ceil(Math.max(document.documentElement.getBoundingClientRect().height, document.body ? document.body.scrollHeight : 0));
    if (height !== last) { last = height; post({ type: "size", height }); }
  };
  new ResizeObserver(report).observe(document.documentElement);
  addEventListener("load", report);
  addEventListener("message", (event) => {
    if (event.source !== parent || !event.data || event.data.quire !== 1 || event.data.type !== "theme") return;
    for (const [name, value] of Object.entries(event.data.vars || {})) if (/^--quire-[a-z-]+$/.test(name) && typeof value === "string") document.documentElement.style.setProperty(name, value);
    if (event.data.scheme === "dark" || event.data.scheme === "light") document.documentElement.dataset.scheme = event.data.scheme;
  });
  const material = (id, quote) => { if (/^[a-f0-9]{16}$/.test(String(id))) post({ type: "open-material", id: String(id), ...(quote ? { quote: String(quote) } : {}) }); };
  document.addEventListener("click", (event) => {
    const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!link) return;
    const href = link.getAttribute("href") || "";
    if (href.startsWith("#")) return;
    event.preventDefault();
    const cited = /^quire:material\/([a-f0-9]{16})$/.exec(href);
    if (cited) material(cited[1], link.getAttribute("data-quote"));
    else if (/^(https?:|mailto:)/.test(link.href)) post({ type: "open-link", url: link.href });
  }, true);
  const reportError = (message) => post({ type: "error", message: String(message).slice(0, 4000) });
  addEventListener("error", (event) => reportError(event.message || "Script error"));
  addEventListener("unhandledrejection", (event) => reportError(event.reason && event.reason.message ? event.reason.message : String(event.reason)));
  window.quire = Object.freeze({ openMaterial: material, reportError });
  post({ type: "ready" });
})();"##;

const SHOW_ERROR_JS: &str = r#"const quireShowError = (error) => {
  const message = error && error.message ? error.message : String(error);
  const root = document.getElementById("root") || document.body;
  const box = document.createElement("pre");
  box.setAttribute("style", "white-space:pre-wrap;font:13px/1.5 ui-monospace,monospace;color:var(--quire-muted);border:1px solid var(--quire-border);border-radius:8px;padding:12px;margin:16px");
  box.textContent = message;
  root.replaceChildren(box);
  if (window.quire) window.quire.reportError(message);
};"#;

fn script_safe(code: &str) -> String {
    Regex::new(r"(?i)</(script)")
        .unwrap()
        .replace_all(code, "<\\/$1")
        .replace("<!--", "<\\!--")
}

fn runtime_scripts(files: &[&str]) -> String {
    files
        .iter()
        .map(|f| format!("<script src=\"quire-artifact://runtime/{f}.js\"></script>"))
        .collect::<Vec<_>>()
        .join("")
}

pub fn react_document_from_compiled(compiled: &CompiledReact) -> String {
    let mut script_list = vec!["tailwind"];
    for f in &compiled.files {
        script_list.push(f.as_str());
    }
    let runner = format!(
        r#"(() => {{
  {SHOW_ERROR_JS}
  const modules = window.QuireModules || {{}};
  const require = (name) => {{
    let found = modules[name];
    if (!found && /^d3-/.test(name)) found = modules.d3;
    if (!found && /^lodash\//.test(name)) {{ const lodash = modules.lodash && modules.lodash.default; const fn = lodash && lodash[name.slice(7)]; if (fn) return fn; }}
    if (!found) throw new Error("Module not available in the artifact sandbox: " + name);
    return {{ __esModule: true, default: "default" in found ? found.default : found, ...found }};
  }};
  try {{
    const React = require("react");
    const {{ createRoot }} = require("react-dom/client");
    const module = {{ exports: {{}} }};
    (function (require, module, exports, React) {{
{}
    }})(require, module, module.exports, React);
    const App = module.exports.default;
    if (typeof App !== "function" && !(App && typeof App === "object")) throw new Error("A React artifact must export default its component.");
    class Boundary extends React.Component {{
      constructor(props) {{ super(props); this.state = {{ error: null }}; }}
      static getDerivedStateFromError(error) {{ return {{ error }}; }}
      componentDidCatch(error) {{ quireShowError(error); }}
      render() {{ return this.state.error ? null : this.props.children; }}
    }}
    createRoot(document.getElementById("root")).render(React.createElement(Boundary, null, React.createElement(App)));
  }} catch (error) {{ quireShowError(error); }}
}})();"#,
        script_safe(&compiled.code)
    );
    format!(
        "<!doctype html><html data-kind=\"react\"><head><style type=\"text/tailwindcss\">{TAILWIND_THEME}</style>{}</head><body><div id=\"root\"></div><script>{runner}</script></body></html>",
        runtime_scripts(&script_list)
    )
}

pub fn mermaid_document(source: &str) -> String {
    let encoded_source = script_safe(&serde_json::to_string(source).unwrap_or_else(|_| "\"\"".into()));
    let runner = format!(
        r##"(() => {{
  {SHOW_ERROR_JS}
  const source = {encoded_source};
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const pen = canvas.getContext("2d", {{ willReadFrequently: true }});
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const solid = (color, strength = 1) => {{
    pen.globalAlpha = 1; pen.fillStyle = "#808080"; pen.fillStyle = css("--quire-bg") || "#ffffff"; pen.fillRect(0, 0, 1, 1);
    pen.globalAlpha = strength; pen.fillStyle = color; pen.fillRect(0, 0, 1, 1);
    const [r, g, b] = pen.getImageData(0, 0, 1, 1).data;
    return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
  }};
  const themeVariables = () => {{
    const accent = css("--quire-accent"), fg = css("--quire-fg"), muted = css("--quire-muted"), warning = css("--quire-warning");
    const chart = Array.from({{ length: 8 }}, (_, i) => solid(css("--quire-chart-" + (i + 1))));
    const vars = {{
      darkMode: document.documentElement.dataset.scheme === "dark", background: solid(css("--quire-bg")), fontFamily: css("--quire-font"), fontSize: "16px",
      primaryColor: solid(accent, .1), primaryBorderColor: solid(accent, .55), primaryTextColor: solid(fg), mainBkg: solid(accent, .1), nodeBorder: solid(accent, .55),
      secondaryColor: solid(chart[1], .14), secondaryBorderColor: solid(chart[1], .55), secondaryTextColor: solid(fg),
      tertiaryColor: solid(css("--quire-surface")), tertiaryBorderColor: solid(css("--quire-border")), tertiaryTextColor: solid(fg),
      lineColor: solid(muted), textColor: solid(fg), titleColor: solid(fg), edgeLabelBackground: solid(css("--quire-bg")),
      clusterBkg: solid(css("--quire-surface")), clusterBorder: solid(css("--quire-border")),
      noteBkgColor: solid(warning, .12), noteBorderColor: solid(warning, .5), noteTextColor: solid(fg),
      actorBkg: solid(accent, .1), actorBorder: solid(accent, .55), actorTextColor: solid(fg), signalColor: solid(muted), signalTextColor: solid(fg),
      labelBoxBkgColor: solid(css("--quire-surface")), labelBoxBorderColor: solid(css("--quire-border")),
      sectionBkgColor: solid(accent, .08), altSectionBkgColor: solid(css("--quire-bg")), taskBkgColor: solid(accent, .55), taskBorderColor: solid(accent), activeTaskBkgColor: solid(chart[1], .7), doneTaskBkgColor: solid(muted, .35), gridColor: solid(css("--quire-border")),
      pieStrokeColor: solid(css("--quire-bg")), pieOuterStrokeColor: solid(css("--quire-border")), pieTitleTextColor: solid(fg), pieSectionTextColor: "#ffffff", pieLegendTextColor: solid(fg),
    }};
    chart.forEach((color, i) => {{ vars["pie" + (i + 1)] = color; vars["cScale" + i] = solid(color, .2); vars["cScaleLabel" + i] = solid(fg); vars["git" + i] = color; }});
    return vars;
  }};
  let drawn = 0, last = "";
  const draw = async () => {{
    const root = document.getElementById("root");
    const variables = themeVariables();
    const key = JSON.stringify(variables);
    if (key === last) return;
    last = key;
    window.mermaid.initialize({{ startOnLoad: false, securityLevel: "strict", theme: "base", themeVariables: variables, fontFamily: variables.fontFamily, flowchart: {{ curve: "basis", padding: 14, htmlLabels: true }}, sequence: {{ mirrorActors: false }} }});
    try {{
      const {{ svg }} = await window.mermaid.render("quire-diagram-" + (drawn += 1), source);
      root.innerHTML = svg;
    }} catch (error) {{ last = ""; quireShowError(error); }}
  }};
  addEventListener("message", (event) => {{
    if (event.source !== parent || !event.data || event.data.quire !== 1 || event.data.type !== "theme") return;
    setTimeout(draw, 0);
  }});
  draw();
}})();"##
    );
    format!(
        "<!doctype html><html data-kind=\"mermaid\"><head>{}<style>#root{{display:flex;justify-content:center;padding:12px 0 16px}}#root svg{{max-width:100%;height:auto}}</style></head><body><div id=\"root\"></div><script>{runner}</script></body></html>",
        runtime_scripts(&["mermaid"])
    )
}

pub fn artifact_page(source: &str, dark: bool) -> String {
    let scheme_str = if dark { "\"dark\"" } else { "\"light\"" };
    let head = format!(
        "<meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"{ARTIFACT_CSP}\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><style>{}</style><script>document.documentElement.dataset.scheme={scheme_str}</script><script>{BRIDGE_SCRIPT}</script>",
        artifact_style()
    );
    let head_re = Regex::new(r"(?i)<head(\s[^>]*)?>").unwrap();
    if let Some(m) = head_re.find(source) {
        return format!("{}{head}{}", &source[..m.end()], &source[m.end()..]);
    }
    let html_re = Regex::new(r"(?i)<html(\s[^>]*)?>").unwrap();
    if let Some(m) = html_re.find(source) {
        return format!("{}<head>{head}</head>{}", &source[..m.end()], &source[m.end()..]);
    }
    format!("<!doctype html><html><head>{head}</head><body>{source}</body></html>")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArtifactUrlTarget {
    pub id: String,
    pub dark: bool,
    pub version: Option<u32>,
}

pub fn parse_artifact_url(raw: &str) -> Option<ArtifactUrlTarget> {
    let parsed = Url::parse(raw).ok()?;
    let is_artifact = (parsed.scheme() == "quire-artifact" && parsed.host_str() == Some("artifact"))
        || ((parsed.scheme() == "http" || parsed.scheme() == "https")
            && parsed.host_str() == Some("quire-artifact.localhost")
            && parsed.path().starts_with("/artifact/"));
    if !is_artifact {
        return None;
    }
    let trimmed = parsed
        .path()
        .trim_start_matches("/artifact")
        .trim_matches('/');
    if !valid_hex_16(trimmed) {
        return None;
    }
    let mut dark = false;
    let mut version = None;
    for (k, v) in parsed.query_pairs() {
        if k == "scheme" && v == "dark" {
            dark = true;
        } else if k == "v" {
            if let Ok(n) = v.parse::<u32>() {
                if n >= 1 {
                    version = Some(n);
                }
            }
        }
    }
    Some(ArtifactUrlTarget {
        id: trimmed.to_string(),
        dark,
        version,
    })
}

pub fn parse_runtime_url(raw: &str) -> Option<String> {
    let parsed = Url::parse(raw).ok()?;
    let path = if parsed.scheme() == "quire-artifact" && parsed.host_str() == Some("runtime") {
        parsed.path().trim_start_matches('/')
    } else if (parsed.scheme() == "http" || parsed.scheme() == "https")
        && parsed.host_str() == Some("quire-artifact.localhost")
    {
        parsed.path().strip_prefix("/runtime/")?
    } else {
        return None;
    };
    let name = path.strip_suffix(".js")?;
    if RUNTIME_FILES.contains(&name) {
        Some(name.to_string())
    } else {
        None
    }
}

pub fn image_protocol_response(url: &str, cache: &ImageCache) -> Response<Vec<u8>> {
    let make = |status: StatusCode, content_type: &str, body: Vec<u8>| {
        Response::builder()
            .status(status)
            .header(header::CONTENT_TYPE, content_type)
            .header("x-content-type-options", "nosniff")
            .header(header::CONTENT_SECURITY_POLICY, IMAGE_RESPONSE_CSP)
            .header(header::CACHE_CONTROL, "no-store")
            .body(body)
            .unwrap()
    };

    match parse_image_url(url) {
        Some(ImageTarget::Cache { key }) => match cache.stored(&key) {
            Ok(Some(img)) => make(StatusCode::OK, &img.media_type, img.bytes),
            Ok(None) => make(StatusCode::NOT_FOUND, "text/plain; charset=utf-8", b"Not found".to_vec()),
            Err(err) => {
                eprintln!("[images] {url}: {err}");
                make(StatusCode::INTERNAL_SERVER_ERROR, "text/plain; charset=utf-8", err.into_bytes())
            }
        },
        Some(ImageTarget::Figure { figure }) => match cache.figure(&figure) {
            Ok(Some(png)) => make(StatusCode::OK, "image/png", png),
            Ok(None) => make(StatusCode::NOT_FOUND, "text/plain; charset=utf-8", b"Not found".to_vec()),
            Err(err) => {
                eprintln!("[images] {url}: {err}");
                make(StatusCode::INTERNAL_SERVER_ERROR, "text/plain; charset=utf-8", err.into_bytes())
            }
        },
        None => make(StatusCode::NOT_FOUND, "text/plain; charset=utf-8", b"Not found".to_vec()),
    }
}

pub async fn artifact_protocol_response(
    url: &str,
    store: &MaterialStore,
    normalizer: &dyn Normalizer,
    runtime_dirs: &[&Path],
) -> Response<Vec<u8>> {
    let not_found = || {
        Response::builder()
            .status(StatusCode::NOT_FOUND)
            .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
            .header("x-content-type-options", "nosniff")
            .body(b"Not found".to_vec())
            .unwrap()
    };

    if let Some(runtime_name) = parse_runtime_url(url) {
        for dir in runtime_dirs {
            let candidate = dir.join(format!("{runtime_name}.js"));
            if let Ok(bytes) = fs::read(candidate) {
                return Response::builder()
                    .status(StatusCode::OK)
                    .header(header::CONTENT_TYPE, "text/javascript; charset=utf-8")
                    .header(header::CACHE_CONTROL, "max-age=86400")
                    .header("x-content-type-options", "nosniff")
                    .body(bytes)
                    .unwrap();
            }
        }
        return not_found();
    }

    let Some(target) = parse_artifact_url(url) else {
        return not_found();
    };
    let Ok(Some((_, info, source, _))) = store.artifact_at(&target.id, target.version) else {
        return not_found();
    };
    if !matches!(info.artifact_type.as_str(), "html" | "react" | "mermaid") {
        return not_found();
    }

    let doc = match info.artifact_type.as_str() {
        "mermaid" => mermaid_document(&source),
        "react" => match normalizer.compile_react(&source).await {
            Ok(compiled) => react_document_from_compiled(&compiled),
            Err(err) => {
                let msg = serde_json::to_string(&err).unwrap_or_else(|_| "\"Compile error\"".into()).replace('<', "\\u003c");
                format!(
                    "<!doctype html><html><head></head><body><div id=\"root\"></div><script>document.getElementById(\"root\").textContent = {msg}; window.quire.reportError({msg});</script></body></html>"
                )
            }
        },
        _ => source,
    };

    let page = artifact_page(&doc, target.dark);
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(header::CONTENT_SECURITY_POLICY, ARTIFACT_CSP)
        .header(header::CACHE_CONTROL, "no-store")
        .header("x-content-type-options", "nosniff")
        .body(page.into_bytes())
        .unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_artifact_and_runtime_urls_and_wraps_csp() {
        assert_eq!(
            parse_artifact_url("quire-artifact://artifact/0123456789abcdef?v=2&scheme=dark"),
            Some(ArtifactUrlTarget {
                id: "0123456789abcdef".into(),
                dark: true,
                version: Some(2),
            })
        );
        assert_eq!(
            parse_runtime_url("quire-artifact://runtime/recharts.js").as_deref(),
            Some("recharts")
        );
        assert_eq!(parse_runtime_url("quire-artifact://runtime/evil.js"), None);

        let wrapped = artifact_page("<div>Hello</div>", true);
        assert!(wrapped.contains(ARTIFACT_CSP));
        assert!(wrapped.contains("dataset.scheme=\"dark\""));
        assert!(wrapped.contains("<div>Hello</div>"));
    }
}
