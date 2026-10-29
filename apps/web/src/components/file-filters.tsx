import type { BrowserFilter } from "@hekate/shared";
import { Floating } from "~/components/ui/floating";
import type { BrowserFilters } from "~/lib/browser";
import { cn } from "~/lib/cn";
import type { Tag } from "~/lib/queries";
import { Icon, type IconName } from "./icons";
import { usePopover } from "./ui/menu";

export const filterNames: Record<BrowserFilter, { label: string; icon: IconName }> = {
  comments: { label: "With open comments", icon: "comment" },
  unviewed: { label: "Not yet viewed", icon: "eye" },
  mine: { label: "Uploaded by me", icon: "user" },
  favourites: { label: "Favourites", icon: "star" },
};
const order: BrowserFilter[] = ["unviewed", "comments", "mine", "favourites"];

/** One choice in the filter menu: on or off. */
function Choice({
  on,
  icon,
  label,
  count,
  onToggle,
}: {
  on: boolean;
  icon: IconName;
  label: string;
  count?: number;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onToggle}
      className="flex h-8 w-full items-center gap-2.5 rounded-control px-2 text-left text-[13px] text-ink transition-colors hover:bg-raised"
    >
      <Icon name={icon} size={14} className="shrink-0 text-ink-3" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined && <span className="tabular text-[12px] text-ink-3">{count}</span>}
      <span className="flex w-4 shrink-0 justify-end">
        {on && <Icon name="check" size={13} className="text-ink" />}
      </span>
    </button>
  );
}

/**
 * The Filter control beside the views: ways of looking at the whole project (what you have not
 * seen, what has open threads, what you uploaded, your favourites) and the workspace's tags.
 */
export function FilterMenu({
  filters,
  tags,
  onChange,
}: {
  filters: BrowserFilters;
  tags: Tag[];
  onChange: (filters: BrowserFilters) => void;
}) {
  const [open, setOpen, box] = usePopover();
  const active = filters.show.length + filters.tags.length;
  const toggle = <T,>(list: T[], value: T) =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen(!open)}
        className={cn(
          "flex h-8 items-center gap-1.5 rounded-control px-2.5 text-[13px] transition-colors hover:bg-raised hover:text-ink",
          active ? "text-ink" : "text-ink-3",
        )}
      >
        <Icon name="filter" size={14} />
        Filter
        {active > 0 && (
          <span className="tabular rounded-full bg-raised px-1.5 text-[11px] text-ink-2">
            {active}
          </span>
        )}
      </button>
      {open && (
        <Floating
          anchor={box}
          align="start"
          side="bottom"
          onClose={() => setOpen(false)}
          role="dialog"
          aria-label="Filter files"
          data-e2e-overlap
          // On a phone the Filter control starts its row, so the menu opens to the right of it.
          className="rise-in w-64 rounded-panel-lg bg-overlay p-1.5 shadow-4"
        >
          <p className="eyebrow m-0 px-2 pt-1 pb-1 text-ink-3">Show only</p>
          {order.map((f) => (
            <Choice
              key={f}
              on={filters.show.includes(f)}
              icon={filterNames[f].icon}
              label={filterNames[f].label}
              onToggle={() => onChange({ ...filters, show: toggle(filters.show, f) })}
            />
          ))}
          <div className="mx-2 my-1.5 h-px bg-line" />
          <p className="eyebrow m-0 px-2 pt-1 pb-1 text-ink-3">Tagged</p>
          {tags.length === 0 ? (
            <p className="m-0 px-2 pb-2 text-[12px] text-ink-3">
              No tags yet. Tag a file from its menu.
            </p>
          ) : (
            <div className="scroll-quiet max-h-56 overflow-y-auto">
              {tags.map((t) => (
                <Choice
                  key={t.id}
                  on={filters.tags.includes(t.id)}
                  icon="tag"
                  label={t.name}
                  count={t.files}
                  onToggle={() => onChange({ ...filters, tags: toggle(filters.tags, t.id) })}
                />
              ))}
            </div>
          )}
          {active > 0 && (
            <div className="mt-1 border-t border-line px-2 pt-2 pb-1">
              <button
                type="button"
                onClick={() => onChange({ show: [], tags: [] })}
                className="text-[12px] text-ink-2 hover:text-ink"
              >
                Clear filters
              </button>
            </div>
          )}
        </Floating>
      )}
    </div>
  );
}

/** The filters in force, each removable, so nobody wonders why things are missing. */
export function FilterChips({
  filters,
  tags,
  onChange,
}: {
  filters: BrowserFilters;
  tags: Tag[];
  onChange: (filters: BrowserFilters) => void;
}) {
  const chips = [
    ...filters.show.map((f) => ({
      key: f,
      label: filterNames[f].label,
      icon: filterNames[f].icon,
      remove: () => onChange({ ...filters, show: filters.show.filter((x) => x !== f) }),
    })),
    ...filters.tags.map((id) => ({
      key: id,
      label: tags.find((t) => t.id === id)?.name ?? "Tag",
      icon: "tag" as IconName,
      remove: () => onChange({ ...filters, tags: filters.tags.filter((x) => x !== id) }),
    })),
  ];
  return (
    <ul aria-label="Filters" className="m-0 flex list-none flex-wrap items-center gap-1.5 p-0">
      {chips.map((c) => (
        <li
          key={c.key}
          className="flex h-7 items-center gap-1.5 rounded-full border border-line bg-raised/40 pr-1 pl-2.5 text-[12px] text-ink-2"
        >
          <Icon name={c.icon} size={12} className="text-ink-3" />
          {c.label}
          <button
            type="button"
            aria-label={`Remove the filter ${c.label}`}
            onClick={c.remove}
            className="flex size-5 items-center justify-center rounded-full text-ink-3 hover:bg-raised hover:text-ink"
          >
            <Icon name="close" size={11} />
          </button>
        </li>
      ))}
      <li>
        <button
          type="button"
          onClick={() => onChange({ show: [], tags: [] })}
          className="px-1.5 text-[12px] text-ink-3 hover:text-ink"
        >
          Clear
        </button>
      </li>
    </ul>
  );
}
