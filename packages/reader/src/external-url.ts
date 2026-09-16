declare const safeExternalUrlBrand: unique symbol;

export type SafeExternalUrl = string & {
  readonly [safeExternalUrlBrand]: true;
};

const MAX_EXTERNAL_URL_LENGTH = 8_192;
const UNSAFE_URL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const ALLOWED_EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/**
 * Parses the only URL shape that reader surfaces may expose as a navigable link.
 * Callers retain the original value for provenance; the branded return value is
 * the normalized, credential-free URL that may cross into rendered UI.
 */
export function safeExternalUrl(
  value: string | undefined,
): SafeExternalUrl | undefined {
  if (
    !value ||
    value.length > MAX_EXTERNAL_URL_LENGTH ||
    UNSAFE_URL_CHARACTERS.test(value)
  ) {
    return undefined;
  }

  try {
    const parsed = new URL(value);
    if (
      !ALLOWED_EXTERNAL_PROTOCOLS.has(parsed.protocol) ||
      parsed.username ||
      parsed.password
    ) {
      return undefined;
    }
    return parsed.toString() as SafeExternalUrl;
  } catch {
    return undefined;
  }
}
