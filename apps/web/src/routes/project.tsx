import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { FileBrowser } from "~/components/file-browser";
import { UploadProvider } from "~/components/files";
import { ReviewerGroups } from "~/components/groups";
import { PageHeader } from "~/components/page-header";
import { ProjectAccess } from "~/components/project-access";
import { ProjectReviews } from "~/components/reviews";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { projectFoldersQuery, projectQuery, useProjectCan } from "~/lib/queries";

export function ProjectPage({
  projectId,
  folderId = null,
  onOpenFolder = () => {},
}: {
  projectId: string;
  /** The folder open in the file browser; null is the top of the project. */
  folderId?: string | null;
  onOpenFolder?: (folderId: string | null) => void;
}) {
  const { data: project, error } = useQuery(projectQuery(projectId));
  const { data: folders } = useQuery(projectFoldersQuery(projectId));
  const can = useProjectCan(projectId);
  if (error) return <p className="p-8 text-signal">{error.message}</p>;
  if (!project) return <p className="p-8 text-ink-3">Loading</p>;
  const folderName = folders?.find((f) => f.id === folderId)?.name;
  return (
    <UploadProvider
      projectId={project.id}
      folderId={folderId}
      folderName={folderName}
      enabled={can("upload")}
    >
      <PageHeader
        crumbs={[{ key: "projects", link: <Link to="/">Projects</Link> }]}
        title={project.name}
      />
      <div className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-5 sm:px-6">
        <Tabs defaultValue="media">
          <TabsList>
            <TabsTrigger value="media">Media</TabsTrigger>
            <TabsTrigger value="reviews">Reviews</TabsTrigger>
            <TabsTrigger value="roles">People</TabsTrigger>
          </TabsList>
          <TabsContent value="media" className="pt-5">
            <FileBrowser
              projectId={project.id}
              folderId={folderId}
              onOpenFolder={onOpenFolder}
              tracks={project.profile === "music"}
            />
          </TabsContent>
          <TabsContent value="reviews" className="flex flex-col gap-10 pt-5">
            <ProjectReviews projectId={project.id} />
            <ReviewerGroups projectId={project.id} />
          </TabsContent>
          <TabsContent value="roles" className="pt-5">
            <ProjectAccess projectId={project.id} />
          </TabsContent>
        </Tabs>
      </div>
    </UploadProvider>
  );
}
