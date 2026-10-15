// Typographic punctuation for text the agent wrote: straight quotes become curly ones and three dots
// an ellipsis, so an artifact reads like a typeset page. Only the rendering changes; the stored
// Markdown keeps what the agent wrote (its quotes must match the sources character for character).

const OPENS_AFTER = /[\s([{—–/-]/;

/** The text with “curly” double and ‘single’ quotes, apostrophes (it’s) and … in place of their ASCII forms. */
export function typographic(text: string): string {
  if (!/["'.]/.test(text)) return text;
  let out = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    const before = index === 0 ? " " : text[index - 1]!;
    const opens = OPENS_AFTER.test(before);
    if (char === "\"") out += opens ? "“" : "”";
    else if (char === "'") out += opens ? "‘" : "’";
    else if (char === "." && text.startsWith("...", index) && text[index + 3] !== ".") { out += "…"; index += 2; }
    else out += char;
  }
  return out;
}
