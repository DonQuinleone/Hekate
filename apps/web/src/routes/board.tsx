import { ProjectBoard } from "~/components/board";
import { ProjectCalendar, thisMonth } from "~/components/calendar";
import { Segmented } from "~/components/ui/segmented";
import { ProjectFrame } from "~/routes/project";

const body =
  "fade-in mx-auto flex w-full max-w-[1360px] flex-col gap-6 px-5 py-6 @3xl/app:px-10 @3xl/app:py-8";

export type BoardMode = "board" | "calendar";

/** A project's board (#141): where each track stands, or what is due when, kept in the address. */
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
      {(project) => (
        <div className={body}>
          <Segmented
            label="Show"
            className="self-start"
            value={mode}
            options={[
              { value: "board", label: "Board" },
              { value: "calendar", label: "Calendar" },
            ]}
            onChange={(next) => onChange({ mode: next })}
          />
          {mode === "calendar" ? (
            <ProjectCalendar
              projectId={project.id}
              projectName={project.name}
              month={month ?? thisMonth()}
              onMonth={(next) => onChange({ mode, month: next })}
            />
          ) : (
            <ProjectBoard projectId={project.id} />
          )}
        </div>
      )}
    </ProjectFrame>
  );
}
