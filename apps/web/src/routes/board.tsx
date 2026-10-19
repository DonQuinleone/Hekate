import { ProjectBoard } from "~/components/board";
import { ProjectFrame } from "~/routes/project";

const body =
  "fade-in mx-auto flex w-full max-w-[1360px] flex-col gap-6 px-5 py-6 @3xl/app:px-10 @3xl/app:py-8";

/** A project's board (#141): where each track stands. */
export function BoardPage({ projectId }: { projectId: string }) {
  return (
    <ProjectFrame projectId={projectId} title="Board">
      {(project) => (
        <div className={body}>
          <ProjectBoard projectId={project.id} />
        </div>
      )}
    </ProjectFrame>
  );
}
