import { Link } from "@tanstack/react-router";
import { cn } from "~/lib/cn";

const sections = [
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
    id: "patch",
    label: "Patch list",
    to: "/projects/$projectId/patch",
    needs: "view_production",
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
    <nav aria-label="Production" className="flex h-9 items-stretch gap-1 border-b border-line">
      {shown.map((s) => (
        <Link
          key={s.id}
          to={s.to}
          params={{ projectId }}
          aria-current={s.id === current ? "page" : undefined}
          className={cn(
            "-mb-px inline-flex items-center border-b-2 px-2.5 text-[13px] font-medium transition-colors",
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
