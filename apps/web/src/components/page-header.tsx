import type { ReactNode } from "react";

/** A step back up the trail: a link, made by the page so it can be typed for its route. */
export interface Crumb {
  key: string;
  link: ReactNode;
}

/**
 * The bar across the top of a page: where you are (the trail, ending in this page's name,
 * which is the page's only title) and what you can do here. One per page, so every page
 * reads the same way.
 */
export function PageHeader({
  crumbs = [],
  title,
  meta,
  actions,
}: {
  crumbs?: Crumb[];
  title: ReactNode;
  /** A short fact beside the title, such as a file's format. */
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="sticky top-0 z-20 flex min-h-12 flex-wrap items-center gap-x-4 gap-y-2 border-b border-hairline bg-ground/90 px-4 py-2 backdrop-blur sm:px-6">
      <nav aria-label="Breadcrumb" className="flex min-w-0 flex-1 items-center gap-2 text-[13px]">
        {crumbs.map((c) => (
          <span key={c.key} className="flex min-w-0 shrink items-center gap-2">
            <span className="min-w-0 truncate text-ink-3 [&_a]:text-ink-3 [&_a]:no-underline [&_a:hover]:text-ink">
              {c.link}
            </span>
            <span aria-hidden="true" className="text-edge">
              /
            </span>
          </span>
        ))}
        <h1 className="m-0 min-w-0 truncate text-[14px] font-medium text-ink">{title}</h1>
        {meta && (
          <span className="tabular hidden shrink-0 text-xs text-ink-3 sm:inline">{meta}</span>
        )}
      </nav>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}
