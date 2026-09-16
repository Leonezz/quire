import type { CSSProperties } from "react";
import { useEffect, useState } from "react";

const MAX_HIGHLIGHT_CHARACTERS = 80_000;
const MAX_HIGHLIGHT_CACHE_ENTRIES = 48;

type HighlightToken = {
  content: string;
  htmlStyle?: Record<string, string>;
};

type HighlightedCode = {
  lines: HighlightToken[][];
};

type SupportedLanguage = keyof typeof languageLoaders;

const languageLoaders = {
  bash: () => import("@shikijs/langs/bash").then((module) => module.default),
  c: () => import("@shikijs/langs/c").then((module) => module.default),
  cpp: () => import("@shikijs/langs/cpp").then((module) => module.default),
  css: () => import("@shikijs/langs/css").then((module) => module.default),
  diff: () => import("@shikijs/langs/diff").then((module) => module.default),
  go: () => import("@shikijs/langs/go").then((module) => module.default),
  html: () => import("@shikijs/langs/html").then((module) => module.default),
  java: () => import("@shikijs/langs/java").then((module) => module.default),
  javascript: () =>
    import("@shikijs/langs/javascript").then((module) => module.default),
  json: () => import("@shikijs/langs/json").then((module) => module.default),
  jsx: () => import("@shikijs/langs/jsx").then((module) => module.default),
  markdown: () =>
    import("@shikijs/langs/markdown").then((module) => module.default),
  python: () => import("@shikijs/langs/python").then((module) => module.default),
  rust: () => import("@shikijs/langs/rust").then((module) => module.default),
  sql: () => import("@shikijs/langs/sql").then((module) => module.default),
  tsx: () => import("@shikijs/langs/tsx").then((module) => module.default),
  typescript: () =>
    import("@shikijs/langs/typescript").then((module) => module.default),
  yaml: () => import("@shikijs/langs/yaml").then((module) => module.default),
} as const;

const languageAliases: Record<string, SupportedLanguage> = {
  cjs: "javascript",
  console: "bash",
  htm: "html",
  js: "javascript",
  json5: "json",
  md: "markdown",
  mts: "typescript",
  py: "python",
  rs: "rust",
  sh: "bash",
  shell: "bash",
  ts: "typescript",
  yml: "yaml",
};

const highlightCache = new Map<string, Promise<HighlightedCode | undefined>>();
const languageLoadCache = new Map<SupportedLanguage, Promise<void>>();

let highlighterPromise:
  | Promise<Awaited<ReturnType<typeof import("@shikijs/core")["createHighlighterCore"]>>>
  | undefined;

async function highlighter() {
  if (!highlighterPromise) {
    highlighterPromise = Promise.all([
      import("@shikijs/core"),
      import("@shikijs/engine-javascript"),
      import("@shikijs/themes/github-light-default"),
      import("@shikijs/themes/github-dark-default"),
    ]).then(([core, engine, light, dark]) =>
      core.createHighlighterCore({
        engine: engine.createJavaScriptRegexEngine(),
        langs: [],
        themes: [light.default, dark.default],
        warnings: false,
      }),
    );
  }
  return highlighterPromise;
}

function normalizedLanguage(language: string | null) {
  const normalized = language?.trim().toLowerCase() ?? "text";
  if (["plain", "plaintext", "text", "txt"].includes(normalized)) return "text";
  if (Object.hasOwn(languageLoaders, normalized)) return normalized as SupportedLanguage;
  return languageAliases[normalized];
}

async function ensureLanguage(language: SupportedLanguage) {
  const existing = languageLoadCache.get(language);
  if (existing) return existing;
  const loading = Promise.all([highlighter(), languageLoaders[language]()]).then(
    async ([instance, registration]) => {
      if (!instance.getLoadedLanguages().includes(language)) {
        await instance.loadLanguage(registration);
      }
    },
  );
  languageLoadCache.set(language, loading);
  return loading;
}

function cacheHighlight(key: string, value: Promise<HighlightedCode | undefined>) {
  highlightCache.set(key, value);
  while (highlightCache.size > MAX_HIGHLIGHT_CACHE_ENTRIES) {
    const oldest = highlightCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    highlightCache.delete(oldest);
  }
}

function highlight(code: string, language: string | null) {
  if (code.length > MAX_HIGHLIGHT_CHARACTERS) return Promise.resolve(undefined);
  const normalized = normalizedLanguage(language);
  if (!normalized) return Promise.resolve(undefined);
  const key = `${normalized}\0${code}`;
  const cached = highlightCache.get(key);
  if (cached) return cached;

  const pending = (async (): Promise<HighlightedCode | undefined> => {
    try {
      const instance = await highlighter();
      if (normalized !== "text") await ensureLanguage(normalized);
      const result = instance.codeToTokens(code, {
        lang: normalized,
        themes: {
          dark: "github-dark-default",
          light: "github-light-default",
        },
        tokenizeMaxLineLength: 4_000,
        tokenizeTimeLimit: 1_000,
      });
      return { lines: result.tokens as HighlightToken[][] };
    } catch {
      return undefined;
    }
  })();
  cacheHighlight(key, pending);
  return pending;
}

export function RichCodeBlock({
  language,
  meta,
  value,
}: {
  language: string | null;
  meta: string | null;
  value: string;
}) {
  const [highlighted, setHighlighted] = useState<HighlightedCode>();

  useEffect(() => {
    let active = true;
    setHighlighted(undefined);
    void highlight(value, language).then((result) => {
      if (active && result) setHighlighted(result);
    });
    return () => {
      active = false;
    };
  }, [language, value]);

  const label = language ? `Scrollable ${language} code` : "Scrollable code";
  return (
    <pre
      aria-label={label}
      className="reader-document-code"
      data-language={language ?? undefined}
      data-meta={meta ?? undefined}
      data-reader-code={highlighted ? "highlighted" : "raw"}
      tabIndex={0}
    >
      <code className={language ? `language-${language}` : undefined}>
        {highlighted
          ? highlighted.lines.map((line, lineIndex) => (
              <span className="reader-code-line" key={lineIndex}>
                {line.map((token, tokenIndex) => (
                  <span
                    className="reader-code-token"
                    key={tokenIndex}
                    style={token.htmlStyle as CSSProperties | undefined}
                  >
                    {token.content}
                  </span>
                ))}
                {lineIndex < highlighted.lines.length - 1 ? "\n" : null}
              </span>
            ))
          : value}
      </code>
    </pre>
  );
}
