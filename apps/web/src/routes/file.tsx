import {
  admHeading,
  admLine,
  formatBytes,
  formatChannels,
  formatDuration,
  type MediaInfo,
  metadataRows,
  type QaFinding,
  type ReviewerTool,
} from "@hekate/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useCallback, useEffect, useId, useMemo, useState } from "react";
import {
  type BeforeAfter,
  type CommentSeed,
  Comments,
  type PageComments,
  useCommentMarkers,
  useFrameDrawings,
  useRegionMarkers,
} from "~/components/comments";
import { Compare, type CompareFocus } from "~/components/compare";
import { DecisionStrip } from "~/components/decision-strip";
import { DocumentViewer } from "~/components/document-viewer";
import { DownloadDialog } from "~/components/downloads";
import type { FrameDraft } from "~/components/drawings";
import { ExportCommentsDialog } from "~/components/exports";
import { FileDetailsSheet } from "~/components/file-details";
import { mediaSummary } from "~/components/files";
import { Icon } from "~/components/icons";
import { Loudness } from "~/components/loudness";
import { ImportMarkersDialog } from "~/components/marker-import";
import { type Crumb, PageHeader } from "~/components/page-header";
import { CommentsSplitter, PanelPlacement } from "~/components/panel-placement";
import { Player } from "~/components/player";
import { checkNames, findingMarks, QaSummary, QualityChecks } from "~/components/qa";
import { ScorePane } from "~/components/score";
import { FileContext } from "~/components/tracks";
import { TriageView } from "~/components/triage";
import { Button } from "~/components/ui/button";
import { ActionMenu } from "~/components/ui/menu";
import { cn } from "~/lib/cn";
import { threadsOf } from "~/lib/comments";
import { previousCut } from "~/lib/compare";
import { editSegments } from "~/lib/edit-decisions";
import { useFileMedia } from "~/lib/file-media";
import { formatDates } from "~/lib/locale";
import type { Loop } from "~/lib/loop";
import { initialFocus, type PageFocus } from "~/lib/pages";
import { usePanelLayout } from "~/lib/panel-layout";
import { usePlayerView } from "~/lib/player-view";
import {
  captionsQuery,
  commentsQuery,
  compareFamilyQuery,
  downloadsQuery,
  editDecisionsQuery,
  type FileDetail,
  fileQuery,
  playbackQuery,
  projectQuery,
  qaQuery,
  trackTakesQuery,
  useMarks,
  usePreferences,
  useProjectCan,
} from "~/lib/queries";
import { useViewer } from "~/lib/viewer";

