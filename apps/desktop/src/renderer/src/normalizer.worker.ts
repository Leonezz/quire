import {
  normalizeArticleCapture,
  normalizeTranscript,
  parseTranscriptCues,
  sha256Hex,
  validateRefinedTranscript,
  type TranscriptChapter,
  type TranscriptCue,
  type TranscriptKeyframe,
} from "@read/normalize";
import type { MaterialMeta, MaterialRecord } from "../../shared/contracts";
import { compileReact } from "../../main/artifact-runtime";
import { arxivItemsOf } from "../../main/engine/arxiv";
import { captureTextOf } from "../../main/engine/capture-text";
import { parseFeed } from "../../main/engine/feeds";
import { NORMALIZE_BUDGET, degradedQuality, markdownParts, pickRepresentations, titleFromHtml } from "../../main/engine/material-content";
import { canonicalLinkOf } from "../../main/engine/material-identity";
import { extractPage } from "../../main/engine/metadata";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { inspectPdf, setPdfWorkerSrc } from "../../main/engine/pdf";
import { buildTextView } from "../../main/engine/pdf-reflow";
import { JevJudge, RulesJudge } from "../../main/engine/pdf-reflow/judge";
import { readingMinutes } from "../../main/engine/reading-time";

setPdfWorkerSrc(pdfWorkerUrl);

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

interface WorkerJob {
  requestId: number;
  op: string;
  payload: Record<string, unknown>;
}

