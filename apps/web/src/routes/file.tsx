import {
  formatBytes,
  formatChannels,
  formatDuration,
  type MediaInfo,
  type ReviewerTool,
} from "@hekate/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useEffect, useId, useState } from "react";
import {
  type BeforeAfter,
  Comments,
  type PageComments,
  useCommentMarkers,
  useRegionMarkers,
} from "~/components/comments";
import { Compare, type CompareFocus } from "~/components/compare";
import { DocumentViewer } from "~/components/document-viewer";
import { FileDetailsSheet } from "~/components/file-details";
import { mediaSummary } from "~/components/files";
import { Icon } from "~/components/icons";
import { Loudness } from "~/components/loudness";
import { type Crumb, PageHeader } from "~/components/page-header";
import { Player } from "~/components/player";
import { QaSummary, QualityChecks } from "~/components/qa";
import { ScorePane } from "~/components/score";
import { FileContext } from "~/components/tracks";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/cn";
import type { Loop } from "~/lib/loop";
import { initialFocus, type PageFocus } from "~/lib/pages";
import {
  type FileDetail,
  fileQuery,
  playbackQuery,
  projectQuery,
  useMarks,
  usePreferences,
  useProjectCan,
} from "~/lib/queries";
import { useViewer } from "~/lib/viewer";

const dateFormat = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-panel border border-hairline bg-surface px-4 py-6 text-sm text-ink-3">
      {children}
    </div>
  );
}

function Playback({
  file,
  onMedia,
  loop,
  onLoop,
  pages,
  canComment,
}: {
  file: FileDetail;
  onMedia: (element: HTMLMediaElement | null) => void;
  loop: Loop | null;
  onLoop: (loop: Loop | null) => void;
  pages: PageComments | undefined;
  canComment: boolean;
}) {
  const client = useQueryClient();
  const markers = useCommentMarkers(file.id);
  const regions = useRegionMarkers(file.id);
  const ready = file.streamStatus === "ready";
  // Only a recording plays: asking for a document's playback would log a session for nothing.
  const plays = file.kind === "audio" || file.kind === "video";
  const { data, error } = useQuery({ ...playbackQuery(file.id), enabled: ready && plays });
  if (pages) {
    // Seen only as pages the server draws: never the file itself.
    if (file.streamStatus === "ready")
      return (
        <DocumentViewer
          fileId={file.id}
          name={file.name}
          focus={pages.focus}
          onFocus={pages.onFocus}
          markers={regions}
          canDraw={canComment}
        />
      );
    if (file.streamStatus === "pending") return <Notice>Drawing the pages.</Notice>;
    if (file.streamStatus === "failed")
      return <Notice>This file could not be drawn as pages.</Notice>;
    return <Notice>Only PDFs and pictures are shown as pages.</Notice>;
  }
  if (file.kind !== "audio" && file.kind !== "video") {
    return <Notice>This kind of file has nothing to show here.</Notice>;
  }
  if (file.streamStatus === "failed")
    return <Notice>This file could not be prepared for playback.</Notice>;
  if (file.mediaInfo === null) return <Notice>Measuring the file.</Notice>;
  if (file.streamStatus === "pending") return <Notice>Preparing for playback.</Notice>;
  if (file.streamStatus !== "ready")
    return <Notice>This file could not be prepared for playback.</Notice>;
  if (error) return <Notice>{error.message}</Notice>;
  if (!data) return <Notice>Loading the player.</Notice>;
  return (
    <Player
      fileId={file.id}
      kind={file.kind}
      playback={data}
      info={file.mediaInfo}
      onMedia={onMedia}
      markers={markers}
      loop={loop}
      onLoop={onLoop}
      tools={file.grant?.tools ?? null}
      onExpired={() => client.resetQueries({ queryKey: playbackQuery(file.id).queryKey })}
    />
  );
}

/** The facts an engineer checks, in the order they check them. */
function technicalDetails(info: MediaInfo | null): [string, string][] {
  if (!info) return [];
  const rows: [string, string][] = [];
  if (info.video) {
    rows.push(["Video", `${info.video.codec} · ${info.video.width} × ${info.video.height}`]);
    if (info.video.fps) rows.push(["Frame rate", `${info.video.fps} fps`]);
  }
  if (info.audio) {
    rows.push(["Audio", info.audio.codec]);
    rows.push([
      "Sample rate",
      `${info.audio.sampleRate / 1000} kHz${info.audio.bitDepth ? ` · ${info.audio.bitDepth}-bit` : ""}`,
    ]);
    rows.push(["Channels", formatChannels(info.audio.channels, info.audio.channelLayout)]);
  }
  if (info.duration !== undefined) rows.push(["Duration", formatDuration(info.duration)]);
  return rows;
}

