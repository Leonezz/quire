import { Dialog, DialogTrigger, Heading, Modal, ModalOverlay, composeRenderProps, type DialogProps, type ModalOverlayProps } from "react-aria-components";
import { cx } from "../cx";

export { DialogTrigger };

/** Centered sheet: dimmed, blurred window behind; Esc and outside click dismiss. */
export type SheetSize = "md" | "lg";
const sizes: Record<SheetSize, string> = { md: "w-[560px]", lg: "w-[760px]" };

export function Sheet({ className, children, size = "md", ...props }: ModalOverlayProps & { children: React.ReactNode; size?: SheetSize | undefined }) {
  return (
    <ModalOverlay
      {...props}
      isDismissable
      className={composeRenderProps(className, (cls) => cx("fixed inset-0 z-40 grid place-items-start justify-center bg-[rgba(15,17,21,.26)] pt-16 backdrop-blur-[6px] entering:animate-[fade_.15s_ease] exiting:animate-[fade_.12s_ease_reverse]", cls))}
    >
      <Modal className={cx(sizes[size], "max-w-[92vw] rounded-[22px] bg-content shadow-float outline-none")}>{children}</Modal>
    </ModalOverlay>
  );
}

export function SheetDialog({ title, className, children, ...props }: DialogProps & { title: string; children: React.ReactNode }) {
  return (
    <Dialog {...props} className={cx("flex flex-col gap-4 p-6 pb-5 outline-none", className)}>
      <Heading slot="title" className="m-0 text-[18px] font-semibold leading-[23px] tracking-[-.015em] text-label">{title}</Heading>
      {children}
    </Dialog>
  );
}

export function SheetFooter({ children }: { children: React.ReactNode }) {
  return <div className="flex justify-end gap-2 pt-1">{children}</div>;
}
