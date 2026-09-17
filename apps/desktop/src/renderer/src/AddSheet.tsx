import { useState } from "react";
import { Button, Sheet, SheetDialog, SheetFooter, TextField } from "@read/ui";

/** One field for everything that comes in. M0 recognises page URLs; feeds and files follow. */
export function AddSheet({ open, busy, error, onClose, onSubmit }: { open: boolean; busy: boolean; error?: string | undefined; onClose: () => void; onSubmit: (url: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <Sheet isOpen={open} onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
      <SheetDialog title="Add">
        <form onSubmit={(event) => { event.preventDefault(); if (value.trim()) onSubmit(value.trim()); }} className="flex flex-col gap-4">
          <TextField autoFocus aria-label="Paste a URL" placeholder="Paste a page URL…" value={value} onChange={setValue} isDisabled={busy} {...(error ? { errorMessage: error, isInvalid: true } : {})} description="Pages are fetched once, extracted, and kept for offline reading. Or drop a PDF, Markdown, HTML or text file anywhere in the window." />
          <SheetFooter>
            <Button variant="quiet" onPress={onClose} isDisabled={busy}>Cancel</Button>
            <Button variant="primary" type="submit" isDisabled={busy || !value.trim()}>{busy ? "Fetching…" : "Read"}</Button>
          </SheetFooter>
        </form>
      </SheetDialog>
    </Sheet>
  );
}
