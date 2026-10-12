// Every shortcut the app answers to, in one place: the Keyboard section of Settings reads it,
// and the views that bind the keys keep their hint copy in step with it.

export interface Shortcut { keys: string; action: string }

/**
 * "Report a problem" from any reader view: ⌥⌘R (Ctrl+Alt+R elsewhere). R for report; ⌘⇧R is taken by the
 * View menu's force reload (and ⌘R by reload), ⌥⌘I by the developer tools, and no reader or shell handler
 * binds ⌥ with R. Matched on the physical key, since ⌥R types "®" on a Mac and `event.key` says so.
 */
export const REPORT_SHORTCUT = "⌥⌘R";
export function isReportShortcut(event: Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "code">): boolean {
  return (event.metaKey || event.ctrlKey) && event.altKey && !event.shiftKey && event.code === "KeyR";
}
export interface ShortcutGroup { title: string; shortcuts: Shortcut[] }

export const KEYBOARD_MAP: ShortcutGroup[] = [
  { title: "Everywhere", shortcuts: [
    { keys: "⌘N", action: "Add a page, feed or arXiv category" },
    { keys: "⌘K", action: "Search titles across the library and inbox" },
    { keys: "⌘J", action: "Toggle the Agent panel (the Library context when no material is open)" },
    { keys: "⌘⇧J", action: "The Agent view: every conversation" },
    { keys: "⌘,", action: "Settings" },
    { keys: "⌘\\", action: "Hide or show the sidebar" },
    { keys: "⌘.", action: "Stop the agent's current answer" },
    { keys: "Esc", action: "Close the panel, the sheet, or the reader" },
  ] },
  { title: "Sidebar", shortcuts: [
    { keys: "↑ ↓", action: "Move between scopes: Inbox, Queue, Agent, the Library's cuts, tags, sources" },
    { keys: "↵ · Space", action: "Show the focused scope" },
  ] },
  { title: "Inbox, Queue and a source", shortcuts: [
    { keys: "↑ ↓", action: "Move the selection" },
    { keys: "↵", action: "Read now" },
    { keys: "k", action: "Keep in the library without reading" },
    { keys: "q", action: "Queue (Inbox)" },
    { keys: "e", action: "Dismiss (Inbox) · Remove (Queue)" },
  ] },
  { title: "Library", shortcuts: [
    { keys: "⇧ click · ⌘ click", action: "Select several materials" },
    { keys: "⌫", action: "Delete the selected materials (asks first)" },
  ] },
  { title: "Agent", shortcuts: [
    { keys: "⌫", action: "Delete the selected conversation (asks first)" },
    { keys: "↵", action: "Send · Shift+Enter for a new line" },
  ] },
  { title: "Reader", shortcuts: [
    { keys: "v", action: "Switch view (Web · PDF · Markdown · Text) when the material has more than one; a view not stored yet is fetched (the Text view built) first" },
    { keys: "t", action: "Pin the contents rail" },
    { keys: "i", action: "Info panel (title, author, tags, note); i again closes it" },
    { keys: "n", action: "Notes panel; n again closes it" },
    { keys: "⌘F", action: "Find in page" },
    { keys: "⌘J", action: "Agent panel: ask about this material" },
    { keys: REPORT_SHORTCUT, action: "Report a rendering problem; the selected passage, if any, is attached" },
  ] },
];
