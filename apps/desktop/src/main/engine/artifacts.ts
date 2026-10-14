import type { ArtifactInfo, ArtifactType, CanvasArtifactType, MaterialViewContent } from "../../shared/contracts";
import { compileReact } from "../artifact-runtime";
import { markdownParts, withoutTitleHeading, type ContentFields } from "./material-content";
import type { StoredRecord } from "./material-record";
import { readingMinutes } from "./reading-time";

// What an agent artifact is made of, apart from the store: its types and their media types, the
// content fields each type renders from, plain text for search, and the one edit an update makes.
// Markdown and code go through the reader pipeline; the other types keep their source and render as
// the "artifact" view: HTML, React and Mermaid in a sandboxed frame (artifact-protocol.ts), SVG as an image.

export const ARTIFACT_TYPES: readonly ArtifactType[] = ["markdown", "code", "html", "svg", "react", "mermaid"];
export const ARTIFACT_MEDIA_TYPE: Record<CanvasArtifactType, string> = {
  html: "application/vnd.quire.artifact+html", svg: "application/vnd.quire.artifact+svg",
  react: "application/vnd.quire.artifact+react", mermaid: "application/vnd.quire.artifact+mermaid",
};

export function isCanvasArtifactType(type: ArtifactType): type is CanvasArtifactType {
  return type !== "markdown" && type !== "code";
}
export const MAX_ARTIFACT_SOURCE = 400_000;

export function isArtifactType(value: unknown): value is ArtifactType {
  return typeof value === "string" && (ARTIFACT_TYPES as readonly string[]).includes(value);
}

export function isArtifactMediaType(mediaType: string): boolean {
  return Object.values(ARTIFACT_MEDIA_TYPE).includes(mediaType);
}

/** The artifact info of a record; an artifact written before types is Markdown at version 1. */
export function artifactInfoOf(record: Pick<StoredRecord, "origin" | "artifact" | "fetchedAt">): ArtifactInfo | undefined {
  if (record.origin !== "agent") return undefined;
  return record.artifact ?? { type: "markdown", version: 1, updatedAt: record.fetchedAt };
}

/** The source an update edits: the stored source, or for an artifact written before sources were kept, its Markdown. */
export function artifactSourceOf(record: Pick<StoredRecord, "artifactSource" | "markdown">): string | undefined {
  return record.artifactSource ?? record.markdown;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };

/** The words of an HTML or SVG source, for search and reading time: no scripts, styles, tags or comments. */
export function textOfMarkup(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|template)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (entity, name: string) => {
      if (name.startsWith("#x") || name.startsWith("#X")) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
      if (name.startsWith("#")) return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
      return ENTITIES[name.toLowerCase()] ?? entity;
    })
    .replace(/\s+/g, " ")
    .trim();
}

/** The words a React component shows: its JSX text and string literals, without the code around them. */
export function textOfComponent(source: string): string {
  const words: string[] = [];
  for (const match of source.matchAll(/>([^<>{}]+)</g)) words.push(match[1]!);
  // String literals that read as words: not import paths, keys or lists of class names.
  for (const match of source.matchAll(/(["'`])((?:(?!\1)[^\\\n]|\\.){3,})\1/g)) {
    const text = match[2]!;
    if (/[\p{L}]{2}/u.test(text) && !text.split(/\s+/).every((token) => /^[a-z0-9:./@#%[\]-]*$/.test(token))) words.push(text);
  }
  return words.join(" ").replace(/\s+/g, " ").trim();
}

/** A fence long enough that no run of backticks in the code closes it. */
function fenceFor(code: string): string {
  const longest = Math.max(2, ...[...code.matchAll(/`+/g)].map((match) => match[0].length));
  return "`".repeat(longest + 1);
}

/** Why a source cannot be saved as this type, or undefined when it can. */
export function artifactSourceProblem(type: ArtifactType, source: string): string | undefined {
  if (!source.trim()) return "The artifact is empty.";
  if (source.length > MAX_ARTIFACT_SOURCE) return `The artifact is longer than ${MAX_ARTIFACT_SOURCE} characters.`;
  if (type === "svg" && !/<svg[\s>]/i.test(source)) return "An SVG artifact must contain an <svg> element.";
  if (type === "html" && !/<[a-z][\s\S]*>/i.test(source)) return "An HTML artifact must contain HTML markup.";
  if (type === "react") {
    try { compileReact(source); } catch (error) { return error instanceof Error ? error.message : String(error); }
  }
  return undefined;
}

export type ArtifactContent = ContentFields & { artifactSource: string };

/** The content fields an artifact of this type renders from; `url` is the artifact's own, for the reader's links. */
export function artifactContent(input: { type: ArtifactType; source: string; title: string; language?: string | undefined; url: string }): ArtifactContent {
  const { type, source, title, language, url } = input;
  if (type === "markdown") return { mediaType: "text/markdown", ...markdownParts(withoutTitleHeading(source, title), url), artifactSource: source };
  if (type === "code") {
    const fence = fenceFor(source);
    return { mediaType: "text/markdown", ...markdownParts(`${fence}${language ?? ""}\n${source}\n${fence}`, url), artifactSource: source };
  }
  const plain = type === "react" ? textOfComponent(source) : type === "mermaid" ? source.replace(/\s+/g, " ").trim() : textOfMarkup(source);
  return {
    mediaType: ARTIFACT_MEDIA_TYPE[type], artifactSource: source, readingMinutes: readingMinutes(plain), problems: [],
    ...(plain ? { plain } : {}),
    quality: { completeness: "declared_full", conformance: "conformant", identityConfidence: "derived", safety: "safe", warnings: [] },
  };
}

/** The artifact view's content fields for a record whose type renders outside the reader; none otherwise. */
export function artifactViewOf(record: Pick<StoredRecord, "origin" | "artifact" | "artifactSource" | "fetchedAt">): Pick<MaterialViewContent, "artifactBody"> {
  const info = artifactInfoOf(record);
  if (!info || !isCanvasArtifactType(info.type) || record.artifactSource === undefined) return {};
  return { artifactBody: { type: info.type, source: record.artifactSource, version: info.version } };
}

/**
 * The source with one exact passage replaced. The passage must occur exactly once, so the edit lands
 * where the agent meant it; otherwise the error says how often it occurs, for the agent to widen it.
 */
export function applyArtifactEdit(source: string, oldText: string, newText: string): string {
  if (!oldText) throw new Error("old_str must not be empty.");
  const first = source.indexOf(oldText);
  if (first === -1) throw new Error("old_str does not occur in the artifact. Read it again with material_read and copy the passage exactly, whitespace included.");
  if (source.indexOf(oldText, first + 1) !== -1) throw new Error("old_str occurs more than once in the artifact. Include more of the surrounding text so it is unique.");
  return source.slice(0, first) + newText + source.slice(first + oldText.length);
}
