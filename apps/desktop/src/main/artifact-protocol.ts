// The sandbox an HTML artifact runs in. The renderer embeds it as
// <iframe sandbox="allow-scripts" src="quire-artifact://artifact/<id>?v=<version>">: without
// allow-same-origin the frame has an opaque origin (no storage, no access to the app or its
// bridge), and the page's Content-Security-Policy lets its own inline scripts and styles run but
// loads nothing from anywhere and connects nowhere. A small bridge script, added in front of the
// artifact, reports the page's height and hands links and citations to the reader by postMessage;
// the reader answers with its theme as CSS variables, and hears about errors the artifact hits.
// Main also refuses any subframe navigation away from this scheme (index.ts), so a link inside an
// artifact cannot open the web in the frame. The libraries React and Mermaid artifacts run on are
// served from the same scheme (artifact-runtime.ts), the only scripts a page may load.

import type { ArtifactType } from "../shared/contracts";
import { mermaidDocument, reactDocument, RUNTIME_FILES, RUNTIME_HOST, type RuntimeFile } from "./artifact-runtime";

export const ARTIFACT_SCHEME = "quire-artifact";

/** The artifact types the sandbox serves. */
export type FramedArtifactType = Extract<ArtifactType, "html" | "react" | "mermaid">;

export const ARTIFACT_CSP = [
  "default-src 'none'",
  // Eval adds nothing an inline script cannot do in an opaque, offline frame, and some libraries need it (d3's CSV parser).
  `script-src 'unsafe-inline' 'unsafe-eval' ${ARTIFACT_SCHEME}://${RUNTIME_HOST}`,
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "media-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "base-uri 'none'",
].join("; ");

/** The theme an artifact starts with, before the reader sends its own colours; `dark` follows the app. */
function baseStyle(dark: boolean): string {
  const palette = dark
    ? "--quire-bg:#191b20;--quire-fg:#f2f3f7;--quire-muted:rgba(226,229,236,.68);--quire-accent:#8fb0ff;--quire-border:rgba(226,229,236,.14);color-scheme:dark;"
    : "--quire-bg:#ffffff;--quire-fg:#0f1115;--quire-muted:rgba(28,32,40,.68);--quire-accent:#2653c4;--quire-border:rgba(28,32,40,.12);color-scheme:light;";
  return `:root{${palette}--quire-font:-apple-system,BlinkMacSystemFont,"Helvetica Neue",sans-serif}`
    + "html,body{margin:0;background:var(--quire-bg);color:var(--quire-fg);font-family:var(--quire-font)}a{color:var(--quire-accent)}";
}

/** Runs before the artifact's own scripts; the only channel out of the sandbox. */
const BRIDGE = `(() => {
  const post = (message) => parent.postMessage({ quire: 1, ...message }, "*");
  let last = 0;
  const report = () => {
    const height = Math.ceil(Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0));
    if (height !== last) { last = height; post({ type: "size", height }); }
  };
  new ResizeObserver(report).observe(document.documentElement);
  addEventListener("load", report);
  addEventListener("message", (event) => {
    if (event.source !== parent || !event.data || event.data.quire !== 1 || event.data.type !== "theme") return;
    for (const [name, value] of Object.entries(event.data.vars || {})) if (/^--quire-[a-z-]+$/.test(name) && typeof value === "string") document.documentElement.style.setProperty(name, value);
    if (event.data.scheme === "dark" || event.data.scheme === "light") document.documentElement.style.colorScheme = event.data.scheme;
  });
  const material = (id, quote) => { if (/^[a-f0-9]{16}$/.test(String(id))) post({ type: "open-material", id: String(id), ...(quote ? { quote: String(quote) } : {}) }); };
  document.addEventListener("click", (event) => {
    const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!link) return;
    const href = link.getAttribute("href") || "";
    if (href.startsWith("#")) return;
    event.preventDefault();
    const cited = /^quire:material\\/([a-f0-9]{16})$/.exec(href);
    if (cited) material(cited[1], link.getAttribute("data-quote"));
    else if (/^(https?:|mailto:)/.test(link.href)) post({ type: "open-link", url: link.href });
  }, true);
  const reportError = (message) => post({ type: "error", message: String(message).slice(0, 4000) });
  addEventListener("error", (event) => reportError(event.message || "Script error"));
  addEventListener("unhandledrejection", (event) => reportError(event.reason && event.reason.message ? event.reason.message : String(event.reason)));
  window.quire = Object.freeze({ openMaterial: material, reportError });
  post({ type: "ready" });
})();`;

