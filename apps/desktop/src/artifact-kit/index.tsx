import { createElement, useId, useMemo, useState, type CSSProperties, type ReactNode } from "react";

// Quire's kit for React artifacts, imported as `import { Page, Lead, Stat, … } from "quire"`. It runs
// inside the artifact sandbox (built into out/artifact-runtime/quire.js, sharing the artifact's React)
// and draws with the `q-*` classes of the sandbox stylesheet (src/main/artifact-style.ts), so a
// component the agent writes reads like the rest of Quire, follows the reader's light and dark theme,
// and cites its sources the way the reader expects. Everything here is plain markup and state: no
// network, no storage.

type Tone = "note" | "tip" | "important" | "warning" | "caution";
type ChangeTone = "positive" | "negative" | "neutral";

function cx(...names: (string | false | undefined)[]): string {
  return names.filter(Boolean).join(" ");
}

/** The artifact's page: the reader's own column, so it lines up with the title above it; `wide` for a dashboard that needs the room. */
export function Page({ children, className, wide = false }: { children?: ReactNode; className?: string; wide?: boolean }) {
  return <article className={cx("q-page", className)} data-wide={wide ? "" : undefined}>{children}</article>;
}

/** A small accent label above a title. */
export function Eyebrow({ children }: { children?: ReactNode }) {
  return <p className="q-eyebrow">{children}</p>;
}

/** The page's own heading, when the artifact shows one (the reader already shows the artifact's title above it). */
export function Title({ children }: { children?: ReactNode }) {
  return <h1 className="q-title">{children}</h1>;
}

/** The lead: the answer or main finding in one to three sentences, set a size up. */
export function Lead({ children }: { children?: ReactNode }) {
  return <p className="q-lead">{children}</p>;
}

/** A section whose title states its point; `description` is a sentence under it. */
export function Section({ title, description, children, id }: { title: ReactNode; description?: ReactNode; children?: ReactNode; id?: string }) {
  return (
    <section className="q-section" id={id}>
      <h2 className="q-section-title">{title}</h2>
      {description ? <p className="q-section-description">{description}</p> : null}
      <div className="q-section-body">{children}</div>
    </section>
  );
}

/** Prose typeset like the reader (headings, paragraphs, lists, tables) inside a component. */
export function Prose({ children }: { children?: ReactNode }) {
  return <div className="q-prose">{children}</div>;
}

/** Responsive columns: as many as fit at 260px or more each. */
export function Columns({ children }: { children?: ReactNode }) {
  return <div className="q-columns">{children}</div>;
}

export function Card({ title, children }: { title?: ReactNode; children?: ReactNode }) {
  return (
    <div className="q-card">
      {title ? <h3 className="q-card-title">{title}</h3> : null}
      {children}
    </div>
  );
}

const TONE_LABELS: Record<Tone, string> = { note: "Note", tip: "Key takeaways", important: "Important", warning: "Caveat", caution: "Caution" };

/** What the reader must not miss: takeaways (tip), a caveat (warning), context (note). */
export function Callout({ tone = "note", title, children }: { tone?: Tone; title?: ReactNode; children?: ReactNode }) {
  return (
    <aside className="q-callout" data-tone={tone} role="note">
      <p className="q-callout-title">{title ?? TONE_LABELS[tone]}</p>
      <div className="q-callout-body">{children}</div>
    </aside>
  );
}

/** A row of headline numbers. */
export function Stats({ children }: { children?: ReactNode }) {
  return <div className="q-stats">{children}</div>;
}

/** One headline number: what it measures, the value, how it changed (+12% reads positive, −3% negative unless `tone` says otherwise). */
export function Stat({ label, value, change, tone, hint }: { label: ReactNode; value: ReactNode; change?: ReactNode; tone?: ChangeTone; hint?: ReactNode }) {
  const sign = typeof change === "string" ? change.trim()[0] : undefined;
  const resolved = tone ?? (sign === "+" ? "positive" : sign === "-" || sign === "−" ? "negative" : "neutral");
  return (
    <div className="q-stat">
      <p className="q-stat-label">{label}</p>
      <p className="q-stat-value">{value}</p>
      {change !== undefined ? <p className="q-stat-change" data-tone={resolved}>{change}</p> : null}
      {hint ? <p className="q-stat-hint">{hint}</p> : null}
    </div>
  );
}

