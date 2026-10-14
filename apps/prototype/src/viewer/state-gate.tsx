import type { ReactNode } from "react";
import { Icon } from "~/components/icons";
import { useViewer } from "./context.tsx";

/**
 * A page's alternative states, chosen from the switcher so every screen can be seen empty,
 * loading, processing, failed, refused or expired. A screen passes the states that apply
 * to it; the rest fall back to the common treatment.
 */
export function StateGate({
  children,
  empty,
  processing,
  failed,
  refused,
  expired,
  loading,
}: {
  children: ReactNode;
  empty?: ReactNode;
  processing?: ReactNode;
  failed?: ReactNode;
  refused?: ReactNode;
  expired?: ReactNode;
  loading?: ReactNode;
}) {
  const { settings } = useViewer();
  switch (settings.state) {
    case "empty":
      return <>{empty ?? children}</>;
    case "loading":
      return <>{loading ?? <Loading />}</>;
    case "processing":
      return <>{processing ?? children}</>;
    case "failed":
      return <>{failed ?? <Failed />}</>;
    case "refused":
      return <>{refused ?? <Refused />}</>;
    case "expired":
      return <>{expired ?? children}</>;
    default:
      return <>{children}</>;
  }
}

export const useScreenState = () => useViewer().settings.state;

/** Rows of placeholder blocks where the content will be: no spinner, no shift when it arrives. */
export function Loading({ rows = 6 }: { rows?: number }) {
  return (
    <output aria-live="polite" aria-label="Loading" className="flex flex-col gap-3 px-6 py-6">
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={String(i)}
          className="h-[34px] animate-pulse rounded-control bg-surface"
          style={{ width: `${[72, 48, 64, 40, 58, 52][i % 6]}%`, animationDelay: `${i * 80}ms` }}
        />
      ))}
    </output>
  );
}

export function Failed({
  title = "This could not be loaded",
  text = "Hekate could not reach the server. Your work is kept; try again in a moment.",
}: {
  title?: string;
  text?: string;
}) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-start gap-3 px-6 py-16">
      <span className="flex size-8 items-center justify-center rounded-full border border-signal/60 text-signal">
        <Icon name="close" size={14} />
      </span>
      <h2 className="m-0 text-[15px] font-medium">{title}</h2>
      <p className="m-0 text-ink-2">{text}</p>
      <button
        type="button"
        className="h-8 rounded-control border border-edge bg-raised px-3 text-[13px] text-ink shadow-1"
      >
        Try again
      </button>
    </div>
  );
}

export function Refused({
  title = "Not found",
  text = "There is nothing at this address, or you do not have access to it.",
}: {
  title?: string;
  text?: string;
}) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-start gap-3 px-6 py-16">
      <h2 className="m-0 text-[15px] font-medium">{title}</h2>
      <p className="m-0 text-ink-2">{text}</p>
    </div>
  );
}

/** A dashed well where a list will be, saying what to do first. */
export function Empty({
  title,
  text,
  action,
}: {
  title: string;
  text?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-panel-lg border border-edge border-dashed px-6 py-14 text-center">
      <h2 className="m-0 text-[15px] font-medium">{title}</h2>
      {text && <p className="m-0 max-w-sm text-ink-2">{text}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
