import { useEffect, useMemo, useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import { Button } from "@read/ui";
import type { MaterialRecord, MaterialViewContent } from "../../shared/contracts";
import { ArtifactSources, useArtifactCitations } from "./ArtifactCitations";

// An agent artifact that is not a text document. HTML, React and Mermaid run in the sandbox main
// serves on quire-artifact:// (artifact-protocol.ts): an opaque-origin frame whose only way out is
// postMessage. This side answers that bridge: the frame's height, the reader's theme as CSS
// variables, links and citations, which open here only after they are checked, and the errors the
// artifact hits, which the reader can hand to the agent to fix. SVG is drawn as an image, which runs
// no scripts and loads nothing.

const MIN_HEIGHT = 160;
const MAX_HEIGHT = 40_000;
const MATERIAL_ID = /^[a-f0-9]{16}$/;
const EXTERNAL = /^(https?:|mailto:)/;

type OpenMaterial = (id: string, quote?: string) => void;

/** Whether the app is drawn dark: the reader's theme when one is chosen, the system's otherwise. */
function isDark(): boolean {
  const theme = document.documentElement.dataset.theme;
  if (theme) return theme === "dark";
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

/** The reader's colours and font as the --quire-* variables an artifact styles itself with. */
export function artifactTheme(): { scheme: "dark" | "light"; vars: Record<string, string> } {
  const root = getComputedStyle(document.documentElement);
  const body = document.querySelector(".reader-body");
  const pick = (name: string) => root.getPropertyValue(name).trim();
  const vars: Record<string, string> = {
    "--quire-bg": pick("--content"), "--quire-fg": pick("--label"), "--quire-muted": pick("--label-2"),
    "--quire-accent": pick("--accent-text"), "--quire-border": pick("--separator"),
    "--quire-font": body ? getComputedStyle(body).fontFamily : "",
  };
  return { scheme: isDark() ? "dark" : "light", vars: Object.fromEntries(Object.entries(vars).filter(([, value]) => value)) };
}

interface BridgeMessage { quire: 1; type: string; height?: unknown; id?: unknown; quote?: unknown; url?: unknown; message?: unknown }

function isBridgeMessage(data: unknown): data is BridgeMessage {
  return typeof data === "object" && data !== null && (data as { quire?: unknown }).quire === 1 && typeof (data as { type?: unknown }).type === "string";
}

/** An HTML, React or Mermaid artifact in its sandbox, as tall as its content. */
export function ArtifactFrame({ id, version, title, onOpenLink, onOpenMaterial, onError }: { id: string; version: number; title: string; onOpenLink: (url: string) => void; onOpenMaterial: OpenMaterial; onError?: ((message: string) => void) | undefined }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(480);
  // The first paint takes the app's scheme from the URL; later theme changes arrive as a message, without a reload.
  const src = useMemo(() => `quire-artifact://artifact/${id}?v=${version}&scheme=${isDark() ? "dark" : "light"}`, [id, version]);
  const handlers = useRef({ onOpenLink, onOpenMaterial, onError });
  handlers.current = { onOpenLink, onOpenMaterial, onError };

  useEffect(() => {
    const sendTheme = () => frame.current?.contentWindow?.postMessage({ quire: 1, type: "theme", ...artifactTheme() }, "*");
    const onMessage = (event: MessageEvent) => {
      if (!frame.current || event.source !== frame.current.contentWindow || !isBridgeMessage(event.data)) return;
      const message = event.data;
      if (message.type === "ready") sendTheme();
      else if (message.type === "size" && typeof message.height === "number" && Number.isFinite(message.height)) setHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(message.height))));
      else if (message.type === "open-material" && typeof message.id === "string" && MATERIAL_ID.test(message.id)) {
        const quote = typeof message.quote === "string" && message.quote.trim() ? message.quote.trim().slice(0, 2000) : undefined;
        if (quote) handlers.current.onOpenMaterial(message.id, quote); else handlers.current.onOpenMaterial(message.id);
      } else if (message.type === "open-link" && typeof message.url === "string" && EXTERNAL.test(message.url)) handlers.current.onOpenLink(message.url);
      else if (message.type === "error" && typeof message.message === "string" && message.message.trim()) handlers.current.onError?.(message.message.trim().slice(0, 4000));
    };
    window.addEventListener("message", onMessage);
    // The reader's theme can change while the artifact is open: an explicit choice, or the system's.
    const themes = new MutationObserver(sendTheme);
    themes.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
    const system = window.matchMedia?.("(prefers-color-scheme: dark)");
    system?.addEventListener?.("change", sendTheme);
    return () => { window.removeEventListener("message", onMessage); themes.disconnect(); system?.removeEventListener?.("change", sendTheme); };
  }, []);

  return (
    <iframe
      ref={frame}
      src={src}
      title={title}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      data-artifact-frame=""
      className="block w-full border-0 bg-transparent"
      style={{ height }}
    />
  );
}

