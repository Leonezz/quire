import type { NormalizedMediaChapter } from "./model";

export type ShowNotesTextPart =
  | string
  | {
      label: string;
      raw: string;
      seconds: number;
    };

const LEADING_CHAPTER_LINE =
  /^(?:[-*•]\s*)?(?:\[|\()?(\d{1,2}:[0-5]\d(?::[0-5]\d)?)(?:\]|\))?(?:\s*[-–—:：·|]\s*|\s+)(.+)$/u;
const TRAILING_CHAPTER_LINE =
  /^(?:[-*•]\s*)?(.+?)(?:\s*[-–—:：·|]\s*|\s+)(?:\[|\()?(\d{1,2}:[0-5]\d(?::[0-5]\d)?)(?:\]|\))?$/u;

const CJK_SECTION_NAMES =
  "本期嘉宾|嘉宾介绍|嘉宾简介|特邀嘉宾|对谈嘉宾|节目介绍|本期介绍|内容介绍|本期简介|内容简介|节目简介|单集简介|核心议题|本期议题|主要议题|本期看点|内容提要|高光时刻|精彩看点|时间轴|时间线|章节目录|收听指南|时间节点|相关链接|延伸阅读|参考资料|提及作品|提及书目|本期歌单|背景音乐|片尾曲|制作团队|本期制作";

const EN_SECTION_NAMES =
  "show\\s*notes|episode\\s*notes|timestamps?|chapters?|timeline|outline|topics?\\s*covered|in\\s*this\\s*episode|guest\\s*bio|links?\\s*(?:&|and)\\s*resources|resources|references|credits";

const STANDALONE_SECTION_HEADING = new RegExp(
  `^(?:\\*\\*)?(?:【|\\[)?\\s*(${CJK_SECTION_NAMES}|${EN_SECTION_NAMES})\\s*(?:】|\\])?(?:\\*\\*)?\\s*[:：]?$`,
  "iu",
);

const INLINE_CJK_SECTION = new RegExp(
  `(^|[\\s。！？!?；;】」』”"])(?:【)?(${CJK_SECTION_NAMES})(?:】)?(?:[:：]\\s*|\\s+|(?=(?:\\[|\\()?\\d{1,2}:[0-5]\\d))`,
  "gu",
);

const ROLE_NAMES =
  "赛博对话官|本期主播|特邀主持|常驻主播|主持人|主播|策划|监制|后期制作|剪辑|视觉设计|出品人";

const INLINE_ROLE_CREDIT = new RegExp(
  `(^|[\\s。！？!?；;])(${ROLE_NAMES})(?:[:：]\\s*|\\s+)(?=\\S)`,
  "gu",
);

const INLINE_FOOTER_BLOCK =
  /(?<=\S)\s+((?:期待关注|欢迎关注|关注我们|联系我们|商务合作|商业合作|加入听友群|听友群|订阅渠道|收听方式)\s*[:：])/gu;

const TRAILING_PLATFORM_NOTE =
  /(?<=\S)[ \t]+((?:\[[^\]]*在(?:小宇宙|苹果播客|Apple\s*Podcasts?|喜马拉雅)查看[^\]]*\]\([^)]+\)|在(?:小宇宙|苹果播客|Apple\s*Podcasts?|喜马拉雅)查看[^\n]{0,32}))\s*$/gmu;

/**
 * Parses `MM:SS` or `HH:MM:SS` into non-negative whole seconds.
 */
export function parseShowNotesTimestamp(token: string): number | undefined {
  const cleaned = token.trim().replace(/^(?:\[|\()|(?:\]|\))$/gu, "");
  const match = /^(\d{1,2}):([0-5]\d)(?::([0-5]\d))?$/u.exec(cleaned);
  if (!match) return undefined;
  const [, first, second, third] = match;
  return third !== undefined
    ? Number(first) * 3600 + Number(second) * 60 + Number(third)
    : Number(first) * 60 + Number(second);
}