const dateFormat = formatDates({
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
  cue,
  pages,
  canComment,
  normalised,
  onNormalised,
  showFindings,
  showEdits,
  comparePage,
  draft,
  onDraft,
}: {
  file: FileDetail;
  /** Whether the viewer may open the comparison of two cuts' comments and findings (#147). */
  comparePage: boolean;
  /** The drawing waiting to join the next comment on a video (#146). */
  draft: FrameDraft | null;
  onDraft: (draft: FrameDraft | null) => void;
  /** Whether to lay a version's edit decisions under its waveform (#56): for those who see takes. */
  showEdits: boolean;
  /** Whether to mark what the quality checks found on the timeline (#43). */
  showFindings: boolean;
  onMedia: (element: HTMLMediaElement | null) => void;
  loop: Loop | null;
  onLoop: (loop: Loop | null) => void;
  /** Bumped each time the page asks to hear a passage, so a loop switched off comes back on. */
  cue: number;
  pages: PageComments | undefined;
  canComment: boolean;
  normalised: boolean;
  onNormalised: (normalised: boolean) => void;
}) {
  const client = useQueryClient();
  // A take shared with a guest has no comments for them (#133).
  const markers = useCommentMarkers(file.id, !file.grant?.listenOnly);
  const regions = useRegionMarkers(file.id, !file.grant?.listenOnly);
  const drawings = useFrameDrawings(file.id, file.kind === "video" && !file.grant?.listenOnly);
  const { data: qa } = useQuery({ ...qaQuery(file.id), enabled: showFindings });
  const findings = showFindings ? findingMarks(qa?.findings ?? []) : [];
  const variation = showEdits ? file.variation : null;
  const { data: decisions } = useQuery({
    ...editDecisionsQuery(variation?.trackId ?? "", undefined, variation?.versionId),
    enabled: Boolean(variation),
  });
  const { data: takes } = useQuery({
    ...trackTakesQuery(variation?.trackId ?? ""),
    enabled: Boolean(decisions),
  });
  const edits = useMemo(
    () => editSegments(decisions, (id) => takes?.find((t) => t.id === id)?.number),
    [decisions, takes],
  );
  // A deliverable's cut is compared frame by frame with the one before it (#147).
  const { data: family } = useQuery({
    ...compareFamilyQuery(file.id),
    enabled: file.kind === "video" && Boolean(file.variation),
  });
  const before = family ? previousCut(family, file.id, file.profile) : undefined;
  const cuts = before
    ? {
        ...before,
        // Where the two cuts' comments and findings are set side by side (#137).
        compare:
          comparePage && file.variation
            ? {
                trackId: file.variation.trackId,
                a: before.previous.versionNumber,
                b: file.variation.versionNumber,
              }
            : null,
      }
    : null;
  const ready = file.streamStatus === "ready";
  // Only a recording plays: asking for a document's playback would log a session for nothing.
  const plays = file.kind === "audio" || file.kind === "video";
  const { data, error } = useQuery({ ...playbackQuery(file.id), enabled: ready && plays });
  // A video's captions from sidecar files (#146), offered in the player's Frame menu.
  const { data: captions } = useQuery({
    ...captionsQuery(file.id),
    enabled: file.kind === "video",
  });
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
      findings={findings}
      edits={variation ? edits : []}
      loop={loop}
      onLoop={onLoop}
      cue={cue}
      tools={file.grant?.tools ?? file.tools ?? null}
      mark={file.watermark}
      captions={captions}
      normalisation={file.normalisation}
      normalised={normalised}
      onNormalised={onNormalised}
      drawings={drawings}
      draft={draft}
      onDraft={file.kind === "video" && canComment ? onDraft : undefined}
      cuts={cuts}
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

export type FileView = "review" | "qa" | "triage";

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
  reviewId,
  startAt,
  onStarted = () => {},
  focusComment,
}: {
  fileId: string;
  /** A thread to bring into view and mark, as a link to it asks (#140). */
  focusComment?: string;
  /** The review it was opened from: its decision is offered beside the comments (#15). */
  reviewId?: string;
  /** Where to start, in seconds, once the media can seek; then `onStarted`. */
  startAt?: number;
  onStarted?: () => void;
  /** Whether the details sheet is open beside the file (members only). */
  details?: boolean;
  onDetails?: (open: boolean) => void;
  /**
   * Review (the player and the comments), QA (what was measured) or triage (the open
   * comments one at a time), kept in the address.
   */
  view?: FileView;
  onView?: (view: FileView) => void;
  /** The passage being looped, kept in the address so it holds across versions and variations. */
  loop?: Loop | null;
  onLoop?: (loop: Loop | null) => void;
}) {
  const { data: file, error } = useQuery(fileQuery(fileId));
  // Whether this person may download it at all, and so whether to offer it (#136).
  const { data: downloads } = useQuery(downloadsQuery(fileId));
  const [downloading, setDownloading] = useState(false);
  const tabsId = useId();
  const [cue, setCue] = useState(0);
  /** A comment begun from a finding (#43), for the composer to start from. */
  const [seed, setSeed] = useState<CommentSeed | undefined>(undefined);
  /** A source comparison should bring in and play first: before, for before and after. */
  const [focus, setFocus] = useState<CompareFocus | null>(null);
  const { guest } = useViewer();
  const preferences = usePreferences();
  // The line of loudness and issues follows the player's View menu, as it changes (#135).
  const loudnessShown = usePlayerView().view.loudness;
  /** On a document: the page shown, and the region drawn or thread picked on it. */
  const [pageFocus, setPageFocus] = useState<PageFocus>(initialFocus);
  const [frameDraft, setFrameDraft] = useState<FrameDraft | null>(null);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [chosenNormal, setChosenNormal] = useNormalisedChoice();
  // Arriving from another version or variation: start where that one was (#15).
  const { media, onMedia } = useFileMedia(fileId, startAt, onStarted);
  // Where the comments sit on a wide screen, this viewer's choice (#15).
  const [layout, setLayout] = usePanelLayout();
  // Counted only while they are put away, for the button that brings them back.
  const { data: commentList } = useQuery({
    ...commentsQuery(fileId),
    enabled: layout.comments === "hidden",
  });
  // Another file starts on its first page, with nothing drawn.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset whenever the file changes.
  useEffect(() => setPageFocus(initialFocus), [fileId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a drawing belongs to its file.
  useEffect(() => setFrameDraft(null), [fileId]);
  const can = useProjectCan(guest || !file ? undefined : file.projectId);
  // Guests see the files of their reviews, never the project around them.
  const { data: project } = useQuery({
    ...projectQuery(file?.projectId ?? ""),
    enabled: Boolean(file) && !guest,
  });
  if (error) return <p className="p-8 text-signal">{error.message}</p>;
  if (!file) return <p className="p-8 text-ink-3">Loading</p>;
  // A guest's review decides which tools they have; members have them all.
  // A guest's tools come with their review, a member's with their role (#240).
  const tools: readonly string[] | null = file.grant?.tools ?? file.tools ?? null;
  const allows = (tool: ReviewerTool) => !tools || tools.includes(tool);
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
  const comparable = allows("compare") && file.kind === "audio" && file.streamStatus === "ready";
  /** Normalised playback (#240): always where the project says so, else as this person chose. */
  const normalised =
    file.normalisation !== null && (file.normalisation.mode === "forced" || chosenNormal);
  const gain = normalised && file.normalisation ? file.normalisation.gain : 1;
  /** Loop the passage and hear it from where it began; one key then flips to this version. */
  const beforeAfter = (target: BeforeAfter) => {
    setFocus({
      fileId: target.fileId,
      shift: target.shift,
      nonce: Date.now(),
      ...(target.label && file.variation
        ? { outside: { label: target.label, trackId: file.variation.trackId } }
        : {}),
    });
    onLoop(target.loop);
    if (media) {
      media.currentTime = target.loop.start;
      void media.play().catch(() => undefined);
    }
  };
  /** One action: the passage is looped and heard from its start. */
  /** Write a comment about a finding: back to the review, at its moment, saying what it is. */
  const commentOn = (finding: QaFinding) => {
    const at = finding.start;
    if (media) {
      media.pause();
      if (at !== null) media.currentTime = at;
    }
    setSeed({
      key: Date.now(),
      at,
      body: `${checkNames[finding.check]}: ${finding.summary}`,
      // Only a recording of two channels or more has one to be about.
      channel: (file.mediaInfo?.audio?.channels ?? 0) >= 2 ? finding.channel : null,
    });
    onView("review");
  };
  const hear = (next: Loop) => {
    onLoop(next);
    // The same passage again still switches its loop back on.
    setCue((n) => n + 1);
    if (media) {
      media.currentTime = next.start;
      void media.play().catch(() => undefined);
    }
  };
  /**
   * A recording's measurements, checks and details have a view of their own (#41), for a
   * role with either of the tools it holds (#240).
   */
  const hasQa = Boolean(file.mediaInfo?.audio && (allows("qa") || allows("meters")));
  /** Triage (#132) belongs to members who may triage. */
  const canTriage = !guest && can("triage");
  const shown = view === "triage" ? (canTriage ? "triage" : "review") : hasQa ? view : "review";
  // Comparison sets the volume while it is shown (its sources level-matched); otherwise, here.
  const comparing = comparable && shown === "review";
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
                  <Link
                    to="/tracks/$trackId"
                    params={{ trackId: file.variation.trackId }}
                    search={{ view: "versions" }}
                  >
                    {file.variation.trackName}
                  </Link>
                ),
              },
            ]
          : []),
      ];
  const playback = (
    <Playback
      file={file}
      onMedia={onMedia}
      loop={passage}
      onLoop={onLoop}
      cue={cue}
      pages={pages}
      canComment={canComment}
      normalised={normalised}
      onNormalised={setChosenNormal}
      showFindings={Boolean(file.mediaInfo?.audio) && allows("qa")}
      showEdits={!guest && can("view_takes")}
      comparePage={!guest}
      draft={frameDraft}
      onDraft={setFrameDraft}
    />
  );
  if (shown === "triage")
    return (
      <>
        <PageHeader
          crumbs={[
            ...crumbs,
            {
              key: "file",
              link: (
                <Link to="/files/$fileId" params={{ fileId: file.id }}>
                  {file.name}
                </Link>
              ),
            },
          ]}
          title="Triage"
          actions={
            <Button variant="secondary" size="sm" onClick={() => onView("review")}>
              Done
            </Button>
          }
        />
        <PageVolume media={media} gain={gain} />
        <TriageView
          file={file}
          media={media}
          player={playback}
          onLoop={onLoop}
          onDone={() => onView("review")}
        />
      </>
    );
  const downloadButton =
    downloads && downloads.level !== "none" ? (
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setDownloading(true)}
        title={`Download the ${downloads.level}, made for you and logged`}
      >
        <Icon name="download" size={14} />
        Download
      </Button>
    ) : undefined;
  /** With the comments put away, the way back to them, and how many are open. */
  const commentsButton =
    shown === "review" && layout.comments === "hidden" && !file.grant?.listenOnly ? (
      <Button
        variant="ghost"
        size="sm"
        aria-label="Show comments"
        title="Show comments"
        // Only a wide screen puts the comments away; a phone always shows them.
        className="hidden lg:inline-flex"
        onClick={() => setLayout({ comments: "right" })}
      >
        <Icon name="comment" size={14} />
        {commentList ? threadsOf(commentList).open.length : null}
      </Button>
    ) : undefined;
  const beside = shown === "review" && layout.comments === "right";
  return (
    <>
      {!guest && <MarkViewed projectId={file.projectId} fileId={file.id} />}
      {downloading && (
        <DownloadDialog fileId={file.id} name={file.name} onClose={() => setDownloading(false)} />
      )}
      <PageHeader
        crumbs={crumbs}
        title={file.name}
        // Media formats show in the player; other files say what they are here.
        meta={summary ? undefined : file.contentType}
        actions={
          guest ? (
            <>
              {commentsButton}
              {downloadButton}
            </>
          ) : (
            <>
              {commentsButton}
              {downloadButton}
              <Button
                variant="ghost"
                size="sm"
                aria-pressed={showDetails}
                onClick={() => onDetails(!showDetails)}
              >
                <Icon name="info" size={14} />
                Details
              </Button>
              {canTriage && (
                <ActionMenu
                  always
                  label="file"
                  actions={[
                    { label: "Export comments…", onSelect: () => setExporting(true) },
                    ...(file.kind === "audio" || file.kind === "video"
                      ? [{ label: "Import a marker list…", onSelect: () => setImporting(true) }]
                      : []),
                    { label: "Triage comments", onSelect: () => onView("triage") },
                  ]}
                />
              )}
            </>
          )
        }
      />
      {exporting && <ExportCommentsDialog file={file} onClose={() => setExporting(false)} />}
      {importing && <ImportMarkersDialog file={file} onClose={() => setImporting(false)} />}
      {!guest && showDetails && (
        <FileDetailsSheet fileId={file.id} onClose={() => onDetails(false)} />
      )}
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-5 sm:px-6">
        {!guest && <FileContext file={file} media={media} />}
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
            beside &&
              "lg:grid-cols-[minmax(0,1fr)_var(--comments-width)] lg:grid-rows-[auto_auto_auto_1fr]",
          )}
          style={beside ? { ["--comments-width" as string]: `${layout.width}px` } : undefined}
        >
          <div className="flex min-w-0 flex-col gap-6">
            {/* Comparison sets the volume while it is shown; otherwise, this does. */}
            {!comparing && <PageVolume media={media} gain={gain} />}
            {playback}
            {shown === "review" && hasQa && allows("qa") && loudnessShown && (
              <QaSummary fileId={file.id} onOpen={() => onView("qa")} />
            )}
          </div>
          {shown === "review" ? (
            <>
              {/* A take shared with a guest is theirs to hear, with no comments (#133). */}
              {!file.grant?.listenOnly && (
                <div
                  className={cn(
                    "relative min-w-0 pt-8",
                    beside
                      ? "lg:col-start-2 lg:row-span-4 lg:row-start-1 lg:self-stretch lg:pt-0"
                      : "lg:order-last",
                    // Put away on a wide screen only: a phone always shows them (#15).
                    layout.comments === "hidden" && "lg:hidden",
                  )}
                >
                  {beside && (
                    <CommentsSplitter
                      width={layout.width}
                      onWidth={(width) => setLayout({ width })}
                      className="absolute inset-y-0 -left-[19px] hidden lg:block"
                    />
                  )}
                  {reviewId && (
                    <div className="mb-4">
                      <DecisionStrip reviewId={reviewId} />
                    </div>
                  )}
                  <Comments
                    fileId={file.id}
                    projectId={file.projectId}
                    media={media}
                    loop={passage}
                    pages={file.streamStatus === "ready" ? pages : undefined}
                    frame={
                      file.kind === "video"
                        ? { draft: frameDraft, onClear: () => setFrameDraft(null) }
                        : undefined
                    }
                    onBeforeAfter={comparable ? beforeAfter : undefined}
                    seed={seed}
                    onLoop={allows("loops") ? hear : undefined}
                    tools={<PanelPlacement layout={layout} onChange={setLayout} />}
                    focus={focusComment}
                  />
                </div>
              )}
              {file.variation?.scoreFileId &&
                allows("score") &&
                (file.kind === "audio" || file.kind === "video") && (
                  <div className="min-w-0 pt-8 lg:pt-6">
                    <ScorePane scoreFileId={file.variation.scoreFileId} />
                  </div>
                )}
              {comparing && (
                <div className="min-w-0 pt-8 lg:pt-6">
                  <Compare file={file} media={media} focus={focus} gain={gain} />
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
              {allows("qa") && (
                <QualityChecks
                  fileId={file.id}
                  media={media}
                  canChoose={!guest && can("edit_workflows")}
                  onLoop={allows("loops") ? hear : undefined}
                  onComment={canComment ? commentOn : undefined}
                />
              )}
              {file.mediaInfo?.audio && allows("meters") && preferences.showLoudness && (
                <Loudness
                  fileId={file.id}
                  media={media}
                  layout={file.mediaInfo.audio.channelLayout}
                />
              )}
              <dl className="m-0 flex flex-col border-t border-hairline">{detailRows}</dl>
              {file.mediaInfo?.metadata && (
                <section aria-label="Embedded metadata" className="flex flex-col gap-3 pt-2">
                  <h2 className="m-0 text-[15px] font-medium">Embedded metadata</h2>
                  <dl className="m-0 flex flex-col border-t border-hairline">
                    {metadataRows(file.mediaInfo.metadata, file.mediaInfo.audio?.sampleRate).map(
                      ([term, value]) => (
                        <div
                          key={term}
                          className="grid grid-cols-[minmax(0,140px)_1fr] gap-x-6 border-b border-hairline py-2.5"
                        >
                          <dt className="label">{term}</dt>
                          <dd className="tabular m-0 truncate text-[13px] text-ink-2" title={value}>
                            {value}
                          </dd>
                        </div>
                      ),
                    )}
                  </dl>
                  {file.mediaInfo.metadata.adm && (
                    <div className="flex flex-col gap-1 pt-1">
                      <h3 className="label m-0">{admHeading(file.mediaInfo.metadata.adm)}</h3>
                      <p className="m-0 text-[13px] text-ink-2">
                        {admLine(file.mediaInfo.metadata.adm)}
                      </p>
                    </div>
                  )}
                </section>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

const NORMALISED_KEY = "hekate.player.normalised";

/** Whether this person chose normalised playback, where it is theirs to choose; per browser. */
function useNormalisedChoice(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(() => {
    try {
      return localStorage.getItem(NORMALISED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const choose = useCallback((next: boolean) => {
    setOn(next);
    try {
      localStorage.setItem(NORMALISED_KEY, next ? "1" : "0");
    } catch {
      // Not remembered; the choice still holds for this visit.
    }
  }, []);
  return [on, choose];
}

/** Plays the page's media at a volume: normalised playback's, or full (#240). */
function PageVolume({ media, gain }: { media: HTMLMediaElement | null; gain: number }) {
  useEffect(() => {
    if (media) media.volume = gain;
  }, [media, gain]);
  return null;
}
