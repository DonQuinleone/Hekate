import { useQuery } from "@tanstack/react-query";
import { Link, Navigate } from "@tanstack/react-router";
import { useState } from "react";
import { Icon } from "~/components/icons";
import { Page } from "~/components/page";
import { PageHeader } from "~/components/page-header";
import { primaryOf, TrackVersions } from "~/components/track-versions";
import { Button } from "~/components/ui/button";
import { projectQuery, trackQuery, useProjectCan } from "~/lib/queries";

/**
 * A track (#131): it opens in the player on its latest version's primary file, like a
 * folder of its versions; its versions page is one step from there (`?view=versions`), and
 * where a track without versions opens.
 */
export function TrackPage({ trackId, view }: { trackId: string; view?: "versions" }) {
  const { data: track, error } = useQuery(trackQuery(trackId));
  const { data: project } = useQuery({
    ...projectQuery(track?.projectId ?? ""),
    enabled: Boolean(track),
  });
  const can = useProjectCan(track?.projectId);
  const [adding, setAdding] = useState(false);
  if (error) return <p className="p-8 text-signal">{error.message}</p>;
  if (!track || !project) return <p className="p-8 text-ink-3">Loading</p>;
  const latest = track.versions.at(-1);
  const playable = latest && primaryOf(latest);
  if (view !== "versions" && playable) {
    return <Navigate to="/files/$fileId" params={{ fileId: playable.fileId }} replace />;
  }
  const live = !project.archivedAt;
  return (
    <>
      <PageHeader
        crumbs={[
          { key: "projects", link: <Link to="/projects">Projects</Link> },
          {
            key: "project",
            link: (
              <Link to="/projects/$projectId/files" params={{ projectId: track.projectId }}>
                {project.name}
              </Link>
            ),
          },
        ]}
        title={`${track.name}: versions`}
        actions={
          live ? (
            <>
              {can("request_reviews") && latest && (
                <Button variant="secondary" size="sm" asChild>
                  <Link
                    to="/projects/$projectId/reviews/new"
                    params={{ projectId: track.projectId }}
                    search={{ item: `track:${track.id}` }}
                  >
                    Request a review
                  </Link>
                </Button>
              )}
              {can("upload") && !adding && (
                <Button variant="primary" size="sm" onClick={() => setAdding(true)}>
                  <Icon name="upload" size={14} />
                  {project.profile === "video" ? "Add cut" : "Add version"}
                </Button>
              )}
            </>
          ) : undefined
        }
      />
      <Page width="narrow" className="max-w-[1040px] gap-6">
        <TrackVersions track={track} project={project} adding={adding} onAdding={setAdding} />
      </Page>
    </>
  );
}
