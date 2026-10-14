import { profiles } from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Icon } from "~/components/icons";
import { Button } from "~/components/ui/button";
import { StatusPill } from "~/components/ui/status";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { projectQuery } from "~/lib/queries";
import { profileIcon } from "./projects";

const uploadCopy = {
  music: {
    title: "Add a recording and its score",
    body: "Upload takes as WAV, FLAC or AIFF and the score as PDF. Bars sync once the score is mapped.",
  },
  video: {
    title: "Add a cut",
    body: "Upload a ProRes, H.264 or HEVC file. Each upload of the same cut becomes a new version.",
  },
  general: {
    title: "Add files",
    body: "Documents, images, audio or video. Every file keeps its versions.",
  },
} as const;

export function ProjectPage({ projectId }: { projectId: string }) {
  const { data: project, error } = useQuery(projectQuery(projectId));
  if (error) return <p className="p-8 text-signal">{error.message}</p>;
  if (!project) return <p className="p-8 text-ink-3">Loading</p>;
  const profile = profiles[project.profile];
  const copy = uploadCopy[project.profile];
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-8 sm:px-8">
      <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-[13px]">
        <Link to="/" className="text-ink-3 no-underline hover:text-ink">
          Projects
        </Link>
        <span className="text-edge">/</span>
        <span className="font-medium text-ink">{project.name}</span>
      </nav>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <span className="inline-flex h-[22px] w-fit items-center gap-1.5 rounded-chip border border-hairline px-2 label text-ink-2">
            <Icon name={profileIcon[project.profile]} size={12} />
            {profile.label}
          </span>
          <h1 className="m-0 text-[28px] font-medium tracking-[-0.02em]">{project.name}</h1>
        </div>
        <StatusPill state="in_review" />
      </div>
      <Tabs defaultValue="media">
        <TabsList>
          <TabsTrigger value="media">Media</TabsTrigger>
          <TabsTrigger value="comments">Comments</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>
        <TabsContent value="media" className="pt-6">
          <div className="flex flex-col items-start gap-4 rounded-panel border border-dashed border-edge p-8">
            <Icon name="upload" size={20} className="text-ink-2" />
            <div className="flex flex-col gap-1">
              <p className="m-0 text-[15px] font-medium">{copy.title}</p>
              <p className="m-0 max-w-md text-[13px] leading-normal text-ink-3">{copy.body}</p>
            </div>
            <Button disabled title="Uploads arrive with issue 10">
              <Icon name="upload" size={14} />
              Upload
            </Button>
            <p className="label m-0">Anchors in this profile · {profile.anchors.join(" · ")}</p>
          </div>
        </TabsContent>
        <TabsContent value="comments" className="pt-6 text-ink-3">
          No comments yet.
        </TabsContent>
        <TabsContent value="activity" className="pt-6 text-ink-3">
          No activity yet.
        </TabsContent>
      </Tabs>
    </div>
  );
}
