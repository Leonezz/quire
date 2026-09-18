import { Button as AriaButton, composeRenderProps, type ButtonProps as AriaButtonProps } from "react-aria-components";
import { Check, X } from "lucide-react";
import { cx } from "../cx";

export type AgentToolStatus = "running" | "done" | "failed";

/**
 * One turn of the agent transcript: the user's words as a quiet bubble on the right,
 * the agent's answer as a plain block on the left (the caller renders its Markdown).
 */
export function AgentTurn({ role, children, className }: { role: "user" | "agent"; children: React.ReactNode; className?: string }) {
  if (role === "user") {
    return (
      <div className={cx("agent-pop flex justify-end", className)}>
        <p className="m-0 max-w-[85%] whitespace-pre-wrap break-words rounded-card bg-fill px-3 py-2 text-[13px] leading-[18px] text-label">{children}</p>
      </div>
    );
  }
  return <div className={cx("agent-pop min-w-0 text-[13.5px] leading-[19px] text-label", className)}>{children}</div>;
}

/** A tool the agent used while answering: a spinner while it runs, then a tick or a cross. */
export function AgentToolLine({ name, status, summary, className }: { name: string; status: AgentToolStatus; summary?: string | undefined; className?: string }) {
  const label = status === "running" ? "running" : status === "done" ? "done" : "failed";
  return (
    <div className={cx("agent-pop flex min-w-0 items-center gap-2 text-[12px] leading-4 text-label-3", className)} role={status === "running" ? "status" : undefined} data-status={status}>
      <span aria-label={label} role="img" className="grid size-3.5 shrink-0 place-items-center">
        {status === "running" ? <i className="block size-3 animate-spin rounded-full border-[1.5px] border-label-4 border-t-label-2" /> : null}
        {status === "done" ? <Check className="size-3.5 text-green" /> : null}
        {status === "failed" ? <X className="size-3.5 text-red" /> : null}
      </span>
      <span className="truncate"><code className="font-mono text-[11.5px] text-label-2">{name}</code>{summary ? <span> {summary}</span> : null}</span>
    </div>
  );
}

export interface CitationPillProps extends Omit<AriaButtonProps, "children"> {
  /** The cited material's id; shown when there is no `label`. */
  id: string;
  label?: string | undefined;
}

/** A citation inside an answer: a small button that opens the cited material. Enter and Space activate it. */
export function CitationPill({ id, label, className, ...props }: CitationPillProps) {
  return (
    <AriaButton
      {...props}
      aria-label={`Open ${label ?? `material ${id}`}`}
      className={composeRenderProps(className, (cls) => cx(
        "mx-0.5 inline-flex h-[18px] max-w-[220px] cursor-default items-center gap-1 rounded-pill bg-accent-soft px-1.5 align-[2px] text-[11px] font-medium leading-none text-accent-text outline-none transition-[background-color,transform] duration-100",
        "data-[hovered]:bg-accent data-[hovered]:text-on-accent data-[pressed]:scale-[.97] data-[focus-visible]:ring-[3px] data-[focus-visible]:ring-accent-ring",
        cls,
      ))}
    >
      <span className="truncate">{label ?? <span className="font-mono">{id.slice(0, 8)}</span>}</span>
    </AriaButton>
  );
}
