import { Link } from "@tanstack/react-router";
import { cn } from "~/lib/cn";

const sections = [
  { id: "sessions", label: "Sessions", to: "/projects/$projectId/sessions" },
  { id: "score", label: "Score marking", to: "/projects/$projectId/score-marking" },
] as const;

/** Production's own sections, as the prototype has them under the area's title. */
export function ProductionNav({
  projectId,
  current,
}: {
  projectId: string;
  current: (typeof sections)[number]["id"];
}) {
  return (
    <nav aria-label="Production" className="flex h-9 items-stretch gap-1 border-b border-line">
      {sections.map((s) => (
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
