import { Button } from "./Button";
import { Sheet, SheetDialog, SheetFooter } from "./Sheet";

export interface ConfirmSheetProps {
  isOpen: boolean;
  title: string;
  /** What happens, in one or two sentences. */
  message: React.ReactNode;
  /** The confirming button's label ("Delete 3"); it is the primary action of the sheet. */
  confirmLabel: string;
  cancelLabel?: string | undefined;
  /** Shown instead of `confirmLabel` while `busy`. */
  busyLabel?: string | undefined;
  busy?: boolean | undefined;
  /** A failure of the last attempt, shown inside the sheet so it is never lost behind it. */
  error?: string | undefined;
  onConfirm: () => void;
  onCancel: () => void;
}

/** A yes/no sheet for an action that cannot be undone. Esc and outside click cancel unless it is busy. */
export function ConfirmSheet({ isOpen, title, message, confirmLabel, cancelLabel = "Cancel", busyLabel, busy = false, error, onConfirm, onCancel }: ConfirmSheetProps) {
  return (
    <Sheet isOpen={isOpen} onOpenChange={(next) => { if (!next && !busy) onCancel(); }}>
      <SheetDialog title={title}>
        <p className="m-0 text-[13.5px] text-label-2">{message}</p>
        {error ? <p role="alert" className="m-0 rounded-card bg-red-soft px-3 py-2 text-[12.5px] text-red-text">{error}</p> : null}
        <SheetFooter>
          <Button variant="quiet" onPress={onCancel} isDisabled={busy}>{cancelLabel}</Button>
          <Button variant="primary" autoFocus onPress={onConfirm} isDisabled={busy}>{busy ? (busyLabel ?? confirmLabel) : confirmLabel}</Button>
        </SheetFooter>
      </SheetDialog>
    </Sheet>
  );
}
