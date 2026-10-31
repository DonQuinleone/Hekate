import { type NodeType, nodeTypes } from "@hekate/shared";
import { Icon } from "~/components/icons";
import { cn } from "~/lib/cn";
import { GROUP_ORDER, groupOf, groups, type KindGroup, kindsByGroup } from "~/lib/workflow-kinds";
import { nodeLooks } from "~/lib/workflow-nodes";

/** A kind's icon in its family's colour: on a node, in the picker, wherever kinds are offered. */
export function KindTile({ type, size = "md" }: { type: NodeType; size?: "sm" | "md" | "lg" }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 items-center justify-center rounded-control",
        size === "lg" ? "size-8" : size === "md" ? "size-7" : "size-5 rounded-[4px]",
        groups[groupOf(type)].tile,
      )}
    >
      <Icon name={nodeLooks[type].icon} size={size === "lg" ? 16 : size === "md" ? 14 : 12} />
    </span>
  );
}

/** A family's icon in its colour, where the family itself is offered. */
export function GroupTile({ group }: { group: KindGroup }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-control",
        groups[group].tile,
      )}
    >
      <Icon name={groups[group].icon} size={14} />
    </span>
  );
}

/** The families, each with its shape and colour, as a key to the canvas. */
export function GroupLegend({ compact = false }: { compact?: boolean }) {
  return (
    <div
      className={cn("flex flex-wrap gap-x-4 gap-y-1.5", compact ? "text-[11px]" : "text-[12px]")}
    >
      {GROUP_ORDER.map((g) => (
        <span key={g} className="flex items-center gap-1.5 text-ink-3" title={groups[g].hint}>
          <span className={cn("inline-block h-2.5 w-4", groups[g].swatch)} />
          {groups[g].label}
        </span>
      ))}
    </div>
  );
}

/**
 * Every kind of node, by family, each with its icon, colour, name and what it does: the legend
 * the reference page shows (#512).
 */
export function KindLegend() {
  return (
    <div className="grid gap-x-8 gap-y-5 @3xl/app:grid-cols-2">
      {GROUP_ORDER.map((g) => (
        <section key={g} aria-label={groups[g].label} className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className={cn("inline-block h-2.5 w-4", groups[g].swatch)} />
            <span className="text-[13px] font-medium text-ink">{groups[g].label}</span>
            <span className="min-w-0 truncate text-[12px] text-ink-3">{groups[g].hint}</span>
          </div>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {kindsByGroup[g].map((t) => (
              <li key={t} className="flex items-center gap-2.5">
                <KindTile type={t} />
                <span className="min-w-0">
                  <span className="block truncate text-[13px] text-ink">{nodeTypes[t].label}</span>
                  <span className="block truncate text-[12px] text-ink-3">{nodeLooks[t].hint}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
