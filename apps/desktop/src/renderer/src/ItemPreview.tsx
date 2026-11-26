import { Bookmark } from "lucide-react";
import { Button, Icon, Kbd, formatMediaClock, type ButtonVariant } from "@read/ui";
import type { ItemRecord } from "../../shared/contracts";
import { dayLabel, durationLabel, timeOf } from "./format";

export interface PreviewAction { label: string; kbd: string; onPress: () => void; variant?: ButtonVariant; icon?: React.ReactNode }

/** A visible failure inside a pane: the message and the way out. */
export function InlineError({ title, message, link, onOpenLink }: { title: string; message: string; link?: string | undefined; onOpenLink?: ((url: string) => void) | undefined }) {
  return (
    <div role="alert" className="grid gap-1.5 rounded-card bg-red-soft p-4 text-[13px] text-label-2">
      <strong className="text-[14px] text-label">{title}</strong>
      <span>{message}</span>
      {link && onOpenLink ? <a href={link} className="text-accent-text" onClick={(event) => { event.preventDefault(); onOpenLink(link); }}>Open the original ↗</a> : null}
    </div>
  );
}

/** "Kept · Open in Library": the status line at the top of the preview pane after k. */
export function KeptNoticeLine({ title, onOpen }: { title: string; onOpen: () => void }) {
  return (
    <div role="status" className="mx-9 mt-4 flex items-center gap-2 rounded-card bg-accent-soft px-3 py-2 text-[12.5px] text-label">
      <Icon of={Bookmark} size="sm" className="fill-current text-accent" />
      <span className="min-w-0 truncate">Kept <span className="text-label-2">{title}</span></span>
      <span className="text-label-3">·</span>
      <Button variant="plain" size="sm" className="h-6 px-1.5 text-[12.5px]" onPress={onOpen}>Open in Library</Button>
    </div>
  );
}

/** The right pane of Inbox and Queue: what the item is, and the decisions. Previewing does not mark it read. */
export function ItemPreview({ item, actions, busy, failure, error, kept, onOpenLink }: { item: ItemRecord; actions: PreviewAction[]; busy: boolean; failure?: { message: string; action: "read" | "keep" } | undefined; error?: string | undefined; kept?: React.ReactNode; onOpenLink: (url: string) => void }) {
  const [primary, ...rest] = actions;
  const when = `${dayLabel(item.publishedAt)} · ${timeOf(item.publishedAt)}`;
  const duration = durationLabel(item.signals.durationSec);
  const pillText = item.sourceKind === "arxiv"
    ? "arXiv abstract"
    : item.signals.media === "audio"
      ? (item.signals.hasTranscript ? "podcast · transcript" : "podcast · show notes")
      : item.signals.media === "video"
        ? (item.signals.hasTranscript ? "video · captions" : "video")
        : item.summaryOnly
          ? "summary only"
          : "feed full text";
  const pillWarn = item.summaryOnly && !item.signals.media;
  const chapters = item.signals.chapters ?? [];
  return (
    <div key={item.id} className="reader-enter flex min-h-0 flex-1 flex-col overflow-auto">
      {kept}
      <div className="px-9 pt-7">
        <div className="flex items-center gap-2 text-[12.5px] text-label-2">
          <span className="truncate">{item.sourceTitle}</span>
          <span className={`whitespace-nowrap rounded-pill px-2 py-px text-[11.5px] font-medium ${pillWarn ? "bg-orange-soft text-orange-text" : "bg-fill"}`}>{pillText}</span>
        </div>
        <h1 className="mb-1.5 mt-2.5 text-[24px] font-bold leading-[29px] tracking-[-.02em] text-balance">{item.title}</h1>
        <div className="flex flex-wrap gap-x-3 text-[12.5px] text-label-2"><span>{when}</span><span>{duration ?? `${item.readingMinutes} min`}</span>{item.openedAt ? <span>opened {dayLabel(item.openedAt).toLowerCase()}</span> : null}{item.keptAt ? <span className="inline-flex items-center gap-1"><Icon of={Bookmark} size="sm" className="fill-current" />kept</span> : null}</div>
      </div>
      <div className="flex flex-wrap items-center gap-2 px-9 py-[18px]">
        {primary ? <Button variant={primary.variant ?? "primary"} onPress={primary.onPress} isDisabled={busy}>{primary.label} <Kbd>{primary.kbd}</Kbd></Button> : null}
        {rest.map((action) => <Button key={action.label} variant={action.variant ?? "default"} onPress={action.onPress} isDisabled={busy}>{action.icon}{action.label} <Kbd>{action.kbd}</Kbd></Button>)}
        <span className="ml-auto text-[11.5px] text-label-3">Previewing does not mark it read</span>
      </div>
      <div className="grid max-w-[752px] gap-4 px-9 pb-10">
        {failure ? <InlineError title={failure.action === "keep" ? "Could not keep this item." : "Could not open this item."} message={failure.message} link={item.link} onOpenLink={onOpenLink} /> : null}
        {error ? <InlineError title="That did not go through." message={error} /> : null}
        <p className="text-[16px] leading-[1.6] text-label">{item.gist}</p>
        {chapters.length > 0 ? (
          <div className="grid gap-1.5 rounded-card bg-fill px-4 py-3">
            <span className="text-[11px] font-semibold uppercase tracking-[.07em] text-label-3">Chapters ({chapters.length})</span>
            <ol className="m-0 grid list-none gap-1 p-0 text-[13px]">
              {chapters.slice(0, 8).map((chapter) => (
                <li key={`${chapter.startSec}-${chapter.title}`} className="flex items-baseline gap-2.5">
                  <span className="shrink-0 font-mono text-[11.5px] tabular-nums text-label-3">{formatMediaClock(chapter.startSec)}</span>
                  <span className="truncate text-label">{chapter.title}</span>
                </li>
              ))}
              {chapters.length > 8 ? <li className="text-[12px] text-label-3">+{chapters.length - 8} more chapters</li> : null}
            </ol>
          </div>
        ) : null}
        <a href={item.link} className="text-[13px] text-accent-text" onClick={(event) => { event.preventDefault(); onOpenLink(item.link); }}>Open the original ↗</a>
      </div>
    </div>
  );
}