async function runJob(op: string, payload: Record<string, unknown>): Promise<unknown> {
  if (op === "normalizeHtml") {
    const bytes = fromBase64(String(payload.bytesBase64 ?? ""));
    const mediaType = String(payload.mediaType ?? "text/html");
    const finalUrl = String(payload.finalUrl ?? "");
    const origin = (payload.origin as MaterialRecord["origin"]) ?? "web";
    const fetchedAt = String(payload.fetchedAt ?? new Date().toISOString());
    const item = (payload.item as MaterialMeta | null | undefined) ?? undefined;
    const contentIdentity = `sha256:${sha256Hex(bytes)}` as const;

    const outcome = normalizeArticleCapture({
      budget: NORMALIZE_BUDGET,
      capture: { baseLocator: finalUrl, bytes, contentIdentity, mediaType },
    });

    if (!outcome.ok) {
      const plain = outcome.fallbackText ?? "";
      const title = new URL(finalUrl).hostname;
      const page = extractPage({
        html: bytes,
        url: finalUrl,
        mediaType,
        origin,
        fetchedAt,
        fallback: { title },
        ...(item ? { item } : {}),
      });
      const canonicalUrl = canonicalLinkOf(page.canonical, finalUrl);
      return {
        title,
        plain,
        readingMinutes: readingMinutes(plain),
        quality: degradedQuality(outcome.problems),
        problems: outcome.problems,
        extracted: page.meta,
        ...(canonicalUrl ? { canonicalUrl } : {}),
      };
    }

    const { article } = outcome;
    const parts = pickRepresentations(article.materialization);
    const title = article.title.trim() || titleFromHtml(bytes) || new URL(finalUrl).hostname;
    const page = extractPage({
      html: bytes,
      url: finalUrl,
      mediaType,
      origin,
      fetchedAt,
      fallback: {
        title,
        ...(article.byline ? { byline: article.byline } : {}),
        ...(article.publishedAt ? { publishedAt: article.publishedAt } : {}),
        ...(article.lang ? { lang: article.lang } : {}),
      },
      ...(item ? { item } : {}),
    });
    const canonicalUrl = canonicalLinkOf(page.canonical, finalUrl);
    return {
      title,
      ...(article.byline ? { byline: article.byline } : {}),
      ...(article.publishedAt ? { publishedAt: article.publishedAt } : {}),
      ...(article.lang ? { lang: article.lang } : {}),
      ...(article.dir ? { dir: article.dir } : {}),
      ...parts,
      readingMinutes: readingMinutes(parts.plain ?? parts.markdown ?? ""),
      quality: article.materialization.quality,
      problems: outcome.problems,
      extracted: page.meta,
      ...(canonicalUrl ? { canonicalUrl } : {}),
    };
  }

  if (op === "extractMeta") {
    const htmlBase64 = payload.htmlBase64 as string | undefined;
    const html = htmlBase64 ? fromBase64(htmlBase64) : undefined;
    const url = String(payload.url ?? "");
    const mediaType = String(payload.mediaType ?? "text/html");
    const origin = (payload.origin as MaterialRecord["origin"]) ?? "web";
    const fetchedAt = payload.fetchedAt as string | undefined;
    const fallbackTitle = payload.fallbackTitle as string | undefined;
    const fallbackByline = payload.fallbackByline as string | undefined;
    const fallbackPublishedAt = payload.fallbackPublishedAt as string | undefined;
    const fallbackLang = payload.fallbackLang as string | undefined;
    const item = (payload.item as MaterialMeta | null | undefined) ?? undefined;

    const page = extractPage({
      ...(html ? { html } : {}),
      url,
      mediaType,
      origin,
      ...(fetchedAt ? { fetchedAt } : {}),
      fallback: {
        ...(fallbackTitle ? { title: fallbackTitle } : {}),
        ...(fallbackByline ? { byline: fallbackByline } : {}),
        ...(fallbackPublishedAt ? { publishedAt: fallbackPublishedAt } : {}),
        ...(fallbackLang ? { lang: fallbackLang } : {}),
      },
      ...(item ? { item } : {}),
    });
    const canonicalUrl = canonicalLinkOf(page.canonical, url);
    return {
      meta: page.meta,
      ...(canonicalUrl ? { canonicalUrl } : {}),
    };
  }

  if (op === "normalizeMarkdown") {
    const content = String(payload.content ?? "");
    const baseUri = String(payload.baseUri ?? "https://file.local/");
    const parts = markdownParts(content, baseUri);
    return {
      ...(parts.reader ? { reader: parts.reader } : {}),
      readingMinutes: parts.readingMinutes,
    };
  }

  if (op === "inspectPdf") {
    const bytes = fromBase64(String(payload.bytesBase64 ?? ""));
    return inspectPdf(bytes);
  }

  if (op === "buildTextView") {
    const bytes = fromBase64(String(payload.bytesBase64 ?? ""));
    const materialId = String(payload.materialId ?? "");
    const title = String(payload.title ?? "");
    const judgeName = String(payload.judge ?? "rules");
    const apiKey = payload.typesafeApiKey as string | undefined;
    const figures: { index: number; pngBase64: string }[] = [];

    const judge =
      judgeName === "jev" && apiKey
        ? new JevJudge((u, init) => fetch(u, init), apiKey)
        : new RulesJudge();

    const content = await buildTextView(bytes, materialId, {
      title,
      judge,
      figures: {
        write: async (mid, index, png) => {
          figures.push({ index, pngBase64: toBase64(png) });
          return `quire-figure://${mid}/${index}.png`;
        },
      },
    });
    return { content, figures };
  }

  if (op === "parseFeed") {
    const bytes = fromBase64(String(payload.bytesBase64 ?? ""));
    const mediaType = String(payload.mediaType ?? "application/xml");
    const feedUrl = String(payload.feedUrl ?? "");
    const isArxiv = Boolean(payload.isArxiv);
    const feed = parseFeed(bytes, mediaType, feedUrl);
    const items = isArxiv ? arxivItemsOf(feed, bytes) : feed.items;
    return {
      title: feed.title,
      ...(feed.siteUrl ? { siteUrl: feed.siteUrl } : {}),
      items,
    };
  }

  if (op === "captureText") {
    return captureTextOf(String(payload.html ?? ""));
  }

  if (op === "compileReact") {
    return compileReact(String(payload.source ?? ""));
  }

  if (op === "normalizeTranscript") {
    const rawText = typeof payload.rawText === "string" ? payload.rawText : undefined;
    const mediaType = typeof payload.mediaType === "string" ? payload.mediaType : undefined;
    const suppliedCues = Array.isArray(payload.cues) ? (payload.cues as TranscriptCue[]) : undefined;
    const chapters = Array.isArray(payload.chapters) ? (payload.chapters as TranscriptChapter[]) : undefined;
    const keyframes = Array.isArray(payload.keyframes) ? (payload.keyframes as TranscriptKeyframe[]) : undefined;
    const title = typeof payload.title === "string" ? payload.title : undefined;

    const cues = suppliedCues ?? parseTranscriptCues(rawText ?? "", mediaType);
    if (cues.length === 0) {
      throw new Error("Transcript contained no timed cues.");
    }
    const normalized = normalizeTranscript(cues, {
      ...(chapters ? { chapters } : {}),
      ...(keyframes ? { keyframes } : {}),
      ...(title ? { title } : {}),
    });
    return {
      reader: normalized.reader,
      markdown: normalized.markdown,
      plain: normalized.plain,
      readingMinutes: readingMinutes(normalized.plain),
      timeAnchors: normalized.anchors,
      cues,
    };
  }

  if (op === "cropStoryboardSheet") {
    const bytes = fromBase64(String(payload.bytesBase64 ?? ""));
    const mediaType = String(payload.mediaType ?? "image/jpeg");
    const regions = Array.isArray(payload.regions)
      ? (payload.regions as { index: number; x: number; y: number; width: number; height: number }[])
      : [];
    if (regions.length === 0 || typeof OffscreenCanvas === "undefined" || typeof createImageBitmap === "undefined") {
      return [];
    }
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const bitmap = await createImageBitmap(new Blob([copy], { type: mediaType }));
    try {
      const crops: { index: number; pngBase64: string; width: number; height: number }[] = [];
      for (const r of regions) {
        if (r.width <= 0 || r.height <= 0 || r.x >= bitmap.width || r.y >= bitmap.height) continue;
        const w = Math.min(r.width, bitmap.width - r.x);
        const h = Math.min(r.height, bitmap.height - r.y);
        if (w <= 0 || h <= 0) continue;
        const canvas = new OffscreenCanvas(w, h);
        const ctx = canvas.getContext("2d");
        if (!ctx) continue;
        ctx.drawImage(bitmap, r.x, r.y, w, h, 0, 0, w, h);
        const blob = await canvas.convertToBlob({ type: "image/png" });
        const pngBytes = new Uint8Array(await blob.arrayBuffer());
        crops.push({ index: r.index, pngBase64: toBase64(pngBytes), width: w, height: h });
      }
      return crops;
    } finally {
      bitmap.close();
    }
  }

  if (op === "refineTranscript") {
    const markdown = String(payload.markdown ?? "");
    const rawCues = Array.isArray(payload.rawCues) ? (payload.rawCues as TranscriptCue[]) : [];
    const keyframes = Array.isArray(payload.keyframes) ? (payload.keyframes as TranscriptKeyframe[]) : undefined;
    const title = typeof payload.title === "string" ? payload.title : undefined;

    const checked = validateRefinedTranscript(markdown, rawCues);
    if (!checked.ok) {
      throw new Error(`Refined transcript validation failed:\n- ${checked.issues.join("\n- ")}`);
    }
    const normalized = normalizeTranscript(checked.cues, {
      chapters: checked.chapters,
      ...(keyframes ? { keyframes } : {}),
      ...(title ? { title } : {}),
    });
    return {
      reader: normalized.reader,
      markdown: normalized.markdown,
      plain: normalized.plain,
      readingMinutes: readingMinutes(normalized.plain),
      timeAnchors: normalized.anchors,
      cues: checked.cues,
    };
  }

  throw new Error(`Unknown normalizer operation: ${op}`);
}

const workerScope = globalThis as unknown as {
  addEventListener: (type: "message", listener: (event: MessageEvent<WorkerJob>) => void) => void;
  postMessage: (message: unknown) => void;
};

workerScope.addEventListener("message", (event: MessageEvent<WorkerJob>) => {
  const { requestId, op, payload } = event.data;
  void runJob(op, payload).then(
    (result) => workerScope.postMessage({ requestId, ok: true, result }),
    (error: unknown) =>
      workerScope.postMessage({
        requestId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }),
  );
});
