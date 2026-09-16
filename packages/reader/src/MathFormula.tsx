import {
  createElement,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";

const MAX_MATH_CHARACTERS = 10_000;
const MATH_OVERFLOW_TOLERANCE_PX = 4;

/**
 * Some long-running RSS publishers emit MathJax-era macro declarations such
 * as `\newcommand{tr}{...}`. The first argument is not valid LaTeX (it should
 * be `\tr`), and a declaration inside an AMS row would also be scoped before
 * later rows use it. Converting only this malformed, bare-name shape to a
 * formula-local global definition preserves the source value while making the
 * intended macro available throughout the one KaTeX render.
 */
function texSourceForKatex(value: string) {
  return value.replace(
    /\\newcommand\s*\{\s*([A-Za-z@]+)\s*\}/g,
    (_declaration, name: string) => `\\gdef\\${name}`,
  );
}

const MATHML_ELEMENTS = new Set([
  "annotation",
  "math",
  "merror",
  "mfrac",
  "mi",
  "mn",
  "mo",
  "mover",
  "mmultiscripts",
  "mpadded",
  "mphantom",
  "mprescripts",
  "mroot",
  "mrow",
  "ms",
  "mspace",
  "none",
  "msqrt",
  "mstyle",
  "msub",
  "msubsup",
  "msup",
  "mtable",
  "mtd",
  "mtext",
  "mtr",
  "munder",
  "munderover",
  "semantics",
]);

const MATHML_ATTRIBUTES = new Set([
  "columnalign",
  "columnspan",
  "depth",
  "display",
  "displaystyle",
  "encoding",
  "height",
  "linethickness",
  "mathcolor",
  "mathsize",
  "mathvariant",
  "rowalign",
  "rowspan",
  "scriptlevel",
  "title",
  "width",
]);

function mathMlReactNode(node: Node, key: string): ReactNode | undefined {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (node.nodeType !== Node.ELEMENT_NODE) return undefined;
  const element = node as Element;
  const tagName = element.localName.toLowerCase();
  if (!MATHML_ELEMENTS.has(tagName)) return undefined;

  const attributes: Record<string, string> = { key };
  for (const attribute of Array.from(element.attributes)) {
    const name = attribute.localName.toLowerCase();
    if (!MATHML_ATTRIBUTES.has(name)) continue;
    attributes[
      name === "columnspan"
        ? "columnSpan"
        : name === "rowspan"
          ? "rowSpan"
          : name
    ] = attribute.value;
  }
  const children: ReactNode[] = [];
  for (const [index, child] of Array.from(element.childNodes).entries()) {
    const rendered = mathMlReactNode(child, `${key}-${index}`);
    if (rendered === undefined) return undefined;
    children.push(rendered);
  }
  return createElement(tagName, attributes, ...children);
}

function parseMathMl(value: string) {
  if (
    value.length > MAX_MATH_CHARACTERS ||
    /<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/iu.test(value)
  ) {
    return undefined;
  }
  const parsed = new DOMParser().parseFromString(value, "application/xml");
  if (
    parsed.querySelector("parsererror") ||
    parsed.documentElement.localName !== "math"
  ) {
    return undefined;
  }
  return mathMlReactNode(parsed.documentElement, "math-root");
}

export function MathFormula({
  display,
  format,
  label,
  value,
}: {
  display: boolean;
  format: "mathml" | "tex";
  label: string | null;
  value: string;
}) {
  const containerRef = useRef<HTMLElement | null>(null);
  const formulaRef = useRef<HTMLElement | null>(null);
  const renderKey = `${format}:${display ? "display" : "inline"}:${value}`;
  const [mathMl, setMathMl] = useState<{
    key: string;
    node: ReactNode;
  }>();
  const [renderedTexKey, setRenderedTexKey] = useState<string>();
  const [settledTexKey, setSettledTexKey] = useState<string>();
  const Element = display ? "div" : "span";
  const currentMathMl = mathMl?.key === renderKey ? mathMl.node : undefined;
  const texIsRendered = renderedTexKey === renderKey;
  const contentIsRendered = Boolean(currentMathMl || texIsRendered);
  const [hasOverflow, setHasOverflow] = useState(false);

  useEffect(() => {
    setMathMl(undefined);
    setRenderedTexKey(undefined);
    setSettledTexKey(undefined);
    if (value.length > MAX_MATH_CHARACTERS) return;
    if (format === "mathml") {
      const parsed = parseMathMl(value);
      if (parsed) setMathMl({ key: renderKey, node: parsed });
      return;
    }
    const container = containerRef.current;
    if (!container) return;
    let active = true;

    void Promise.all([import("katex"), import("katex/dist/katex.min.css")])
      .then(([module]) => {
        if (!active || containerRef.current !== container) return;
        module.default.render(texSourceForKatex(value), container, {
          displayMode: display,
          maxExpand: 1_000,
          maxSize: 50,
          output: "htmlAndMathml",
          strict: "ignore",
          throwOnError: true,
          trust: false,
        });
        setRenderedTexKey(renderKey);
        setSettledTexKey(renderKey);
      })
      .catch(() => {
        if (!active || containerRef.current !== container) return;
        container.replaceChildren();
        setSettledTexKey(renderKey);
      });

    return () => {
      active = false;
    };
  }, [display, format, renderKey, value]);

  useEffect(() => {
    setHasOverflow(false);
    if (!display || !contentIsRendered) return;
    const formula = formulaRef.current;
    if (!formula) return;
    let active = true;

    const measure = () => {
      if (!active) return;
      const overflowing =
        formula.scrollWidth > formula.clientWidth + MATH_OVERFLOW_TOLERANCE_PX;
      setHasOverflow((current) =>
        current === overflowing ? current : overflowing,
      );
    };

    measure();
    queueMicrotask(measure);
    window.addEventListener("resize", measure);
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(measure);
    observer?.observe(formula);
    if (containerRef.current) observer?.observe(containerRef.current);
    void document.fonts?.ready.then(measure);

    return () => {
      active = false;
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, [contentIsRendered, display, renderKey]);

  return (
    <Element
      aria-label={label ?? (display ? "Display formula" : "Inline formula")}
      className={
        display
          ? "reader-math reader-math-display"
          : "reader-math reader-math-inline"
      }
      data-reader-math={display ? "display" : "inline"}
      data-reader-math-format={format}
      data-reader-math-enhancement={
        format !== "tex"
          ? undefined
          : value.length > MAX_MATH_CHARACTERS
            ? "skipped"
            : settledTexKey === renderKey
              ? "settled"
              : "pending"
      }
      data-reader-math-overflow={
        display && contentIsRendered ? String(hasOverflow) : undefined
      }
      data-reader-math-status={contentIsRendered ? "rendered" : "source"}
      ref={(element) => {
        formulaRef.current = element;
      }}
      role="math"
      tabIndex={display && hasOverflow ? 0 : undefined}
    >
      {format === "mathml" ? (
        (currentMathMl ?? <code className="reader-math-source">{value}</code>)
      ) : (
        <>
          {texIsRendered ? null : (
            <code className="reader-math-source">{value}</code>
          )}
          {value.length <= MAX_MATH_CHARACTERS ? (
            <span
              className="reader-math-render-host"
              key={renderKey}
              ref={(element) => {
                containerRef.current = element;
              }}
            />
          ) : null}
        </>
      )}
    </Element>
  );
}
