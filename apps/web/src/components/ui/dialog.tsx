import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "~/components/icons";
import { cn } from "~/lib/cn";
import { Button } from "./button";

const DialogHost = createContext<HTMLElement | null>(null);

/**
 * Where dialogs open: the pane the page is drawn on. A dialog is drawn here whichever component
 * opens it, so it covers the whole pane rather than the box (a column, a page settling in) it
 * happens to be declared in.
 */
export function DialogLayer({ children, className }: { children: ReactNode; className?: string }) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  return (
    <div ref={setHost} className={className}>
      <DialogHost.Provider value={host}>{children}</DialogHost.Provider>
    </div>
  );
}

/** A floating sheet over the page: a form, a confirmation, a chooser. Escape closes it. */
export function Dialog({
  title,
  description,
  onClose,
  children,
  footer,
  width = "md",
}: {
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: "sm" | "md" | "lg" | "xl";
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const host = useContext(DialogHost);
  const sheet = (
    <div className="absolute inset-0 z-40 flex items-end justify-center bg-canvas/70 p-0 backdrop-blur-[2px] @3xl/app:items-center @3xl/app:p-6">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 cursor-default"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          "rise-in relative flex max-h-full w-full flex-col overflow-hidden rounded-t-panel-lg bg-overlay shadow-4 @3xl/app:rounded-panel-lg",
          width === "sm" && "@3xl/app:max-w-[420px]",
          width === "md" && "@3xl/app:max-w-[560px]",
          width === "lg" && "@3xl/app:max-w-[760px]",
          width === "xl" && "@3xl/app:max-w-[960px]",
        )}
      >
        <div className={cn("flex items-start gap-3 px-5 pt-4", children ? "pb-3" : "pb-5")}>
          <div className="min-w-0 flex-1">
            <h2 className="text-[16px] font-medium text-ink">{title}</h2>
            {description && <p className="mt-0.5 text-[13px] text-ink-2">{description}</p>}
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="-mr-2 flex size-8 items-center justify-center rounded-control text-ink-3 transition-colors hover:bg-raised hover:text-ink"
          >
            <Icon name="close" size={14} />
          </button>
        </div>
        {/* A confirmation that says all it needs in its description has no body. */}
        {children && (
          <div className="scroll-quiet min-h-0 flex-1 overflow-auto px-5 pb-5">{children}</div>
        )}
        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
  // Outside a pane (sign-in, say), where it is declared.
  return host ? createPortal(sheet, host) : sheet;
}

/** What a confirmation asks: the thing named, what will happen, and the action's own words. */
export interface Confirmation {
  /** A question naming the thing: "Delete the group Strings?" */
  title: string;
  /** What will happen, and what will not come back. */
  description: string;
  /** The danger button's words, a verb and its object: "Delete group". */
  action: string;
  /** Done when it settles; what it throws is shown in the dialog, which stays open. */
  onConfirm: () => unknown;
  /** Anything more to say or choose, between the description and the buttons. */
  children?: ReactNode;
}

/**
 * Asks before something that cannot be taken back: the thing named in the title, what will
 * happen beneath it, Cancel and the danger action at the right of the foot. The action waits
 * for its work; a refusal is said in the dialog, which stays open to try again or cancel.
 */
export function ConfirmDialog({
  title,
  description,
  action,
  onConfirm,
  onClose,
  children,
}: Confirmation & { onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const confirm = async () => {
    setBusy(true);
    setFailed(null);
    try {
      await onConfirm();
      onClose();
    } catch (error) {
      setFailed(error instanceof Error ? error.message : "That did not work. Try again.");
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={title}
      description={description}
      onClose={onClose}
      width="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" disabled={busy} onClick={() => void confirm()}>
            {action}
          </Button>
        </>
      }
    >
      {children || failed ? (
        <>
          {children}
          {failed && (
            <p role="alert" className="m-0 text-[13px] text-signal">
              {failed}
            </p>
          )}
        </>
      ) : null}
    </Dialog>
  );
}

/**
 * A confirmation asked from anywhere (a menu item, a row's button): `ask` opens it, and the
 * dialog it returns is drawn where the caller puts it.
 */
export function useConfirm(): [(confirmation: Confirmation) => void, ReactNode] {
  const [asked, setAsked] = useState<Confirmation | null>(null);
  const dialog = asked ? <ConfirmDialog {...asked} onClose={() => setAsked(null)} /> : null;
  return [setAsked, dialog];
}
