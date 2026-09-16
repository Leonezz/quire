export type ImagePolicyInput = {
  alt?: string | null;
  height?: string | null;
  producerEntryId?: string;
  producerKey: string;
  title?: string | null;
  url: string;
  width?: string | null;
};

function explicitPixelDimension(value: string | null | undefined) {
  if (value === null || value === undefined || !/^\s*\d+(?:\.\d+)?(?:px)?\s*$/iu.test(value)) return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function mediumPostId(value: string | undefined) {
  if (!value) return undefined;
  try {
    return /^\/p\/([^/]+)$/u.exec(new URL(value).pathname)?.[1];
  } catch {
    return undefined;
  }
}

export function trackingPixelRule(input: ImagePolicyInput): "generic.remove-tracking-pixel" | "medium.remove-tracking-pixel" | undefined {
  const width = explicitPixelDimension(input.width);
  const height = explicitPixelDimension(input.height);
  if (width === undefined || height === undefined || width > 1 || height > 1) return undefined;

  if (input.producerKey === "medium") {
    try {
      const parsed = new URL(input.url);
      const expectedPostId = mediumPostId(input.producerEntryId);
      if (
        parsed.protocol === "https:"
        && parsed.hostname === "medium.com"
        && parsed.pathname === "/_/stat"
        && parsed.searchParams.get("event") === "post.clientViewed"
        && parsed.searchParams.get("referrerSource") === "full_rss"
        && expectedPostId !== undefined
        && parsed.searchParams.get("postId") === expectedPostId
      ) {
        return "medium.remove-tracking-pixel";
      }
    } catch {}
  }

  return input.alt?.trim() || input.title?.trim() ? undefined : "generic.remove-tracking-pixel";
}