function decodeBasicHtmlToLines(input: string): string[] {
  const withBreaks = input
    .replace(/<\s*br\s*\/?>/giu, "\n")
    .replace(/<\/\s*(?:p|div|li|h[1-6]|tr|section|blockquote)\s*>/giu, "\n")
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

interface TimestampOccurrence {
  index: number;
  seconds: number;
}

const INLINE_TIMESTAMP_CANDIDATE =
  /(?:^|(?<=[\s。；;！!？?】\]）)\u4e00-\u9fff：:]))((?:\[|\()?\d{1,2}:[0-5]\d(?::[0-5]\d)?(?:\]|\))?)(?=(?:\s*[-–—:：·|]\s*|\s+)\S)/gu;

function splitInlineTimestampChain(line: string): string[] {
  const matches: TimestampOccurrence[] = [];
  for (const match of line.matchAll(INLINE_TIMESTAMP_CANDIDATE)) {
    const raw = match[1];
    const index = match.index;
    if (!raw || index === undefined) continue;
    const after = line.slice(index + raw.length);
    if (/^\s*(?:am|pm)\b/iu.test(after)) continue;
    const seconds = parseShowNotesTimestamp(raw);
    if (seconds === undefined) continue;
    matches.push({ index, seconds });
  }
  if (matches.length < 2) return [line];

  // Keep the longest monotonic chain starting within the first 20 minutes so incidental prose numbers never split sentences.
  const chain: TimestampOccurrence[] = [];
  for (const cand of matches) {
    if (chain.length === 0) {
      if (cand.seconds <= 1200) chain.push(cand);
      continue;
    }
    if (cand.seconds > chain[chain.length - 1]!.seconds) {
      chain.push(cand);
    }
  }
  if (chain.length < 2) return [line];

  const parts: string[] = [];
  let cursor = 0;
  for (const item of chain) {
    const before = line.slice(cursor, item.index).trim();
    if (before) parts.push(before);
    cursor = item.index;
  }
  const tail = line.slice(cursor).trim();
  if (tail) parts.push(tail);
  return parts;
}

function protectUrlsAndFences(input: string): {
  protectedText: string;
  restore: (text: string) => string;
} {
  const tokens: string[] = [];
  const stash = (value: string) => {
    const id = `\uE000${tokens.length}\uE001`;
    tokens.push(value);
    return id;
  };
  let protectedText = input.replace(/```[\s\S]*?```/gu, stash);
  protectedText = protectedText.replace(/\]\((https?:\/\/[^)\s]+)\)/giu, (_m, url: string) => `](${stash(url)})`);
  protectedText = protectedText.replace(/https?:\/\/[^\s)]+/giu, stash);
  return {
    protectedText,
    restore: (text: string) =>
      text.replace(/\uE000(\d+)\uE001/gu, (_m, idx: string) => tokens[Number(idx)] ?? ""),
  };
}

function expandCollapsedShowNotesLines(input: string): string[] {
  const normalized = input
    .replace(/\r\n?/gu, "\n")
    .replace(/\u00a0/gu, " ")
    .replace(/\\\n/gu, "\n");
  const { protectedText, restore } = protectUrlsAndFences(normalized);

  const expanded = protectedText
    .replace(INLINE_CJK_SECTION, (_m, prefix: string, heading: string) => {
      const lead = prefix && !/\s/u.test(prefix) ? `${prefix}\n\n` : "\n\n";
      return `${lead}### ${heading}\n\n`;
    })
    .replace(INLINE_ROLE_CREDIT, (_m, prefix: string, role: string) => {
      const lead = prefix && !/\s/u.test(prefix) ? `${prefix}\n\n` : "\n\n";
      return `${lead}**${role}**：`;
    })
    .replace(INLINE_FOOTER_BLOCK, "\n\n---\n\n$1")
    .replace(TRAILING_PLATFORM_NOTE, "\n\n$1");

  const out: string[] = [];
  for (const rawLine of expanded.split("\n")) {
    const trimmed = rawLine.replace(/[ \t]+/gu, " ").trim();
    if (!trimmed) {
      out.push("");
      continue;
    }
    if (trimmed.startsWith("\uE000") && trimmed.endsWith("\uE001")) {
      out.push(restore(trimmed));
      continue;
    }
    const split = splitInlineTimestampChain(trimmed);
    for (const part of split) {
      out.push(restore(part));
    }
  }
  return out;
}