/** A link from a claim to the material it rests on; opens the material at the quoted words. */
export function Cite({ id, quote, children }: { id: string; quote?: string; children?: ReactNode }) {
  return <a className="q-cite" href={`quire:material/${id}`} data-quote={quote}>{children ?? quote ?? "source"}</a>;
}

/** A chart, table or diagram with a title that states what it shows, and its caption and source under it. */
export function Figure({ title, subtitle, caption, source, children }: { title?: ReactNode; subtitle?: ReactNode; caption?: ReactNode; source?: { id: string; label: ReactNode; quote?: string }; children?: ReactNode }) {
  return (
    <figure className="q-figure">
      {title ? <p className="q-figure-title">{title}</p> : null}
      {subtitle ? <p className="q-figure-subtitle">{subtitle}</p> : null}
      <div className="q-figure-body">{children}</div>
      {caption || source ? (
        <figcaption className="q-figure-caption">
          {caption}
          {caption && source ? " " : null}
          {source ? <>Source: <Cite id={source.id} quote={source.quote}>{source.label}</Cite></> : null}
        </figcaption>
      ) : null}
    </figure>
  );
}

/** A legend for two or more series: each label beside its colour. */
export function Legend({ items }: { items: { label: ReactNode; color: string }[] }) {
  return (
    <ul className="q-legend">
      {items.map((item, index) => <li key={index}><span className="q-legend-swatch" style={{ background: item.color }} />{item.label}</li>)}
    </ul>
  );
}

/** A quotation set apart, with the material it comes from. */
export function Quote({ children, id, source }: { children?: ReactNode; id?: string; source?: ReactNode }) {
  const quote = typeof children === "string" ? children : undefined;
  return (
    <figure className="q-quote">
      <blockquote style={{ margin: 0 }}><p className="q-quote-text">{children}</p></blockquote>
      {source ? <figcaption className="q-quote-source">— {id ? <Cite id={id} quote={quote}>{source}</Cite> : source}</figcaption> : null}
    </figure>
  );
}

export function Badge({ tone, children }: { tone?: "positive" | "negative" | "warning" | "accent"; children?: ReactNode }) {
  return <span className="q-badge" data-tone={tone}>{children}</span>;
}

export interface Column<Row> {
  key: keyof Row & string;
  label: ReactNode;
  /** Numbers read best right-aligned; the default for a column whose values are numbers. */
  align?: "left" | "right";
  /** How a value is shown; the raw value still sorts. */
  format?: (value: Row[keyof Row], row: Row) => ReactNode;
}

type Sort = { key: string; direction: "ascending" | "descending" } | undefined;

function compare(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a ?? "").localeCompare(String(b ?? ""), undefined, { numeric: true, sensitivity: "base" });
}