/** An error the artifact hit, and the way to hand it to the agent. */
export function ArtifactError({ message, onFix }: { message: string; onFix?: ((message: string) => void) | undefined }) {
  const [asked, setAsked] = useState(false);
  return (
    <div role="alert" className="t-text-in mb-3 grid gap-1.5 rounded-card bg-orange-soft p-3 text-[13px] text-label-2">
      <strong className="text-[13px] text-label">This artifact hit an error.</strong>
      <code className="line-clamp-3 whitespace-pre-wrap break-words text-[12px]">{message}</code>
      {onFix ? (asked
        ? <span className="t-text-in">Asked the agent to fix it; follow along in the Agent panel.</span>
        : <span><Button size="sm" className="gap-1" onPress={() => { setAsked(true); onFix(message); }}><Sparkles />Ask the agent to fix it</Button></span>) : null}
    </div>
  );
}

/**
 * The body of an artifact that renders outside the reader, in the reader: the artifact itself at the
 * column's full width, then its sources. Text artifacts (Markdown, code) render through the reader
 * instead (ArtifactCitations).
 */
export function ArtifactCanvas({ material, artifact, onOpenLink, onOpenMaterial, onFix }: { material: Pick<MaterialRecord, "id" | "title" | "lineage">; artifact: NonNullable<MaterialViewContent["artifactBody"]>; onOpenLink: (url: string) => void; onOpenMaterial: OpenMaterial; onFix?: ((message: string) => void) | undefined }) {
  // The materials the artifact links to (quire:material/<id>) are its citations, numbered in the order they first appear.
  const cited = useMemo(() => [...artifact.source.matchAll(/quire:material\/([a-f0-9]{16})/g)].map((match) => `[${match[1]}]`).join(" "), [artifact.source]);
  const { sources, loaded } = useArtifactCitations(material, cited, onOpenMaterial);
  const [error, setError] = useState<{ version: number; message: string } | undefined>(undefined);
  // An error belongs to the version that hit it; a new version starts clean.
  const shown = error?.version === artifact.version ? error.message : undefined;
  return (
    <div className="artifact-canvas" data-artifact-type={artifact.type}>
      {shown ? <ArtifactError key={`${material.id}:${artifact.version}`} message={shown} onFix={onFix} /> : null}
      {artifact.type === "svg"
        ? <img className="mx-auto block h-auto max-w-full" alt={material.title} src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(artifact.source)}`} />
        : <ArtifactFrame id={material.id} version={artifact.version} title={material.title} onOpenLink={onOpenLink} onOpenMaterial={onOpenMaterial} onError={(message) => setError({ version: artifact.version, message })} />}
      <div className="reader-body">
        <ArtifactSources sources={sources} loaded={loaded} onOpenMaterial={onOpenMaterial} />
      </div>
    </div>
  );
}
