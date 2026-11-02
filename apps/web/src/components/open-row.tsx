import type { ReactNode } from "react";
import { Icon } from "~/components/icons";
import { cn } from "~/lib/cn";

/**
 * A row of a settings list that opens on a click as a whole (#691), with a chevron at its end,
 * rather than a text link repeated on every row. A dialog opens with `onOpen`, a page with
 * `href` (in a new tab when it is elsewhere). Its secondary actions go in `menu`, an action
 * menu kept above the row's click.
 */
export function OpenRow({
  name,
  hint,
  onOpen,
  href,
  label,
  menu,
  aside,
}: {
  name: ReactNode;
  hint?: ReactNode;
  onOpen?: () => void;
  href?: string;
  /**
   * What opening it does, for a screen reader, where the name alone does not say. Read before
   * the row's own words, never in place of them: the visible text stays in its name.
   */
  label?: string;
  menu?: ReactNode;
  /** A quiet fact before the chevron, such as a time. */
  aside?: ReactNode;
}) {
  const inner = (
    <>
      {label && <span className="sr-only">{label}: </span>}
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] text-ink">{name}</span>
        {hint && <span className="mt-0.5 block text-[13px] text-ink-3">{hint}</span>}
      </span>
    </>
  );
  const target = cn(
    "flex min-w-0 flex-1 items-center gap-3 text-left focus-visible:outline-none",
    // The whole row answers the click; the menu sits above it.
    "after:absolute after:inset-0 after:rounded-[inherit] focus-visible:after:ring-2 focus-visible:after:ring-edge-strong focus-visible:after:ring-inset",
  );
  return (
    <div className="group relative flex items-center gap-3 px-4 py-row transition-colors hover:bg-raised/40">
      {href ? (
        <a
          href={href}
          className={target}
          {...(/^https?:/.test(href) ? { target: "_blank", rel: "noopener noreferrer" } : {})}
        >
          {inner}
        </a>
      ) : (
        <button type="button" onClick={onOpen} className={target}>
          {inner}
        </button>
      )}
      {aside && <span className="shrink-0 text-[12px] text-ink-3">{aside}</span>}
      {menu && <span className="relative z-10 shrink-0">{menu}</span>}
      <Icon
        name={href && /^https?:/.test(href) ? "external" : "chevronRight"}
        size={14}
        className="shrink-0 text-ink-3 transition-colors group-hover:text-ink-2"
      />
    </div>
  );
}
