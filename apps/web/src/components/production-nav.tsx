import { Link } from "@tanstack/react-router";
import { cn } from "~/lib/cn";

const sections = [
  {
    id: "repertoire",
    label: "Repertoire",
    to: "/projects/$projectId/repertoire",
    needs: "view_production",
  },
  {
    id: "schedule",
    label: "Schedule",
    to: "/projects/$projectId/schedule",
    needs: "view_production",
  },
  {
    id: "sessions",
    label: "Sessions",
    to: "/projects/$projectId/sessions",
    needs: "view_takes",
  },
  {
    id: "score",
    label: "Score marking",
    to: "/projects/$projectId/score-marking",
    needs: "view_production",
  },
  {
    id: "stage",
    label: "Stage plan",
    to: "/projects/$projectId/stage",
    needs: "view_production",
  },
  {
    id: "patch",
    label: "Patch list",
    to: "/projects/$projectId/patch",
    needs: "view_production",
  },
  {
    id: "personnel",
    label: "Personnel",
    to: "/projects/$projectId/personnel",
    needs: "view_production",
  },
  {
    id: "venues",
    label: "Venues",
    to: "/projects/$projectId/venues",
    needs: "view_production",
  },
  {
    id: "import",
    label: "Import",
    to: "/projects/$projectId/import",
    needs: "edit_project",
  },
] as const;

/**
 * Production's own sections, as the prototype has them under the area's title: only those the
 * role may see, so no tab leads to a refusal.
 */
export function ProductionNav({
  projectId,
  current,
  can,
}: {
  projectId: string;
  current: (typeof sections)[number]["id"];
  can: (permission: (typeof sections)[number]["needs"]) => boolean;
}) {
  const shown = sections.filter((s) => s.id === current || can(s.needs));
  if (shown.length < 2) return null;
  return (
    // On a phone the sections scroll sideways, one line of tabs as on a wider screen.
    <nav
      aria-label="Production"
      className="scroll-quiet flex h-9 shrink-0 items-stretch gap-1 overflow-x-auto border-b border-line"
    >
      {shown.map((s) => (
        <Link
          key={s.id}
          to={s.to}
          params={{ projectId }}
          aria-current={s.id === current ? "page" : undefined}
          className={cn(
            "inline-flex shrink-0 items-center whitespace-nowrap border-b-2 px-2.5 text-[13px] font-medium transition-colors",
            s.id === current
              ? "border-ink text-ink"
              : "border-transparent text-ink-3 hover:text-ink-2",
          )}
        >
          {s.label}
        </Link>
      ))}
    </nav>
  );
}
