// Every shortcut the app answers to, in one place: the Keyboard section of Settings reads it,
// and the views that bind the keys keep their hint copy in step with it.

export interface Shortcut { keys: string; action: string }
export interface ShortcutGroup { title: string; shortcuts: Shortcut[] }

export const KEYBOARD_MAP: ShortcutGroup[] = [
  { title: "Everywhere", shortcuts: [
    { keys: "⌘N", action: "Add a page, feed or arXiv category" },
    { keys: "⌘K", action: "Search titles across the library and inbox" },
    { keys: "⌘J", action: "Toggle the Agent panel" },
    { keys: "⌘,", action: "Settings" },
    { keys: "⌘\\", action: "Hide or show the sidebar" },
    { keys: "⌘.", action: "Stop the agent's current answer" },
    { keys: "Esc", action: "Close the inspector, the sheet, or the reader" },
  ] },
  { title: "Inbox and Queue", shortcuts: [
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
  { title: "Reader", shortcuts: [
    { keys: "t", action: "Pin the contents rail" },
    { keys: "i", action: "Info panel (title, author, tags, note)" },
    { keys: "n", action: "Notes panel" },
    { keys: "⌘F", action: "Find in page" },
    { keys: "⌘J", action: "Ask the agent about this material" },
  ] },
];