/**
 * Extracts strictly monotonic chapter markers (`00:00 Intro`, `14:20 Scaling Laws`) from show notes
 * or video descriptions, including collapsed single-line outlines (`核心议题01:14 ... 04:08 ...`).
 * Requires at least 2 markers and the first within 15:00 so incidental prose times are ignored.
 */
export function extractDescriptionChapters(source: string): NormalizedMediaChapter[] {
  if (!source.trim()) return [];
  const baseLines = /<[a-z][\s\S]*>/iu.test(source)
    ? decodeBasicHtmlToLines(source).join("\n")
    : source;
  const lines = expandCollapsedShowNotesLines(baseLines).filter(Boolean);

  const candidates: NormalizedMediaChapter[] = [];
  for (const line of lines) {
    if (/^#{1,6}\s|^---+$|^\*\*[^*]+\*\*：/u.test(line)) continue;
    const lead = LEADING_CHAPTER_LINE.exec(line);
    const trail = lead ? null : TRAILING_CHAPTER_LINE.exec(line);
    const rawTime = lead?.[1] ?? trail?.[2];
    const rawTitle = (lead?.[2] ?? trail?.[1] ?? "")
      .replace(/^[-–—:：·|\s]+|[-–—:：·|\s]+$/gu, "")
      .trim();
    if (!rawTime || !rawTitle || /^https?:\/\//iu.test(rawTitle)) continue;
    const startSec = parseShowNotesTimestamp(rawTime);
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

/**
 * Structures raw or collapsed podcast/video show notes into clean editorial GFM Markdown:
 * - Promotes section markers (`本期嘉宾`, `节目介绍`, `核心议题`, `Timestamps`, `Show Notes`) to `###` headings
 * - Turns inline or line-per-topic timestamp chains (`01:14 ...`, `04:08 ...`) into tight `- MM:SS Title` lists
 * - Separates guest/host credits, paragraphs, and social/platform footers while keeping existing links & formatting intact.
 */
export function formatShowNotesMarkdown(raw: string): string {
  if (!raw.trim()) return raw;
  const lines = expandCollapsedShowNotesLines(raw);

  const chapterLineIndices = new Set<number>();
  lines.forEach((line, idx) => {
    if (!line || /^#{1,6}\s|^---+$|^>/u.test(line)) return;
    const lead = LEADING_CHAPTER_LINE.exec(line);
    if (!lead) return;
    const sec = parseShowNotesTimestamp(lead[1] ?? "");
    const title = (lead[2] ?? "").trim();
    if (sec !== undefined && title && !/^https?:\/\//iu.test(title) && !/^(?:am|pm)\b/iu.test(title)) {
      chapterLineIndices.add(idx);
    }
  });
  const formatChaptersAsList = chapterLineIndices.size >= 2;

  const blocks: string[] = [];
  let listBuffer: string[] = [];
  const flushList = () => {
    if (listBuffer.length > 0) {
      blocks.push(listBuffer.join("\n"));
      listBuffer = [];
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (!line) {
      continue;
    }

    if (line.startsWith("```")) {
      flushList();
      blocks.push(line);
      continue;
    }

    if (/^---+$/.test(line)) {
      flushList();
      if (blocks.length > 0 && blocks[blocks.length - 1] !== "---") {
        blocks.push("---");
      }
      continue;
    }

    if (/^#{1,6}\s+/.test(line)) {
      flushList();
      blocks.push(line.replace(/^(#{1,6})\s+(.+?)\s*[:：]?$/u, "$1 $2"));
      continue;
    }

    const standaloneHeading = STANDALONE_SECTION_HEADING.exec(line);
    if (standaloneHeading?.[1]) {
      flushList();
      blocks.push(`### ${standaloneHeading[1].trim()}`);
      continue;
    }

    if (formatChaptersAsList && chapterLineIndices.has(i)) {
      const lead = LEADING_CHAPTER_LINE.exec(line);
      if (lead?.[1] && lead[2]) {
        const cleanTime = lead[1].trim();
        const cleanTitle = lead[2].replace(/^[-–—:：·|\s]+/u, "").trim();
        listBuffer.push(`- ${cleanTime} ${cleanTitle}`);
        continue;
      }
    }

    if (/^(?:[-*+]|\d+\.)\s+/.test(line)) {
      listBuffer.push(line.replace(/^[•*+]\s+/u, "- "));
      continue;
    }

    flushList();
    blocks.push(line);
  }
  flushList();

  return blocks.join("\n\n").replace(/\n{3,}/gu, "\n\n").trim();
}

/**
 * Detects when a stored `shownotes` reader payload collapsed structured show notes into a flat
 * paragraph without headings or lists (for example from an earlier plain-text import), so the
 * reader surface can upgrade the view immediately from its Markdown/plain text.
 */
export function isCollapsedShowNotesReader(
  payload: string | undefined,
  formattedMarkdown: string,
): boolean {
  if (!formattedMarkdown.trim()) return false;
  if (!payload) return true;
  let parsed: { children?: Array<{ type?: string }> };
  try {
    parsed = JSON.parse(payload) as { children?: Array<{ type?: string }> };
  } catch {
    return true;
  }
  const children = Array.isArray(parsed.children) ? parsed.children : [];
  if (children.length === 0) return true;
  const hasRichStructure = children.some(
    (node) => node.type === "heading" || node.type === "list" || node.type === "blockquote" || node.type === "table",
  );
  if (hasRichStructure) return false;
  const formattedBlocks = formattedMarkdown.split(/\n{2,}/u).filter(Boolean);
  const formattedHasStructure = /^(?:#{1,6}\s|-\s|\*\s|---)/mu.test(formattedMarkdown);
  return formattedHasStructure || formattedBlocks.length > children.length;
}

const RENDER_TIMESTAMP_TOKEN =
  /(^|(?<=[\s\[(\u4e00-\u9fff]))(\[(?:\d{1,2}:[0-5]\d(?::[0-5]\d)?)\]|\((?:\d{1,2}:[0-5]\d(?::[0-5]\d)?)\)|\d{1,2}:[0-5]\d(?::[0-5]\d)?)(?=$|[\s\])\-–—:：·|.,，。；;！!？?])/gu;

/**
 * Splits a text node inside Show Notes into plain strings and clickable timestamp tokens while
 * keeping the concatenated text 100% character-identical for selection, copy, Notes, and Find.
 */
export function splitShowNotesTimestamps(value: string): ShowNotesTextPart[] {
  if (!value.includes(":")) return [value];
  const parts: ShowNotesTextPart[] = [];
  let cursor = 0;
  for (const match of value.matchAll(RENDER_TIMESTAMP_TOKEN)) {
    const token = match[2];
    const start = match.index !== undefined ? match.index + (match[1]?.length ?? 0) : -1;
    if (!token || start < cursor) continue;
    const after = value.slice(start + token.length);
    if (/^\s*(?:am|pm)\b/iu.test(after)) continue;
    const seconds = parseShowNotesTimestamp(token);
    if (seconds === undefined) continue;
    if (start > cursor) {
      parts.push(value.slice(cursor, start));
    }
    const label = token.replace(/^(?:\[|\()|(?:\]|\))$/gu, "");
    parts.push({
      label,
      raw: token,
      seconds,
    });
    cursor = start + token.length;
  }
  if (parts.length === 0) return [value];
  if (cursor < value.length) {
    parts.push(value.slice(cursor));
  }
  return parts;
}
