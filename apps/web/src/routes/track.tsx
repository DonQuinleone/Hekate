import { useQuery } from "@tanstack/react-query";
import { Link, Navigate, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { FollowButton } from "~/components/follow-button";
import { Icon } from "~/components/icons";
import { Page } from "~/components/page";
import { PageHeader } from "~/components/page-header";
import { TakeManager } from "~/components/takes";
import { primaryOf, TrackHeading, TrackVersions } from "~/components/track-versions";
import { Button } from "~/components/ui/button";
import { Segmented } from "~/components/ui/segmented";
import { projectQuery, trackQuery, useProjectCan, useProjectTool } from "~/lib/queries";

/**
 * A track (#131): it opens in the player on its latest version's primary file, like a
 * folder of its versions; its versions page is one step from there (`?view=versions`), and
 * where a track without versions opens. Its takes (#21) sit beside its versions, for those
 * who may see them.
 */
export function TrackPage({ trackId, view }: { trackId: string; view?: "versions" | "takes" }) {
  const { data: track, error } = useQuery(trackQuery(trackId));
  const { data: project } = useQuery({
    ...projectQuery(track?.projectId ?? ""),
    enabled: Boolean(track),
  });
  const can = useProjectCan(track?.projectId);
  const tool = useProjectTool(track?.projectId);
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  if (error) return <p className="p-8 text-signal">{error.message}</p>;
  if (!track || !project) return <p className="p-8 text-ink-3">Loading</p>;
  const latest = track.versions.at(-1);
  const playable = latest && primaryOf(latest);
  const takes = view === "takes" && can("view_takes");
  if (!view && playable) {
    return <Navigate to="/files/$fileId" params={{ fileId: playable.fileId }} replace />;
  }
  const live = !project.archivedAt;
  const switcher = can("view_takes") ? (
    <Segmented
      label="Versions or takes"
      value={takes ? "takes" : "versions"}
      onChange={(next) =>
        navigate({ to: "/tracks/$trackId", params: { trackId }, search: { view: next } })
      }
      options={[
        { value: "versions", label: "Versions" },
        { value: "takes", label: "Takes" },
      ]}
    />
  ) : undefined;
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
        title={`${track.name}: ${takes ? "takes" : "versions"}`}
        actions={
          <>
            {/* Following is the member's own choice, so it stays on an archived project too. */}
            <FollowButton target={{ trackId: track.id }} what="track" />
            {live && (
              <>
                {track.versions.length > 1 && tool("compare") && !takes && (
                  <Button variant="ghost" size="sm" asChild>
                    <Link to="/tracks/$trackId/compare" params={{ trackId: track.id }}>
                      <Icon name="compare" size={14} />
                      <span className="sr-only @md/app:not-sr-only">Compare</span>
                    </Link>
                  </Button>
                )}
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
                {can("upload") && !adding && !takes && (
                  <Button variant="primary" size="sm" onClick={() => setAdding(true)}>
                    <Icon name="upload" size={14} />
                    {project.profile === "video" ? "Add cut" : "Add version"}
                  </Button>
                )}
              </>
            )}
          </>
        }
      />
      <Page width="narrow" className="max-w-[1040px] gap-6">
        {takes ? (
          <>
            <TrackHeading track={track} aside={switcher} />
            <TakeManager track={track} />
          </>
        ) : (
          <TrackVersions
            track={track}
            project={project}
            adding={adding}
            onAdding={setAdding}
            aside={switcher}
          />
        )}
      </Page>
    </>
  );
}
