import type {
  NormalizedFeedMedia,
  NormalizedFeedTranscriptRef,
  NormalizedMediaChapter,
} from "./model";
import { ATOM_NAMESPACE, attribute, type XmlNode } from "./xml";

const ITUNES_NAMESPACES = new Set([
  "http://www.itunes.com/dtds/podcast-1.0.dtd",
  "https://www.itunes.com/dtds/podcast-1.0.dtd",
]);
const PODCAST_NAMESPACES = new Set([
  "https://podcastindex.org/namespace/1.0",
  "http://podcastindex.org/namespace/1.0",
]);
const YT_NAMESPACES = new Set(["http://www.youtube.com/xml/schemas/2015"]);
const MEDIA_NAMESPACES = new Set([
  "http://search.yahoo.com/mrss/",
  "https://search.yahoo.com/mrss/",
]);

const MAX_DURATION_SECONDS = 7 * 24 * 3600;
const YOUTUBE_VIDEO_ID = /^[\w-]{11}$/u;
const AUDIO_EXT = /\.(?:mp3|m4a|aac|ogg|oga|opus|wav|flac)(?:$|[?#])/iu;
const VIDEO_EXT = /\.(?:mp4|m4v|mov|webm)(?:$|[?#])/iu;

function nsChildren(node: XmlNode, localName: string, namespaces: ReadonlySet<string>): XmlNode[] {
  return node.children.filter(
    (item) => item.localName === localName && namespaces.has(item.namespaceUri),
  );
}

function nsChild(node: XmlNode, localName: string, namespaces: ReadonlySet<string>): XmlNode | undefined {
  return nsChildren(node, localName, namespaces)[0];
}

function nodeText(node: XmlNode | undefined): string {
  return node ? node.textParts.join("").replace(/\s+/gu, " ").trim() : "";
}

function rawNodeText(node: XmlNode | undefined): string {
  return node ? node.textParts.join("").trim() : "";
}

/**
 * Parses `itunes:duration` or `HH:MM:SS` / `MM:SS` / `SS` strings into positive whole seconds.
 */
export function parseDurationSeconds(raw: string | undefined): number | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (/^\d+(?:\.\d+)?$/u.test(value)) {
    const seconds = Math.round(Number(value));
    return seconds > 0 && seconds <= MAX_DURATION_SECONDS ? seconds : undefined;
  }
  const parts = /^(\d{1,3}):([0-5]\d)(?::([0-5]\d(?:\.\d+)?)|(\.\d+))?$/u.exec(value);
  if (!parts) return undefined;
  const [, first, second, third, secondFraction] = parts;
  const total = third !== undefined
    ? Number(first) * 3600 + Number(second) * 60 + Number(third)
    : Number(first) * 60 + Number(`${second}${secondFraction ?? ""}`);
  const rounded = Math.round(total);
  return rounded > 0 && rounded <= MAX_DURATION_SECONDS ? rounded : undefined;
}

function parseTimestampLineSeconds(token: string): number | undefined {
  const match = /^(\d{1,2}):([0-5]\d)(?::([0-5]\d))?$/u.exec(token.trim());
  if (!match) return undefined;
  const [, first, second, third] = match;
  return third !== undefined
    ? Number(first) * 3600 + Number(second) * 60 + Number(third)
    : Number(first) * 60 + Number(second);
}

const LEADING_CHAPTER_LINE =
  /^(?:[-*•]\s*)?(?:\[|\()?(\d{1,2}:[0-5]\d(?::[0-5]\d)?)(?:\]|\))?(?:\s*[-–—:·|]\s*|\s+)(.+)$/u;
const TRAILING_CHAPTER_LINE =
  /^(?:[-*•]\s*)?(.+?)(?:\s*[-–—:·|]\s*|\s+)(?:\[|\()?(\d{1,2}:[0-5]\d(?::[0-5]\d)?)(?:\]|\))$/u;

function decodeBasicHtmlToLines(input: string): string[] {
  const withBreaks = input
    .replace(/<\s*br\s*\/?>/giu, "\n")
    .replace(/<\/\s*(?:p|div|li|h[1-6]|tr)\s*>/giu, "\n")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/&nbsp;/giu, " ");
  return withBreaks
    .split(/\r?\n/u)
    .map((line) => line.replace(/[ \t]+/gu, " ").trim())
    .filter(Boolean);
}

/**
 * Extracts strictly monotonic chapter markers (`00:00 Intro`, `14:20 Scaling Laws`) from show notes
 * or video descriptions. Requires at least 2 markers and the first within 10:00 so incidental prose
 * times ("at 3:30 PM") are never mistaken for an outline.
 */
export function extractDescriptionChapters(source: string): NormalizedMediaChapter[] {
  if (!source.trim()) return [];
  const lines = /<[a-z][\s\S]*>/iu.test(source)
    ? decodeBasicHtmlToLines(source)
    : source.split(/\r?\n/u).map((line) => line.replace(/[ \t]+/gu, " ").trim()).filter(Boolean);

  const candidates: NormalizedMediaChapter[] = [];
  for (const line of lines) {
    const lead = LEADING_CHAPTER_LINE.exec(line);
    const trail = lead ? null : TRAILING_CHAPTER_LINE.exec(line);
    const rawTime = lead?.[1] ?? trail?.[2];
    const rawTitle = (lead?.[2] ?? trail?.[1] ?? "")
      .replace(/^[-–—:·|\s]+|[-–—:·|\s]+$/gu, "")
      .trim();
    if (!rawTime || !rawTitle || /^https?:\/\//iu.test(rawTitle)) continue;
    const startSec = parseTimestampLineSeconds(rawTime);
    if (startSec === undefined) continue;
    const prev = candidates[candidates.length - 1];
    if (prev && startSec <= prev.startSec) continue;
    candidates.push({
      startSec,
      title: rawTitle.length > 160 ? `${rawTitle.slice(0, 159).trimEnd()}…` : rawTitle,
    });
  }

  if (candidates.length < 2 || (candidates[0]?.startSec ?? 9999) > 600) {
    return [];
  }
  return candidates;
}

const SPONSOR_HEADING = /^(?:sponsors?|sponsored by|supported by|brought to you by|connect with|follow us|social links|赞助|本期赞助|关注我们)\b/iu;

/**
 * Drops chapter timestamp tables and trailing sponsor/social link blocks when building a concise
 * single-line Inbox gist for a podcast episode or video.
 */
export function stripShowNotesBoilerplate(markdownOrText: string): string {
  const withoutTitleHeading = markdownOrText.replace(/^\s*#\s+[^\n]+\n+/u, "");
  const lines = withoutTitleHeading
    .split(/\r?\n/u)
    .map((line) =>
      line
        .replace(/\\([[\]()*_`#-])/gu, "$1")
        .replace(/!\[[^\]]*\]\([^)]*\)/gu, "")
        .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
        .replace(/[*_`~]+/gu, "")
        .replace(/^#{1,6}\s+/u, "")
        .trim(),
    )
    .filter(Boolean);
  const kept: string[] = [];
  for (const line of lines) {
    if (SPONSOR_HEADING.test(line)) break;
    if (LEADING_CHAPTER_LINE.test(line) || TRAILING_CHAPTER_LINE.test(line)) continue;
    if (/^(?:subscribe|listen)\s+on\s*:/iu.test(line)) continue;
    kept.push(line);
  }
  return kept.join(" ").replace(/\s+/gu, " ").trim();
}

function classifyMediaKind(mediaType: string, url: string): { kind: "audio" | "video"; mediaType: string } | undefined {
  const essence = mediaType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (essence.startsWith("audio/")) return { kind: "audio", mediaType: essence };
  if (essence.startsWith("video/")) return { kind: "video", mediaType: essence };
  if (AUDIO_EXT.test(url)) return { kind: "audio", mediaType: essence || "audio/mpeg" };
  if (VIDEO_EXT.test(url)) return { kind: "video", mediaType: essence || "video/mp4" };
  return undefined;
}

function transcriptRank(mediaType: string): number {
  const essence = mediaType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (essence === "application/json" || essence === "application/srt+json") return 5;
  if (essence === "text/vtt") return 4;
  if (essence === "application/x-subrip" || essence === "application/srt" || essence === "text/srt") return 3;
  if (essence === "text/html") return 2;
  if (essence === "text/plain") return 1;
  return 0;
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/u.test(value.trim())) return undefined;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseTranscriptRefs(
  entry: XmlNode,
  safeHttpUrl: (value: string, baseUri: string | undefined) => string,
): NormalizedFeedTranscriptRef[] {
  const nodes = nsChildren(entry, "transcript", PODCAST_NAMESPACES);
  const refs: NormalizedFeedTranscriptRef[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    const rawUrl = attribute(node, "url") ?? "";
    const url = safeHttpUrl(rawUrl, node.baseUri ?? entry.baseUri);
    const mediaType = (attribute(node, "type") ?? "").trim().toLowerCase();
    if (!url || !mediaType || seen.has(url)) continue;
    seen.add(url);
    const lang = attribute(node, "language")?.trim();
    const rel = attribute(node, "rel")?.trim();
    refs.push({
      mediaType,
      url,
      ...(lang ? { lang } : {}),
      ...(rel ? { rel } : {}),
    });
  }
  return refs.sort((left, right) => transcriptRank(right.mediaType) - transcriptRank(left.mediaType));
}

function itunesImageOf(node: XmlNode, safeHttpUrl: (value: string, baseUri: string | undefined) => string): string | undefined {
  const image = nsChild(node, "image", ITUNES_NAMESPACES);
  if (!image) return undefined;
  const href = attribute(image, "href") ?? nodeText(image);
  const safe = href ? safeHttpUrl(href, image.baseUri ?? node.baseUri) : "";
  return safe || undefined;
}

/**
 * Extracts `<media:group><media:description>` text from an Atom entry (used by YouTube Atom feeds,
 * which carry the video description in Media RSS rather than `<atom:summary>`).
 */
export function mediaGroupDescription(entry: XmlNode): string | undefined {
  const group = nsChild(entry, "group", MEDIA_NAMESPACES);
  const description = rawNodeText(group ? nsChild(group, "description", MEDIA_NAMESPACES) : undefined) ||
    rawNodeText(nsChild(entry, "description", MEDIA_NAMESPACES));
  return description || undefined;
}

function mediaGroupThumbnail(
  entry: XmlNode,
  safeHttpUrl: (value: string, baseUri: string | undefined) => string,
): string | undefined {
  const group = nsChild(entry, "group", MEDIA_NAMESPACES);
  const thumb = (group ? nsChild(group, "thumbnail", MEDIA_NAMESPACES) : undefined) ??
    nsChild(entry, "thumbnail", MEDIA_NAMESPACES);
  if (!thumb) return undefined;
  const url = safeHttpUrl(attribute(thumb, "url") ?? "", thumb.baseUri ?? entry.baseUri);
  return url || undefined;
}

/**
 * Extracts podcast enclosure/iTunes/Podcasting 2.0 metadata or YouTube Atom video metadata from a feed entry.
 * Returns `undefined` for ordinary blog, newsletter, and arXiv entries.
 */
export function extractEntryMedia(input: {
  descriptionSource?: string;
  dialect: "atom" | "rss";
  entry: XmlNode;
  feed: XmlNode;
  link: string;
  safeHttpUrl: (value: string, baseUri: string | undefined) => string;
}): NormalizedFeedMedia | undefined {
  const { descriptionSource = "", dialect, entry, feed, link, safeHttpUrl } = input;

  // 1. YouTube Atom entry (<yt:videoId>)
  if (dialect === "atom") {
    const ytVideoId = nodeText(nsChild(entry, "videoId", YT_NAMESPACES));
    if (ytVideoId && YOUTUBE_VIDEO_ID.test(ytVideoId)) {
      const streamUrl = link || `https://www.youtube.com/watch?v=${ytVideoId}`;
      const authorNode = entry.children.find((item) => item.namespaceUri === ATOM_NAMESPACE && item.localName === "author") ??
        feed.children.find((item) => item.namespaceUri === ATOM_NAMESPACE && item.localName === "author");
      const nameNode = authorNode?.children.find((item) => item.namespaceUri === ATOM_NAMESPACE && item.localName === "name");
      const author = nodeText(nameNode) || undefined;
      const description = mediaGroupDescription(entry) ?? descriptionSource;
      const chapters = extractDescriptionChapters(description);
      const imageUrl = mediaGroupThumbnail(entry, safeHttpUrl) ?? `https://i.ytimg.com/vi/${ytVideoId}/hqdefault.jpg`;
      return {
        kind: "video",
        mediaType: "video/mp4",
        provider: "youtube",
        streamUrl,
        videoId: ytVideoId,
        ...(author ? { author } : {}),
        ...(imageUrl ? { imageUrl } : {}),
        ...(chapters.length ? { chapters } : {}),
      };
    }
  }

  // 2. RSS <enclosure> or Atom <link rel="enclosure">
  let rawEnclosureUrl = "";
  let rawMediaType = "";
  let rawLength: string | undefined;
  let enclosureBase = entry.baseUri;

  if (dialect === "rss") {
    for (const enclosure of entry.children.filter((item) => item.namespaceUri === "" && item.localName === "enclosure")) {
      const candidateUrl = attribute(enclosure, "url") ?? "";
      const candidateType = attribute(enclosure, "type") ?? "";
      if (classifyMediaKind(candidateType, candidateUrl)) {
        rawEnclosureUrl = candidateUrl;
        rawMediaType = candidateType;
        rawLength = attribute(enclosure, "length");
        enclosureBase = enclosure.baseUri ?? entry.baseUri;
        break;
      }
    }
  } else {
    for (const linkNode of entry.children.filter((item) => item.namespaceUri === ATOM_NAMESPACE && item.localName === "link")) {
      if (attribute(linkNode, "rel") !== "enclosure") continue;
      const candidateUrl = attribute(linkNode, "href") ?? "";
      const candidateType = attribute(linkNode, "type") ?? "";
      if (classifyMediaKind(candidateType, candidateUrl)) {
        rawEnclosureUrl = candidateUrl;
        rawMediaType = candidateType;
        rawLength = attribute(linkNode, "length");
        enclosureBase = linkNode.baseUri ?? entry.baseUri;
        break;
      }
    }
  }

  const streamUrl = rawEnclosureUrl ? safeHttpUrl(rawEnclosureUrl, enclosureBase) : "";
  const classified = streamUrl ? classifyMediaKind(rawMediaType, streamUrl) : undefined;
  if (!streamUrl || !classified) return undefined;

  const durationSec = parseDurationSeconds(nodeText(nsChild(entry, "duration", ITUNES_NAMESPACES)));
  const episode = parsePositiveInt(nodeText(nsChild(entry, "episode", ITUNES_NAMESPACES)));
  const season = parsePositiveInt(nodeText(nsChild(entry, "season", ITUNES_NAMESPACES)));
  const author =
    nodeText(nsChild(entry, "author", ITUNES_NAMESPACES)) ||
    nodeText(nsChild(feed, "author", ITUNES_NAMESPACES)) ||
    undefined;
  const imageUrl = itunesImageOf(entry, safeHttpUrl) ?? itunesImageOf(feed, safeHttpUrl);
  const byteLength = parsePositiveInt(rawLength);
  const transcripts = parseTranscriptRefs(entry, safeHttpUrl);
  const chaptersNode = nsChild(entry, "chapters", PODCAST_NAMESPACES);
  const chaptersUrlRaw = chaptersNode ? attribute(chaptersNode, "url") ?? "" : "";
  const chaptersUrl = chaptersUrlRaw ? safeHttpUrl(chaptersUrlRaw, chaptersNode?.baseUri ?? entry.baseUri) || undefined : undefined;
  const chapters = extractDescriptionChapters(descriptionSource);

  return {
    kind: classified.kind,
    mediaType: classified.mediaType,
    provider: "podcast",
    streamUrl,
    ...(author ? { author } : {}),
    ...(byteLength !== undefined ? { byteLength } : {}),
    ...(durationSec !== undefined ? { durationSec } : {}),
    ...(episode !== undefined ? { episode } : {}),
    ...(season !== undefined ? { season } : {}),
    ...(imageUrl ? { imageUrl } : {}),
    ...(transcripts.length ? { transcripts } : {}),
    ...(chaptersUrl ? { chaptersUrl } : {}),
    ...(chapters.length ? { chapters } : {}),
  };
}
