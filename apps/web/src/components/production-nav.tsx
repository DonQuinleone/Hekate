import type { ReactNode } from "react";
import { SideNav, Split } from "~/components/settings";

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
 * Production's frame, one for every section as the prototype draws it and as Settings is
 * drawn: the sections down the left (only those the role may see, so no entry leads to a
 * refusal), the current one's content at the right.
 */
export function ProductionBody({
  projectId,
  current,
  can,
  children,
}: {
  projectId: string;
  current: (typeof sections)[number]["id"];
  can: (permission: (typeof sections)[number]["needs"]) => boolean;
  children: ReactNode;
}) {
  const shown = sections.filter((s) => s.id === current || can(s.needs));
  return (
    <div className="fade-in mx-auto flex w-full max-w-[1360px] flex-col gap-6 px-5 py-6 @3xl/app:px-10 @3xl/app:py-8">
      <Split
        nav={
          <SideNav
            label="Production"
            sections={shown.map(({ id, label }) => ({ id, label }))}
            current={current}
            link={(id) => ({
              to: sections.find((s) => s.id === id)?.to ?? sections[0].to,
              params: { projectId },
            })}
          />
        }
      >
        {children}
      </Split>
    </div>
  );
}