export type FileView = "review" | "qa";

/** Opening a file is seeing it: the file browser stops showing it as new to this member. */
function MarkViewed({ projectId, fileId }: { projectId: string; fileId: string }) {
  const { mutate } = useMarks(projectId);
  useEffect(
    () => mutate({ items: [{ kind: "file", id: fileId }], viewed: true }),
    [mutate, fileId],
  );
  return null;
}

export function FilePage({
  fileId,
  loop = null,
  onLoop = () => {},
  view = "review",
  onView = () => {},
  details: showDetails = false,
  onDetails = () => {},
}: {
  fileId: string;
  /** Whether the details sheet is open beside the file (members only). */
  details?: boolean;
  onDetails?: (open: boolean) => void;
  /** Review (the player and the comments) or QA (what was measured), kept in the address. */
  view?: FileView;
  onView?: (view: FileView) => void;
  /** The passage being looped, kept in the address so it holds across versions and variations. */
  loop?: Loop | null;
  onLoop?: (loop: Loop | null) => void;
}) {
  const { data: file, error } = useQuery(fileQuery(fileId));
  const tabsId = useId();
  const [media, setMedia] = useState<HTMLMediaElement | null>(null);
  /** A source comparison should bring in and play first: before, for before and after. */
  const [focus, setFocus] = useState<CompareFocus | null>(null);
  const { guest } = useViewer();
  const preferences = usePreferences();
  /** On a document: the page shown, and the region drawn or thread picked on it. */
  const [pageFocus, setPageFocus] = useState<PageFocus>(initialFocus);
  // Another file starts on its first page, with nothing drawn.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset whenever the file changes.
  useEffect(() => setPageFocus(initialFocus), [fileId]);
  const can = useProjectCan(guest || !file ? undefined : file.projectId);
  // Guests see the files of their reviews, never the project around them.
  const { data: project } = useQuery({
    ...projectQuery(file?.projectId ?? ""),
    enabled: Boolean(file) && !guest,
  });
  if (error) return <p className="p-8 text-signal">{error.message}</p>;
  if (!file) return <p className="p-8 text-ink-3">Loading</p>;
  // A guest's review decides which tools they have; members have them all.
  const allows = (tool: ReviewerTool) => !file.grant || file.grant.tools.includes(tool);
  const passage = allows("loops") ? loop : null;
  const canComment = guest ? Boolean(file.grant?.comment) : can("comment");
  const pages: PageComments | undefined =
    file.kind === "document" || file.kind === "image"
      ? {
          focus: pageFocus,
          onFocus: (change) => setPageFocus((f) => ({ ...f, ...change })),
          paged: file.kind === "document",
        }
      : undefined;
  const comparable = !guest && file.kind === "audio" && file.streamStatus === "ready";
  /** Loop the passage and hear it from where it began; one key then flips to this version. */
  const beforeAfter = (target: BeforeAfter) => {
    setFocus({ fileId: target.fileId, shift: target.shift, nonce: Date.now() });
    onLoop(target.loop);
    if (media) {
      media.currentTime = target.loop.start;
      void media.play().catch(() => undefined);
    }
  };
  /** A recording's measurements, checks and details have a view of their own (#41). */
  const hasQa = Boolean(file.mediaInfo?.audio && allows("meters"));
  const shown = hasQa ? view : "review";
  const summary = mediaSummary(file.kind, file.mediaInfo, file.streamStatus);
  const details: [string, string][] = [
    ["Type", file.contentType],
    ["Size", formatBytes(file.byteSize)],
    ...technicalDetails(file.mediaInfo),
    ["Added", dateFormat.format(new Date(file.createdAt))],
    ...(file.uploadedBy ? [["Added by", file.uploadedBy] as [string, string]] : []),
  ];
  const detailRows = details.map(([term, value]) => (
    <div
      key={term}
      className="grid grid-cols-[minmax(0,140px)_1fr] gap-x-6 border-b border-hairline py-2.5"
    >
      <dt className="label">{term}</dt>
      <dd className="tabular m-0 truncate text-[13px] text-ink-2">{value}</dd>
    </div>
  ));
  const crumbs: Crumb[] = guest
    ? [{ key: "reviews", link: <Link to="/g">Your reviews</Link> }]
    : [
        { key: "projects", link: <Link to="/projects">Projects</Link> },
        {
          key: "project",
          link: (
            <Link to="/projects/$projectId/files" params={{ projectId: file.projectId }}>
              {project?.name ?? "Project"}
            </Link>
          ),
        },
        ...(file.variation
          ? [
              {
                key: "track",
                link: (
                  <Link to="/tracks/$trackId" params={{ trackId: file.variation.trackId }}>
                    {file.variation.trackName}
                  </Link>
                ),
              },
            ]
          : []),
      ];
  return (
    <>
      {!guest && <MarkViewed projectId={file.projectId} fileId={file.id} />}
      <PageHeader
        crumbs={crumbs}
        title={file.name}
        // Media formats show in the player; other files say what they are here.
        meta={summary ? undefined : file.contentType}
        actions={
          guest ? undefined : (
            <Button
              variant="ghost"
              size="sm"
              aria-pressed={showDetails}
              onClick={() => onDetails(!showDetails)}
            >
              <Icon name="info" size={14} />
              Details
            </Button>
          )
        }
      />
      {!guest && details && <FileDetailsSheet fileId={file.id} onClose={() => onDetails(false)} />}
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-5 sm:px-6">
        {!guest && <FileContext file={file} />}
        {hasQa && (
          <div
            role="tablist"
            aria-label="View"
            className="flex h-11 items-stretch gap-0.5 border-b border-hairline"
          >
            {(["review", "qa"] as const).map((v) => (
              <button
                key={v}
                type="button"
                role="tab"
                id={`${tabsId}-${v}`}
                aria-selected={shown === v}
                aria-controls={`${tabsId}-panel`}
                onClick={() => onView(v)}
                className="-mb-px inline-flex cursor-pointer items-center gap-1.5 border-0 border-b border-transparent bg-transparent px-2 text-[13px] font-medium text-ink-3 hover:text-ink-2 aria-selected:border-ink aria-selected:text-ink"
              >
                {v === "review" ? "Review" : "QA"}
              </button>
            ))}
          </div>
        )}
        {/*
          Review: on a phone the comments follow the player, before the score and the
          details; on a wide screen they sit beside all of them, as the rows and spans below
          arrange. QA: the player, then what was measured. The player keeps its place in
          both, so switching never stops the music. Spacing sits on the cells, so a cell left
          empty adds none.
        */}
        <div
          {...(hasQa
            ? { role: "tabpanel", id: `${tabsId}-panel`, "aria-labelledby": `${tabsId}-${shown}` }
            : {})}
          className={cn(
            "grid grid-cols-1 items-start gap-x-8",
            shown === "review" &&
              "lg:grid-cols-[minmax(0,1fr)_340px] lg:grid-rows-[auto_auto_auto_1fr]",
          )}
        >
          <div className="flex min-w-0 flex-col gap-6">
            <Playback
              file={file}
              onMedia={setMedia}
              loop={passage}
              onLoop={onLoop}
              pages={pages}
              canComment={canComment}
            />
            {shown === "review" && hasQa && preferences.showLoudness && (
              <QaSummary fileId={file.id} onOpen={() => onView("qa")} />
            )}
          </div>
          {shown === "review" ? (
            <>
              <div className="min-w-0 pt-8 lg:col-start-2 lg:row-span-4 lg:row-start-1 lg:pt-0">
                <Comments
                  fileId={file.id}
                  projectId={file.projectId}
                  media={media}
                  loop={passage}
                  pages={file.streamStatus === "ready" ? pages : undefined}
                  onBeforeAfter={comparable ? beforeAfter : undefined}
                  onLoop={
                    allows("loops")
                      ? (next) => {
                          // One action: the passage is looped and heard from its start.
                          onLoop(next);
                          if (media) {
                            media.currentTime = next.start;
                            void media.play().catch(() => undefined);
                          }
                        }
                      : undefined
                  }
                />
              </div>
              {file.variation?.scoreFileId && (file.kind === "audio" || file.kind === "video") && (
                <div className="min-w-0 pt-8 lg:pt-6">
                  <ScorePane scoreFileId={file.variation.scoreFileId} />
                </div>
              )}
              {comparable && (
                <div className="min-w-0 pt-8 lg:pt-6">
                  <Compare file={file} media={media} focus={focus} />
                </div>
              )}
              {/* A recording's details belong to QA; a document's stay with it. */}
              {!hasQa && (
                <dl className="m-0 mt-8 flex flex-col border-t border-hairline lg:mt-6">
                  {detailRows}
                </dl>
              )}
            </>
          ) : (
            <div className="flex min-w-0 flex-col gap-6 pt-8">
              <QualityChecks
                fileId={file.id}
                projectId={file.projectId}
                media={media}
                canChoose={!guest && can("edit_workflows")}
              />
              {file.mediaInfo?.audio && (
                <Loudness
                  fileId={file.id}
                  media={media}
                  layout={file.mediaInfo.audio.channelLayout}
                />
              )}
              <dl className="m-0 flex flex-col border-t border-hairline">{detailRows}</dl>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
