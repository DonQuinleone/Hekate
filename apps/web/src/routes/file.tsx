import {
  admHeading,
  admLine,
  type CaptionTrack,
  formatBytes,
  formatChannels,
  formatDuration,
  type MediaInfo,
  metadataRows,
  type QaFinding,
  type ReviewerTool,
  videoClock,
} from "@hekate/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
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
import { FileChain, NewVersionDialog, takesVersions } from "~/components/file-versions";
import { fileSummary, mediaSummary } from "~/components/files";
import { Icon } from "~/components/icons";
import { ListeningNotice, ListenTogether, useListeningSync } from "~/components/listening";
import { Loudness } from "~/components/loudness";
import { ImportMarkersDialog } from "~/components/marker-import";
import { type Crumb, PageHeader } from "~/components/page-header";
import { CommentsSplitter, PanelPlacement } from "~/components/panel-placement";
import { Player, PlayerStrip } from "~/components/player";
import { checkNames, findingMarks, QaSummary, QualityChecks, qaIssues } from "~/components/qa";
import { VideoQa } from "~/components/qa-video";
import { ScorePane } from "~/components/score";
import { FileContext, ScoreSwitch, VersionNote } from "~/components/tracks";
import { PanelTabs, type SidePanel, Transcript } from "~/components/transcript";
import { TriageView } from "~/components/triage";
import { Button } from "~/components/ui/button";
import { ActionMenu } from "~/components/ui/menu";
import { Segmented } from "~/components/ui/segmented";
import { cn } from "~/lib/cn";
import { threadsOf } from "~/lib/comments";
import { compareSources, previousCut } from "~/lib/compare";
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

/** A state in the player's place (#15), as the prototype says it: in the middle, no frame. */
function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-4 py-14 text-center text-[14px] text-ink-3">
      {children}
    </div>
  );
}

/** Archives, by their name: what a file with no viewer most often is. */
const ARCHIVE = /\.(zip|rar|7z|tar|gz|tgz|bz2|xz)$/i;

/**
 * A file with no viewer (#149): what it is, that its comments are about all of it, and
 * whether it may be downloaded (from the header). Its details and comments follow.
 */