/** A table of rows, sortable by any column with a click on its header. */
export function DataTable<Row extends Record<string, unknown>>({ columns, rows, sortable = true, initialSort, caption }: { columns: Column<Row>[]; rows: Row[]; sortable?: boolean; initialSort?: Sort; caption?: ReactNode }) {
  const [sort, setSort] = useState<Sort>(initialSort);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const factor = sort.direction === "ascending" ? 1 : -1;
    return [...rows].sort((a, b) => factor * compare(a[sort.key], b[sort.key]));
  }, [rows, sort]);
  const alignOf = (column: Column<Row>) => column.align ?? (rows.length > 0 && rows.every((row) => typeof row[column.key] === "number") ? "right" : "left");
  const toggle = (key: string) => setSort((now) => (now?.key === key ? (now.direction === "descending" ? { key, direction: "ascending" } : undefined) : { key, direction: "descending" }));
  return (
    <div className="q-table">
      <table>
        {caption ? <caption style={{ padding: "10px 12px", textAlign: "left", color: "var(--quire-muted)", fontSize: 13 }}>{caption}</caption> : null}
        <thead>
          <tr>
            {columns.map((column) => {
              const active = sort?.key === column.key ? sort.direction : undefined;
              return (
                <th key={column.key} scope="col" data-align={alignOf(column)} aria-sort={active ?? "none"}>
                  {sortable
                    ? <button type="button" onClick={() => toggle(column.key)}>{column.label}<span className="q-sort" aria-hidden="true">{active === "ascending" ? "▲" : active === "descending" ? "▼" : "↕"}</span></button>
                    : <span>{column.label}</span>}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row, index) => (
            <tr key={index}>
              {columns.map((column) => <td key={column.key} data-align={alignOf(column)}>{column.format ? column.format(row[column.key], row) : (row[column.key] as ReactNode)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Views of the same thing, one at a time. */
export function Tabs({ tabs, initial = 0 }: { tabs: { label: ReactNode; content: ReactNode }[]; initial?: number }) {
  const [selected, setSelected] = useState(initial);
  const base = useId();
  return (
    <div>
      <div className="q-tabs-list" role="tablist">
        {tabs.map((tab, index) => (
          <button key={index} type="button" role="tab" id={`${base}-tab-${index}`} aria-controls={`${base}-panel-${index}`} aria-selected={index === selected} className="q-tab" onClick={() => setSelected(index)}>{tab.label}</button>
        ))}
      </div>
      <div role="tabpanel" id={`${base}-panel-${selected}`} aria-labelledby={`${base}-tab-${selected}`}>{tabs[selected]?.content}</div>
    </div>
  );
}

/** Events in order: when, what, and a line on why it matters. */
export function Timeline({ items }: { items: { date: ReactNode; title: ReactNode; body?: ReactNode }[] }) {
  return (
    <ol className="q-timeline">
      {items.map((item, index) => (
        <li key={index} className="q-timeline-item">
          <p className="q-timeline-date">{item.date}</p>
          <p className="q-timeline-title">{item.title}</p>
          {item.body ? <p className="q-timeline-body">{item.body}</p> : null}
        </li>
      ))}
    </ol>
  );
}

interface TooltipEntry { name?: ReactNode; value?: unknown; color?: string; dataKey?: unknown; payload?: { fill?: string } }

/** Recharts' tooltip, drawn in the reader's colours: the label, then each series with its colour and value. */
export function ChartTooltip({ active, payload, label, format }: { active?: boolean; payload?: TooltipEntry[]; label?: ReactNode; format?: (value: unknown) => ReactNode }) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="q-chart-tooltip">
      {label !== undefined && label !== "" ? <p style={{ margin: "0 0 4px", fontWeight: 600 }}>{label}</p> : null}
      {payload.map((entry, index) => (
        <p key={index} style={{ display: "flex", alignItems: "center", gap: 6, margin: 0 }}>
          <span className="q-legend-swatch" style={{ background: entry.color ?? entry.payload?.fill }} />
          <span style={{ color: "var(--quire-muted)" }}>{entry.name}</span>
          <span style={{ marginLeft: "auto", paddingLeft: 12, fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>{format ? format(entry.value) : String(entry.value)}</span>
        </p>
      ))}
    </div>
  );
}

const COLORS = Array.from({ length: 8 }, (_, index) => `var(--quire-chart-${index + 1})`);

/**
 * Recharts props in the reader's style: spread `chart.axis` on XAxis / YAxis, `chart.grid` on
 * CartesianGrid, `chart.tooltip` on Tooltip, and colour series in order with `chart.color(i)`.
 * The colours are a fixed, colour-blind-checked order; past eight series, group the rest as "Other".
 */
export const chart = {
  colors: COLORS,
  color: (index: number): string => COLORS[index % COLORS.length]!,
  axis: { stroke: "var(--quire-border)", tick: { fill: "var(--quire-muted)", fontSize: 12 }, tickLine: false, axisLine: { stroke: "var(--quire-border)" } },
  grid: { stroke: "var(--quire-border)", strokeDasharray: "3 3", vertical: false },
  tooltip: { content: createElement(ChartTooltip), cursor: { fill: "color-mix(in srgb, var(--quire-fg) 5%, transparent)", stroke: "var(--quire-border)" } as CSSProperties },
  margin: { top: 8, right: 16, bottom: 4, left: 0 },
  bar: { radius: [4, 4, 0, 0] as [number, number, number, number], maxBarSize: 48 },
  line: { strokeWidth: 2, dot: false, activeDot: { r: 4 } },
};
