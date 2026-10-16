import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { PageHeader } from "~/components/page-header";
import { TrackView } from "~/components/tracks";
import { projectQuery, trackQuery } from "~/lib/queries";

export function TrackPage({ trackId }: { trackId: string }) {
  const { data: track, error } = useQuery(trackQuery(trackId));
  const { data: project } = useQuery({
    ...projectQuery(track?.projectId ?? ""),
    enabled: Boolean(track),
  });
  if (error) return <p className="p-8 text-signal">{error.message}</p>;
  if (!track) return <p className="p-8 text-ink-3">Loading</p>;
  const count = track.versions.length;
  return (
    <>
      <PageHeader
        crumbs={[
          { key: "projects", link: <Link to="/projects">Projects</Link> },
          {
            key: "project",
            link: (
              <Link to="/projects/$projectId/files" params={{ projectId: track.projectId }}>
                {project?.name ?? "Project"}
              </Link>
            ),
          },
        ]}
        title={track.name}
        meta={count === 0 ? "No versions yet" : `${count} ${count === 1 ? "version" : "versions"}`}
      />
      <div className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-5 sm:px-6">
        <TrackView trackId={track.id} />
      </div>
    </>
  );
}
