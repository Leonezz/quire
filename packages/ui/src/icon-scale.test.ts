import { describe, expect, it } from "vitest";

// The icon scale cannot regress silently: every lucide glyph in the UI package and the renderer is
// sized by a primitive's slot rule or by <Icon size>, never by a class at the call site. This test
// reads the sources as text (no build) and names each offender as file:line.

type Sources = Record<string, string>;
// Vite reads the glob options statically, so each call spells them out.
const sources: Sources = {
  ...(import.meta.glob("./**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true }) as Sources),
  ...(import.meta.glob("../../../apps/desktop/src/renderer/src/**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true }) as Sources),
};
const tokens = import.meta.glob("./tokens.css", { query: "?raw", import: "default", eager: true }) as Sources;
const theme = import.meta.glob("./theme.css", { query: "?raw", import: "default", eager: true }) as Sources;

const isPrimitive = (path: string) => /\/primitives\/[A-Za-z]+\.tsx$/.test(path) && !path.endsWith("/Icon.tsx");
const skip = (path: string) => /\.test\.tsx?$/.test(path) || path.endsWith("/Icon.tsx");

/** Local names imported from lucide-react (`Search as SearchIcon` → SearchIcon). */
function lucideNames(source: string): string[] {
  return [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*"lucide-react"/g)]
    .flatMap((match) => match[1]!.split(",").map((entry) => entry.trim().split(/\s+as\s+/).pop()!).filter(Boolean))
    .filter((name) => /^[A-Z]/.test(name));
}

const lineOf = (source: string, index: number) => source.slice(0, index).split("\n").length;
const SIZE_CLASS = /(?<![\w-])(?:size|w|h)-(?:\d+(?:\.\d+)?|\[[^\]]+\]|icon-\w+)(?![\w.-])/;

function violationsOf(path: string, source: string): string[] {
  const found: string[] = [];
  const report = (index: number, why: string) => { found.push(`${path}:${lineOf(source, index)}: ${why}`); };

  // 1. A raw lucide glyph sized at the call site: `<Copy className="size-3.5" />`.
  const names = lucideNames(source);
  if (names.length) {
    for (const match of source.matchAll(new RegExp(`<(${names.join("|")})\\b([^>]*?)/?>`, "g"))) {
      const classes = /className=(?:"([^"]*)"|\{`([^`]*)`\}|\{"([^"]*)"\})/.exec(match[2]!);
      const value = classes?.[1] ?? classes?.[2] ?? classes?.[3];
      if (value && SIZE_CLASS.test(value)) report(match.index, `<${match[1]}> is sized by a class (${SIZE_CLASS.exec(value)![0]}); use <Icon size> or the primitive's slot`);
    }
  }
  // 2. <Icon> takes `size`, not a class.
  for (const match of source.matchAll(/<Icon\b([^>]*?)\/?>/g)) {
    const classes = /className="([^"]*)"/.exec(match[1]!);
    if (classes && SIZE_CLASS.test(classes[1]!)) report(match.index, `<Icon> is sized by a class (${SIZE_CLASS.exec(classes[1]!)![0]}); use the size prop`);
  }
  // 3. Slot rules live in the primitives and only ever point at the scale.
  for (const match of source.matchAll(/\[&>svg[^\]]*\]:size-([\w.[\]-]+)/g)) {
    if (!isPrimitive(path)) report(match.index, `icon slot rule "${match[0]}" outside the primitives; the primitive owns its icon size`);
    else if (!/^icon-(sm|md|lg)$/.test(match[1]!)) report(match.index, `icon slot rule "${match[0]}" is off the scale (size-icon-sm/md/lg)`);
  }
  return found;
}

describe("icon scale", () => {
  it("is declared once, in the tokens, and exposed as size-icon-* utilities", () => {
    const css = Object.values(tokens)[0]!;
    expect(css).toMatch(/--icon-sm:\s*14px/);
    expect(css).toMatch(/--icon-md:\s*18px/);
    expect(css).toMatch(/--icon-lg:\s*22px/);
    const utilities = Object.values(theme)[0]!;
    for (const size of ["sm", "md", "lg"]) expect(utilities).toContain(`@utility size-icon-${size} { width: var(--icon-${size}); height: var(--icon-${size}); }`);
    expect(utilities).toMatch(/svg\.lucide\s*\{\s*stroke-width:\s*var\(--icon-stroke\)/);
  });

  it("covers both source trees", () => {
    const paths = Object.keys(sources);
    expect(paths.some((path) => path.endsWith("/primitives/Toolbar.tsx"))).toBe(true);
    expect(paths.some((path) => path.endsWith("/renderer/src/ReaderToolbar.tsx"))).toBe(true);
  });

  it("sizes every lucide glyph through <Icon> or a primitive's slot rule", () => {
    const violations = Object.entries(sources)
      .filter(([path]) => !skip(path))
      .flatMap(([path, source]) => violationsOf(path, source));
    expect(violations).toEqual([]);
  });

  it("names the offending line", () => {
    const sample = 'import { Copy } from "lucide-react";\nconst a = 1;\nconst b = <Copy className="size-3.5" />;\nconst c = <div className="[&>svg]:size-4" />;';
    expect(violationsOf("src/Example.tsx", sample)).toEqual([
      expect.stringContaining("src/Example.tsx:3: <Copy> is sized by a class (size-3.5)"),
      expect.stringContaining('src/Example.tsx:4: icon slot rule "[&>svg]:size-4" outside the primitives'),
    ]);
    expect(violationsOf("src/primitives/Button.tsx", 'x("[&>svg:not(.icon)]:size-icon-md [&>svg]:size-[15px]")')).toEqual([
      expect.stringContaining('icon slot rule "[&>svg]:size-[15px]" is off the scale'),
    ]);
  });
});
