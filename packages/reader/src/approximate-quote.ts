import search from "approx-string-match";

// Re-places a quote whose text changed a little, the way Hypothesis's client anchors annotations: Myers'
// approximate search for the quote, each candidate scored by how well the stored prefix and suffix agree
// with the text around it. Texts are canonical (whitespace removed) on both sides.

export type ApproximateQuoteContext = Readonly<{
  prefix: string;
  suffix: string;
  /** Where the quote started when it was captured, in the same canonical text. */
  position?: number;
}>;

export type ApproximateQuoteMatch = Readonly<{ start: number; end: number; errors: number }>;

/** One edit per eight characters: a changed word in a sentence, not a different sentence. */
const CHARACTERS_PER_ERROR = 8;
/** Caps Myers' work at eight 32-bit words per character of text, however long the quote is. */
const MAX_ERRORS = 256;
/** Below this length the quote alone is weak evidence: its stored context must agree as well. */
const SHORT_QUOTE = 32;
const CONTEXT_AGREEMENT = 0.5;
// The quote dominates, context comes next, the distance from the captured position only breaks ties.
const QUOTE_WEIGHT = 50;
const CONTEXT_WEIGHT = 20;
const POSITION_WEIGHT = 2;

/** How closely (0–1) `actual` holds `expected`; undefined when nothing was stored to compare. */
function agreement(actual: string, expected: string) {
  if (!expected) return undefined;
  if (!actual) return 0;
  const [closest] = search(actual, expected, expected.length);
  return closest ? 1 - closest.errors / expected.length : 0;
}

type ScoredMatch = ApproximateQuoteMatch & Readonly<{ score: number }>;

function scored(text: string, quote: string, context: ApproximateQuoteContext, match: ApproximateQuoteMatch): ScoredMatch | undefined {
  const prefix = agreement(text.slice(Math.max(0, match.start - context.prefix.length), match.start), context.prefix);
  const suffix = agreement(text.slice(match.end, match.end + context.suffix.length), context.suffix);
  if (quote.length < SHORT_QUOTE && !((prefix ?? 0) >= CONTEXT_AGREEMENT || (suffix ?? 0) >= CONTEXT_AGREEMENT))
    return undefined;
  const position = context.position === undefined ? 1 : 1 - Math.abs(match.start - context.position) / text.length;
  const score =
    QUOTE_WEIGHT * (1 - match.errors / quote.length) +
    CONTEXT_WEIGHT * (prefix ?? 1) +
    CONTEXT_WEIGHT * (suffix ?? 1) +
    POSITION_WEIGHT * position;
  return { ...match, score };
}

/**
 * The closest stretch of `text` to `quote` within one edit per eight characters, or undefined when there is
 * none, when a short quote's context no longer agrees, or when two separate candidates score the same.
 */
export function approximateQuoteMatch(text: string, quote: string, context: ApproximateQuoteContext): ApproximateQuoteMatch | undefined {
  const maxErrors = Math.min(MAX_ERRORS, Math.floor(quote.length / CHARACTERS_PER_ERROR));
  if (maxErrors < 1 || !text) return undefined;
  const candidates = search(text, quote, maxErrors)
    .map((match) => scored(text, quote, context, match))
    .filter((match): match is ScoredMatch => match !== undefined)
    .sort((left, right) => right.score - left.score);
  const [best] = candidates;
  if (!best) return undefined;
  // Overlapping candidates are one place found at slightly different edges; a separate one as good is a guess.
  const rival = candidates.find((match) => match !== best && (match.end <= best.start || match.start >= best.end));
  if (rival && best.score - rival.score < 1e-9) return undefined;
  return { start: best.start, end: best.end, errors: best.errors };
}
