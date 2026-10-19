import { ProjectTasks } from "~/components/tasks";
import { useProjectCan } from "~/lib/queries";
import { ProjectFrame } from "~/routes/project";

const body =
  "fade-in mx-auto flex w-full max-w-[1360px] flex-col gap-6 px-5 py-6 @3xl/app:px-10 @3xl/app:py-8";

/** A project's tasks (#140): the list, one opened beside it, and a new one being made. */
export function TasksPage({
  projectId,
  taskId,
  creating,
}: {
  projectId: string;
  taskId?: string;
  creating: boolean;
}) {
  const can = useProjectCan(projectId);
  return (
    <ProjectFrame projectId={projectId} title="Tasks">
      {(project) => (
        <div className={body}>
          <ProjectTasks
            projectId={project.id}
            taskId={taskId}
            creating={creating}
            canMake={can("comment")}
          />
        </div>
      )}
    </ProjectFrame>
  );
}
