import { capital } from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { Link, Navigate, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { DropHint, usePageDrop } from "~/components/files";
import { FollowButton } from "~/components/follow-button";
import { Icon } from "~/components/icons";
import { Page } from "~/components/page";
import { PageHeader } from "~/components/page-header";
import { ShareDialog } from "~/components/share";
import { TakeImportDialog } from "~/components/take-import";
import { TakeManager } from "~/components/takes";
import { TrackHeading, TrackVersions } from "~/components/track-versions";
import { Button } from "~/components/ui/button";
import { Segmented } from "~/components/ui/segmented";
import type { Picked } from "~/lib/picked-files";
import {
  projectQuery,
  trackQuery,
  useItemWords,
  useProjectCan,
  useProjectTool,
} from "~/lib/queries";
import { primaryOf } from "~/lib/versions";

/**
 * A track (#131): it opens in the player on its latest version's primary file, like a
 * folder of its versions; its versions page is one step from there (`?view=versions`), and
 * where a track without versions opens. Its takes (#21) sit beside its versions, for those
 * who may see them, and are added from here (#490): the Add takes dialog, with the track
 * settled, opened by the button or by dropping files on the takes.
 */
export function TrackPage({ trackId, view }: { trackId: string; view?: "versions" | "takes" }) {
  const { data: track, error } = useQuery(trackQuery(trackId));
  const { data: project } = useQuery({
    ...projectQuery(track?.projectId ?? ""),
    enabled: Boolean(track),
  });
  const can = useProjectCan(track?.projectId);
  const tool = useProjectTool(track?.projectId);
  const { words, video } = useItemWords(track?.projectId);
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const [sharing, setSharing] = useState(false);
  /** The files dropped on the takes, or none, while the Add takes dialog is open. */
  const [addingTakes, setAddingTakes] = useState<Picked[] | null>(null);
  /** Files dropped on the page: they open the next version with them chosen (#485). */
  const [dropped, setDropped] = useState<Picked[] | undefined>(undefined);
  // Takes are music's: a deliverable has its cuts and nothing beside them (#16).
  const takes = view === "takes" && can("view_takes") && !video;
  const mayDrop = Boolean(
    track && project && !project.archivedAt && can("upload") && view === "versions" && !takes,
  );
  const over = usePageDrop({
    enabled: mayDrop && !adding,
    onDrop: (picked) => {
      setDropped(picked);
      setAdding(true);
    },
  });
  if (error) return <p className="p-8 text-signal">{error.message}</p>;
  if (!track || !project) return <p className="p-8 text-ink-3">Loading</p>;
  const latest = track.versions.at(-1);
  const playable = latest && primaryOf(latest);
  const next = track.versions.length + 1;
  if (!view && playable) {
    return <Navigate to="/files/$fileId" params={{ fileId: playable.fileId }} replace />;
  }
  const live = !project.archivedAt;
  // Adding takes uploads their files, which needs the upload permission as well as the takes'.
  const canAddTakes = live && can("edit_takes") && can("upload");
  const switcher =
    can("view_takes") && !video ? (
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
        title={`${track.name}: ${takes ? "takes" : words.versions}`}
        actions={
          <>
            {/* Following is the member's own choice, so it stays on an archived project too. */}
            <FollowButton target={{ trackId: track.id }} what={video ? "deliverable" : "track"} />
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
                  <Button variant="secondary" size="sm" onClick={() => setSharing(true)}>
                    <Icon name="link" size={14} />
                    Share
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
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => {
                      setDropped(undefined);
                      setAdding(true);
                    }}
                  >
                    <Icon name="upload" size={14} />
                    Add {words.version}
                  </Button>
                )}
                {takes && canAddTakes && !addingTakes && (
                  <Button variant="primary" size="sm" onClick={() => setAddingTakes([])}>
                    <Icon name="upload" size={14} />
                    Add takes
                  </Button>
                )}
              </>
            )}
          </>
        }
      />
      {sharing && (
        <ShareDialog
          projectId={track.projectId}
          item={{ kind: "track", id: track.id, name: track.name, what: capital(words.track) }}
          onClose={() => setSharing(false)}
        />
      )}
      <Page width="narrow" className="max-w-[1040px] gap-6">
        {takes ? (
          <>
            <TrackHeading track={track} aside={switcher} />
            <TakeManager track={track} onAdd={canAddTakes ? setAddingTakes : undefined} />
            {addingTakes && (
              <TakeImportDialog
                projectId={track.projectId}
                track={track}
                initial={addingTakes}
                onClose={() => setAddingTakes(null)}
              />
            )}
          </>
        ) : (
          <TrackVersions
            track={track}
            project={project}
            adding={adding}
            dropped={dropped}
            onAdding={setAdding}
            aside={switcher}
          />
        )}
      </Page>
      {over && <DropHint text={`Drop to add ${words.version} ${next} of ${track.name}`} />}
    </>
  );
}
