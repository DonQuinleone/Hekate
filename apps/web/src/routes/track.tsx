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
import { ActionMenu, type MenuItem } from "~/components/ui/menu";
import { Segmented } from "~/components/ui/segmented";
import { Loading } from "~/components/ui/states";
import type { Picked } from "~/lib/picked-files";
import {
  followsQuery,
  projectQuery,
  trackQuery,
  useFollow,
  useItemWords,
  useProjectCan,
  useProjectTool,
  useUnfollow,
} from "~/lib/queries";
import { primaryOf } from "~/lib/versions";
import { PageFailed } from "~/routes/problem";

/**
 * A track (#131): it opens in the player on its latest version's primary file, like a
 * folder of its versions; its versions page is one step from there (`?view=versions`), and
 * where a track without versions opens. Its takes (#21) sit beside its versions, for those
 * who may see them, and are added from here (#490): the Add takes dialog, with the track
 * settled, opened by the button or by dropping files on the takes.
 */
export function TrackPage({ trackId, view }: { trackId: string; view?: "versions" | "takes" }) {
  const { data: track, error, refetch } = useQuery(trackQuery(trackId));
  const { data: project } = useQuery({
    ...projectQuery(track?.projectId ?? ""),
    enabled: Boolean(track),
  });
  const can = useProjectCan(track?.projectId);
  const tool = useProjectTool(track?.projectId);
  const { words, video } = useItemWords(track?.projectId);
  const navigate = useNavigate();
  const { data: follows } = useQuery(followsQuery);
  const follow = useFollow();
  const unfollow = useUnfollow();
  const mine = follows?.find((f) => f.trackId === trackId);
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
  if (error) return <PageFailed what="This track" error={error} retry={refetch} />;
  if (!track || !project) return <Loading />;
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
  const compare =
    track.versions.length > 1 && tool("compare") && !takes && latest
      ? // Two cuts are compared in the player, where their pictures are (#569); two versions
        // of a track on the page that aligns them by their audio.
        video && playable
        ? { to: "/files/$fileId" as const, params: { fileId: playable.fileId }, search: { cuts: "side" as const } }
        : { to: "/tracks/$trackId/compare" as const, params: { trackId: track.id } }
      : null;
  const mayReview = live && can("request_reviews") && Boolean(latest);
  const reviewLink = {
    to: "/projects/$projectId/reviews/new" as const,
    params: { projectId: track.projectId },
    search: { item: `track:${track.id}` },
  };
  const what = video ? "deliverable" : "track";
  // The header's less frequent actions behind "…" (#567): Share, with the version row's own
  // Share for one version; on a phone, everything but the primary.
  const shareItem = { label: "Share…", onSelect: () => setSharing(true) };
  const phoneMenu: MenuItem[] = [
    {
      label: mine ? "Following" : "Follow",
      checked: Boolean(mine),
      disabled: !follows,
      onSelect: () => (mine ? unfollow.mutate(mine.id) : follow.mutate({ trackId: track.id })),
    },
    ...(live && compare
      ? [{ label: "Compare", onSelect: () => void navigate(compare) }]
      : []),
    ...(mayReview ? [shareItem, { label: "Request a review", onSelect: () => void navigate(reviewLink) }] : []),
  ];
  return (
    <>
      <PageHeader
        crumbs={[
          {
            key: "project",
            link: (
              <Link to="/projects/$projectId/files" params={{ projectId: track.projectId }}>
                {project.name}
              </Link>
            ),
          },
        ]}
        // The track's name is its page's heading, said once (#649); the bar has the trail.
        title={track.name}
        heading="page"
        actions={
          <>
            {/* On a phone only the primary stays out; the rest are in the menu beside it. */}
            <span className="hidden items-center gap-2 @3xl/app:flex">
              {/* Following is the member's own choice, so it stays on an archived project too. */}
              <FollowButton target={{ trackId: track.id }} what={what} />
              {live && compare && (
                <Button variant="ghost" size="sm" asChild>
                  <Link {...compare}>
                    <Icon name="compare" size={14} />
                    Compare
                  </Link>
                </Button>
              )}
              {mayReview && (
                <Button variant="secondary" size="sm" asChild>
                  <Link {...reviewLink}>Request a review</Link>
                </Button>
              )}
              {mayReview && <ActionMenu always label={track.name} actions={[shareItem]} />}
            </span>
            <span className="@3xl/app:hidden">
              <ActionMenu always label={track.name} actions={phoneMenu} />
            </span>
            {live && can("upload") && !adding && !takes && (
              <Button
                variant="primary"
                size="sm"
                className="shrink-0"
                onClick={() => {
                  setDropped(undefined);
                  setAdding(true);
                }}
              >
                <Icon name="upload" size={14} />
                Add {words.version}
              </Button>
            )}
            {live && takes && canAddTakes && !addingTakes && (
              <Button
                variant="primary"
                size="sm"
                className="shrink-0"
                onClick={() => setAddingTakes([])}
              >
                <Icon name="upload" size={14} />
                Add takes
              </Button>
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