/**
 * The page served for an artifact: the CSP as a meta tag (the response header carries it too), the
 * base theme and the bridge, then the artifact itself. A full document gets them at the start of its
 * <head>; a fragment is wrapped in a document of its own.
 */
export function artifactPage(source: string, options: { dark: boolean }): string {
  const head = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${baseStyle(options.dark)}</style><script>${BRIDGE}</script>`;
  const headTag = /<head(\s[^>]*)?>/i.exec(source);
  if (headTag) return source.slice(0, headTag.index + headTag[0].length) + head + source.slice(headTag.index + headTag[0].length);
  const htmlTag = /<html(\s[^>]*)?>/i.exec(source);
  if (htmlTag) return source.slice(0, htmlTag.index + htmlTag[0].length) + `<head>${head}</head>` + source.slice(htmlTag.index + htmlTag[0].length);
  return `<!doctype html><html><head>${head}</head><body>${source}</body></html>`;
}

/** The artifact id and options a quire-artifact:// URL names, or undefined when it names nothing servable. */
export function parseArtifactUrl(url: string): { id: string; dark: boolean; version?: number } | undefined {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return undefined; }
  if (parsed.protocol !== `${ARTIFACT_SCHEME}:` || parsed.hostname !== "artifact") return undefined;
  const id = /^\/([a-f0-9]{16})\/?$/.exec(parsed.pathname)?.[1];
  if (!id) return undefined;
  const version = Number(parsed.searchParams.get("v"));
  return { id, dark: parsed.searchParams.get("scheme") === "dark", ...(Number.isInteger(version) && version >= 1 ? { version } : {}) };
}

/** The runtime file a quire-artifact://runtime/<file>.js URL names, or undefined. */
export function parseRuntimeUrl(url: string): RuntimeFile | undefined {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return undefined; }
  if (parsed.protocol !== `${ARTIFACT_SCHEME}:` || parsed.hostname !== RUNTIME_HOST) return undefined;
  const file = /^\/([a-z0-9]+)\.js$/.exec(parsed.pathname)?.[1];
  return (RUNTIME_FILES as readonly string[]).includes(file ?? "") ? (file as RuntimeFile) : undefined;
}

/** The document an artifact of this type runs as, before the head is added; a React artifact that does not compile shows why. */
export function artifactDocument(type: FramedArtifactType, source: string, dark: boolean): string {
  if (type === "mermaid") return mermaidDocument(source, dark);
  if (type === "react") {
    try { return reactDocument(source); } catch (error) {
      const message = JSON.stringify(error instanceof Error ? error.message : String(error)).replace(/</g, "\\u003c");
      return `<!doctype html><html><head></head><body><div id="root"></div><script>document.getElementById("root").textContent = ${message}; window.quire.reportError(${message});</script></body></html>`;
    }
  }
  return source;
}

export interface ArtifactSources {
  /** The type and source of a framed artifact at a version (its current one when omitted), undefined when there is none. */
  artifact: (id: string, version?: number) => Promise<{ type: FramedArtifactType; source: string } | undefined>;
  /** A runtime file's script, undefined when it is not built. */
  runtime: (file: RuntimeFile) => Promise<string | undefined>;
}

const NOT_FOUND = () => new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });

/** The response for a quire-artifact:// request: an artifact's page, or a runtime library. */
export async function artifactResponse(url: string, sources: ArtifactSources): Promise<Response> {
  const file = parseRuntimeUrl(url);
  if (file) {
    const script = await sources.runtime(file);
    if (script === undefined) return NOT_FOUND();
    return new Response(script, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "max-age=86400", "x-content-type-options": "nosniff" } });
  }
  const target = parseArtifactUrl(url);
  const artifact = target ? await sources.artifact(target.id, target.version) : undefined;
  if (!target || !artifact) return NOT_FOUND();
  return new Response(artifactPage(artifactDocument(artifact.type, artifact.source, target.dark), { dark: target.dark }), {
    headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": ARTIFACT_CSP, "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}
