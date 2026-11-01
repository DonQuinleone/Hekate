import type { ReactNode } from "react";
import { ProjectBoard } from "~/components/board";
import { ProjectCalendar, thisMonth } from "~/components/calendar";
import { Icon } from "~/components/icons";
import { ProjectTimeline } from "~/components/timeline";
import { Segmented } from "~/components/ui/segmented";
import { ProjectFrame } from "~/routes/project";

const body =
  "fade-in mx-auto flex w-full max-w-[1360px] flex-col gap-6 px-5 py-6 @3xl/app:px-10 @3xl/app:py-8";

export type BoardMode = "board" | "timeline" | "calendar";

const modes = [
  { value: "board", label: "Board", icon: <Icon name="board" size={14} /> },
  { value: "timeline", label: "Timeline", icon: <Icon name="chart" size={14} /> },
  { value: "calendar", label: "Calendar", icon: <Icon name="calendar" size={14} /> },
] as const;

/**
 * A project's board (#141): where each track stands, its tracks across the weeks, or what is due
 * when, kept in the address. The views are switched from the start of the board's own toolbar,
 * as the prototype has it. A general project has no tracks to stand anywhere, so it has no
 * board and opens on its calendar.
 */
export function BoardPage({
  projectId,
  mode,
  month,
  onChange,
}: {
  projectId: string;
  mode: BoardMode;
  month?: string;
  onChange: (next: { mode?: BoardMode; month?: string }) => void;
}) {
  return (
    <ProjectFrame projectId={projectId} title="Board">
      {(project) => {
        const tracks = project.profile !== "general";
        const shown: BoardMode = !tracks && mode === "board" ? "calendar" : mode;
        const switcher: ReactNode = (
          <Segmented
            label="Show"
            labelled
            className="shrink-0"
            value={shown}
            options={tracks ? modes : modes.filter((m) => m.value !== "board")}
            onChange={(next) => onChange({ mode: next })}
          />
        );
        return (
          <div className={body}>
            {shown === "board" ? (
              <ProjectBoard projectId={project.id} switcher={switcher} />
            ) : (
              <>
                <div className="flex items-center gap-2">{switcher}</div>
                {shown === "calendar" ? (
                  <ProjectCalendar
                    projectId={project.id}
                    projectName={project.name}
                    month={month ?? thisMonth()}
                    onMonth={(next) => onChange({ mode: "calendar", month: next })}
                  />
                ) : (
                  <ProjectTimeline projectId={project.id} />
                )}
              </>
            )}
          </div>
        );
      }}
    </ProjectFrame>
  );
}
