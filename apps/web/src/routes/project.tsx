import { profiles } from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { FileList, Uploader } from "~/components/files";
import { Icon } from "~/components/icons";
import { TrackList } from "~/components/tracks";
import { StatusPill } from "~/components/ui/status";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { projectQuery } from "~/lib/queries";
import { profileIcon } from "./projects";

const uploadCopy = {
  music: {
    title: "Add recordings and scores",
    body: "Drop mixes as WAV, FLAC or AIFF and scores as PDF. Large sessions resume if the connection drops.",
  },
  video: {
    title: "Add cuts",
    body: "Drop ProRes, H.264 or HEVC files. Large files resume if the connection drops.",
  },
  general: {
    title: "Add files",
    body: "Documents, images, audio or video. Large files resume if the connection drops.",
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
        <TabsContent value="media" className="flex flex-col gap-6 pt-6">
          {project.profile === "music" && <TrackList projectId={project.id} />}
          <Uploader projectId={project.id} title={copy.title} body={copy.body} />
          <FileList projectId={project.id} />
          <p className="label m-0">Anchors in this profile · {profile.anchors.join(" · ")}</p>
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
