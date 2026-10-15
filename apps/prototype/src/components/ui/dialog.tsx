import { type ReactNode, useEffect } from "react";
import { Icon } from "~/components/icons";
import { cn } from "~/lib/cn";

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
  return (
    <div className="absolute inset-0 z-40 flex items-end justify-center bg-canvas/70 p-0 backdrop-blur-[2px] @3xl/app:items-center @3xl/app:p-6">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 cursor-default"
      />
      <div
        role="dialog"
        aria-label={title}
        className={cn(
          "rise-in relative flex max-h-full w-full flex-col overflow-hidden rounded-t-panel-lg bg-overlay shadow-4 @3xl/app:rounded-panel-lg",
          width === "sm" && "@3xl/app:max-w-[420px]",
          width === "md" && "@3xl/app:max-w-[560px]",
          width === "lg" && "@3xl/app:max-w-[760px]",
          width === "xl" && "@3xl/app:max-w-[960px]",
        )}
      >
        <div className="flex items-start gap-3 px-5 pt-4 pb-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-[16px] font-medium text-ink">{title}</h2>
            {description && <p className="mt-0.5 text-[13px] text-ink-3">{description}</p>}
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
        <div className="scroll-quiet min-h-0 flex-1 overflow-auto px-5 pb-5">{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