function NothingToShow({ fileId, name }: { fileId: string; name: string }) {
  const { data: downloads } = useQuery(downloadsQuery(fileId));
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-14 text-center">
      <Icon name="file" size={28} className="text-ink-3" />
      <p className="m-0 text-[14px] text-ink">
        {ARCHIVE.test(name) ? "Nothing to show for an archive" : "Nothing to show for this file"}
      </p>
      <p className="m-0 max-w-sm text-[13px] text-ink-3">
        Comments here are about the whole file.
        {downloads && downloads.level !== "none" ? " You may download it." : ""}
      </p>
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
  compact = false,
  captions,
  caption,
  onCaption,
  strip,
  compare = null,
}: {
  file: FileDetail;
  /** The page's part of the strip above the player (#15), shown while it waits too. */
  strip?: { lead?: ReactNode; end?: ReactNode };
  /** The comparison under the transport (#44), where it is offered. */
  compare?: { open: boolean; onToggle: () => void } | null;
  /** A video's picture small, beside its lanes, for QA (#42). */
  compact?: boolean;
  /** The file's caption tracks (#201), and the one the player shows. */
  captions: readonly CaptionTrack[] | undefined;
  caption: string | null;
  onCaption: (id: string | null) => void;
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
          fill
        />
      );
    if (file.streamStatus === "pending") return <Notice>Drawing the pages.</Notice>;
    if (file.streamStatus === "failed")
      return <Notice>This file could not be drawn as pages.</Notice>;
    return <NothingToShow fileId={file.id} name={file.name} />;
  }
  if (file.kind !== "audio" && file.kind !== "video")
    return <NothingToShow fileId={file.id} name={file.name} />;
  // Waiting, the strip above stays: the version and variation can still be changed.
  const waiting = (message: ReactNode) => (
    <div className="flex flex-[1_0_auto] flex-col">
      {(strip?.lead || strip?.end) && <PlayerStrip lead={strip.lead}>{strip.end}</PlayerStrip>}
      <Notice>{message}</Notice>
    </div>
  );
  if (file.streamStatus === "failed")
    return waiting("This file could not be prepared for playback.");
  if (file.mediaInfo === null) return waiting("Measuring the file.");
  if (file.streamStatus === "pending") return waiting("Preparing for playback.");
  if (file.streamStatus !== "ready")
    return waiting("This file could not be prepared for playback.");
  if (error) return waiting(error.message);
  if (!data) return waiting("Loading the player.");
  return (
    <Player
      strip={strip}
      compare={compare}
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
      caption={caption}
      onCaption={onCaption}
      normalisation={file.normalisation}
      normalised={normalised}
      onNormalised={onNormalised}
      drawings={drawings}
      draft={draft}
      onDraft={file.kind === "video" && canComment ? onDraft : undefined}
      cuts={cuts}
      compact={compact}
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

/**
 * Review or QA (#15, #41), in the page's header as the prototype puts it: QA says how many
 * of its checks found something, where its checks are this viewer's to see.
 */
function ViewSwitch({
  fileId,
  view,
  onView,
  counts,
}: {
  fileId: string;
  view: "review" | "qa";
  onView: (view: FileView) => void;
  counts: boolean;
}) {
  const { data: qa } = useQuery({ ...qaQuery(fileId), enabled: counts });
  const issues = counts && qa?.status === "ready" ? qaIssues(qa.findings) : 0;
  return (
    <Segmented
      label="View"
      value={view}
      onChange={onView}
      options={[
        { value: "review", label: "Review" },
        { value: "qa", label: "QA", hint: issues > 0 ? String(issues) : undefined },
      ]}
      // On a phone the header's actions scroll in a row of their own; this keeps its size.
      className="shrink-0"
    />
  );
}

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
  const [versioning, setVersioning] = useState(false);
  const [chosenNormal, setChosenNormal] = useNormalisedChoice();
  // Arriving from another version or variation: start where that one was (#15).
  const { media, onMedia } = useFileMedia(fileId, startAt, onStarted);
  // Leading or following a listening room (#200) with this page's player; members only.
  const listening = useListeningSync(fileId, file?.projectId ?? "", guest ? null : media);
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
  // A video's or a recording's caption tracks (#146, #201): the player's Captions menu shows
  // one, and the transcript beside the comments lists one (the same, unless chosen there).
  const { data: captions } = useQuery({
    ...captionsQuery(fileId),
    enabled: file?.kind === "audio" || file?.kind === "video",
  });
  const [captionId, setCaptionId] = useState<string | null>(null);
  const [transcriptId, setTranscriptId] = useState<string | null>(null);
  const [panel, setPanel] = useState<SidePanel>("comments");
  // The comparison of versions and variations (#44), opened from the transport as the
  // prototype's; asking to hear a passage before and after opens it too.
  const [compareOpen, setCompareOpen] = useState(false);
  const { data: compareFamily } = useQuery({
    ...compareFamilyQuery(fileId),
    enabled: file?.kind === "audio" && Boolean(file?.variation),
  });
  // A track belongs to its file; the panel stays as it was where the next file has tracks too.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset whenever the file changes.
  useEffect(() => {
    setCaptionId(null);
    setTranscriptId(null);
  }, [fileId]);
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
    setCompareOpen(true);
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
  // A video's picture is checked too (#42), silent or not.
  const picture = file.kind === "video" && Boolean(file.mediaInfo?.video);
  const hasQa =
    Boolean(file.mediaInfo?.audio && (allows("qa") || allows("meters"))) ||
    (picture && allows("qa"));
  /** Triage (#132) belongs to members who may triage. */
  const canTriage = !guest && can("triage");
  /** A loose file's next version (#149), for those who may upload. */
  const canVersion = !guest && can("upload") && takesVersions(file);
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
  // What QA shows beside the checks, for a recording and for a video alike.
  const loudness = file.mediaInfo?.audio && allows("meters") && preferences.showLoudness && (
    <Loudness fileId={file.id} media={media} layout={file.mediaInfo.audio.channelLayout} />
  );
  const metadata = file.mediaInfo?.metadata && (
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
          <p className="m-0 text-[13px] text-ink-2">{admLine(file.mediaInfo.metadata.adm)}</p>
        </div>
      )}
    </section>
  );
  /** The track's score, where it is linked and this viewer has it: shown from the strip. */
  const hasScore = Boolean(
    file.variation?.scoreFileId &&
      allows("score") &&
      (file.kind === "audio" || file.kind === "video"),
  );
  /** Something to compare with: another version, variation or take this viewer may hear. */
  const compareOffered =
    comparing &&
    Boolean(compareFamily && compareSources(compareFamily, file.id, file.profile).length > 0);
  // The strip above the player (#15): the version and variation, or a loose file's versions
  // (#149), leading; the score's switch at its end, before the player's own menus.
  const strip = {
    lead:
      shown !== "triage" && (file.variation || file.chain.some((v) => v.id === file.id)) ? (
        <>
          <FileContext
            file={file}
            media={media}
            guest={guest}
            takes={!guest && can("view_takes")}
          />
          <FileChain file={file} />
        </>
      ) : undefined,
    end:
      hasScore && shown === "review" ? (
        <ScoreSwitch
          file={file}
          shown={layout.score}
          onToggle={() => setLayout({ score: !layout.score })}
        />
      ) : undefined,
  };
  const playback = (
    <Playback
      strip={strip}
      compare={
        compareOffered ? { open: compareOpen, onToggle: () => setCompareOpen((o) => !o) } : null
      }
      file={file}
      onMedia={onMedia}
      loop={passage}
      onLoop={onLoop}
      cue={cue}
      pages={pages}
      canComment={canComment}
      normalised={normalised}
      onNormalised={setChosenNormal}
      showFindings={Boolean(file.mediaInfo?.audio || picture) && allows("qa")}
      showEdits={!guest && can("view_takes")}
      comparePage={!guest}
      draft={frameDraft}
      onDraft={setFrameDraft}
      compact={picture && shown === "qa"}
      captions={captions}
      caption={captionId}
      onCaption={setCaptionId}
    />
  );
  /** The transcript is offered beside the comments wherever there is a track to read. */
  const transcribed = (captions?.length ?? 0) > 0;
  const tabs = transcribed ? <PanelTabs panel={panel} onPanel={setPanel} /> : undefined;
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
          player={
            // Framed in the queue, as a card beside the thread in hand.
            file.kind === "audio" || file.kind === "video" ? (
              <div className="rounded-panel border border-hairline bg-surface">{playback}</div>
            ) : (
              playback
            )
          }
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
        aria-label={
          commentList
            ? `Show comments, ${threadsOf(commentList).open.length} open`
            : "Show comments"
        }
        title="Show comments"
        // Only a wide screen puts the comments away; a phone always shows them.
        className="hidden lg:inline-flex"
        onClick={() => setLayout({ comments: "right" })}
      >
        <Icon name="comment" size={14} />
        {commentList ? threadsOf(commentList).open.length : null}
      </Button>
    ) : undefined;
  const viewSwitch = hasQa && (
    <ViewSwitch fileId={file.id} view={shown} onView={onView} counts={allows("qa")} />
  );
  const plays = file.kind === "audio" || file.kind === "video";
  const below = layout.comments === "below";
  // A take shared with a guest is theirs to hear, with no comments (#133).
  const commented = shown === "review" && !file.grant?.listenOnly;
  const detailList = (
    <dl className="m-0 flex shrink-0 flex-col border-t border-hairline">{detailRows}</dl>
  );

  /** What the column beside the comments holds: the player and what goes with it, or pages. */
  let main: ReactNode;
  const qaShown = shown !== "review";
  if (plays || qaShown) {
    // A recording or a video, full-bleed in its column (#15): the strip, the player and its
    // transport, then the comparison, the line of loudness and issues, the version's note and
    // the score. More than the frame holds scrolls, the comments staying beside it. QA keeps
    // the player at the top and scrolls what was measured under it. Both views share one tree,
    // so switching between them never remounts the player or stops the music.
    main = (
      <div
        className={cn(
          "flex flex-col lg:min-h-0 lg:flex-1",
          !qaShown && "scroll-quiet lg:overflow-y-auto",
        )}
      >
        {/* Comparison sets the volume while it is shown; otherwise, this does. */}
        {!(comparing && (qaShown || compareOpen)) && <PageVolume media={media} gain={gain} />}
        <ListeningNotice sync={listening} />
        <div className={qaShown ? "flex shrink-0 flex-col border-b border-line" : "contents"}>
          {playback}
        </div>
        {qaShown ? (
          <div className="scroll-quiet p-4 lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:p-6">
            {picture && file.mediaInfo && allows("qa") ? (
              <VideoQa
                fileId={file.id}
                info={file.mediaInfo}
                file={file}
                media={media}
                canChoose={!guest && can("edit_workflows")}
                onLoop={allows("loops") ? hear : undefined}
                onComment={canComment ? commentOn : undefined}
                aside={metadata}
              >
                {loudness}
              </VideoQa>
            ) : (
              <div className="flex min-w-0 flex-col gap-6">
                {allows("qa") && (
                  <QualityChecks
                    fileId={file.id}
                    media={media}
                    canChoose={!guest && can("edit_workflows")}
                    onLoop={allows("loops") ? hear : undefined}
                    onComment={canComment ? commentOn : undefined}
                  />
                )}
                {loudness}
                <dl className="m-0 flex flex-col border-t border-hairline">{detailRows}</dl>
                {metadata}
              </div>
            )}
          </div>
        ) : (
          <>
            {comparing && compareOpen && (
              <Compare file={file} media={media} focus={focus} gain={gain} />
            )}
            {hasQa && allows("qa") && loudnessShown && (
              // Nothing measured yet, nothing shown, and no line drawn for it.
              <div className="shrink-0 border-t border-line px-3 py-2 empty:hidden lg:px-4">
                <QaSummary fileId={file.id} onOpen={() => onView("qa")} />
              </div>
            )}
            {!guest && <VersionNote file={file} />}
            {hasScore && layout.score && file.variation?.scoreFileId && (
              <ScorePane
                scoreFileId={file.variation.scoreFileId}
                guest={guest}
                onHide={() => setLayout({ score: false })}
              />
            )}
            {/* A recording's details belong to QA; one without it keeps them here. */}
            {!hasQa && <div className="px-3 pb-4 lg:px-4">{detailList}</div>}
          </>
        )}
      </div>
    );
  } else if (pages) {
    // A document or picture fills the frame, its pages scrolling inside it; its details
    // follow, a scroll away.
    main = (
      <div className="scroll-quiet flex flex-col lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
        <div className="flex flex-col gap-3 p-3 lg:h-full lg:shrink-0 lg:p-4">
          <FileChain file={file} />
          {playback}
        </div>
        <div className="px-3 pb-4 lg:px-4">{detailList}</div>
      </div>
    );
  } else {
    // Nothing to show: what it is, in the middle of the frame, and its details.
    main = (
      <div className="scroll-quiet flex flex-col lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
        <div className="flex flex-1 flex-col">
          {file.chain.some((v) => v.id === file.id) && (
            <div className="px-3 pt-3 lg:px-4">
              <FileChain file={file} />
            </div>
          )}
          {playback}
        </div>
        <div className="px-3 pb-4 lg:px-4">{detailList}</div>
      </div>
    );
  }

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
        meta={summary ? undefined : fileSummary(file)}
        actions={
          guest ? (
            <>
              {viewSwitch}
              {commentsButton}
              {downloadButton}
            </>
          ) : (
            <>
              {viewSwitch}
              {commentsButton}
              {plays && <ListenTogether fileId={file.id} projectId={file.projectId} />}
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
              {(canTriage || canVersion) && (
                <ActionMenu
                  always
                  label="file"
                  actions={[
                    ...(canVersion
                      ? [{ label: "New version…", onSelect: () => setVersioning(true) }]
                      : []),
                    ...(canTriage
                      ? [
                          { label: "Export comments…", onSelect: () => setExporting(true) },
                          ...(plays
                            ? [
                                {
                                  label: "Import a marker list…",
                                  onSelect: () => setImporting(true),
                                },
                              ]
                            : []),
                          { label: "Triage comments", onSelect: () => onView("triage") },
                        ]
                      : []),
                  ]}
                />
              )}
            </>
          )
        }
      />
      {versioning && <NewVersionDialog file={file} onClose={() => setVersioning(false)} />}
      {exporting && <ExportCommentsDialog file={file} onClose={() => setExporting(false)} />}
      {importing && <ImportMarkersDialog file={file} onClose={() => setImporting(false)} />}
      {!guest && showDetails && (
        <FileDetailsSheet fileId={file.id} onClose={() => onDetails(false)} />
      )}
      {/*
        The frame (#15), as the prototype draws it: on a wide screen it fills the window under
        the header, the player's column beside the comments (or over them, or alone) and each
        scrolling on its own; on a phone the comments follow the player down the page.
      */}
      <div
        className={cn(
          "fade-in flex min-h-full flex-col lg:h-full lg:min-h-0",
          commented && !below && "lg:flex-row",
        )}
      >
        <div className="flex min-w-0 flex-col lg:min-h-0 lg:flex-1">{main}</div>
        {commented && (
          <div
            className={cn(
              "relative flex min-w-0 shrink-0 flex-col border-t border-line lg:min-h-0",
              below ? "lg:h-[400px]" : "lg:w-[var(--comments-width)] lg:border-t-0 lg:border-l",
              // Put away on a wide screen only: a phone always shows them (#15).
              layout.comments === "hidden" && "lg:hidden",
            )}
            style={{ ["--comments-width" as string]: `${layout.width}px` }}
          >
            {!below && (
              <CommentsSplitter
                width={layout.width}
                onWidth={(width) => setLayout({ width })}
                className="absolute inset-y-0 -left-1 z-10 hidden lg:block"
              />
            )}
            {reviewId && <DecisionStrip reviewId={reviewId} />}
            {transcribed && captions && panel === "transcript" ? (
              <Transcript
                fileId={file.id}
                tracks={captions}
                trackId={transcriptId ?? captionId}
                onTrack={setTranscriptId}
                media={media}
                clock={file.mediaInfo?.video ? videoClock(file.mediaInfo.video) : null}
                canExport={downloads !== undefined && downloads.level !== "none"}
                heading={tabs}
                tools={<PanelPlacement layout={layout} onChange={setLayout} />}
              />
            ) : (
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
                heading={tabs}
                tools={<PanelPlacement layout={layout} onChange={setLayout} />}
                focus={focusComment}
              />
            )}
          </div>
        )}
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
