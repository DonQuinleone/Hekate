import {
  type CaptionTrack,
  containerName,
  fileStart,
  findingLine,
  formatBytes,
  formatClock,
  type MediaInfo,
  mediaFormat,
  type QaFinding,
  type ReviewerTool,
  soundLine,
  videoClock,
} from "@hekate/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Checksum } from "~/components/checksum";
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
import { FollowRecorderSettings, useFollowRecorder } from "~/components/follow-recorder";
import { Icon } from "~/components/icons";
import { ListeningNotice, ListenTogether, useListeningSync } from "~/components/listening";
import { Loudness } from "~/components/loudness";
import { ImportMarkersDialog } from "~/components/marker-import";
import { EmbeddedMetadataPanel } from "~/components/metadata";
import { type Crumb, PageHeader } from "~/components/page-header";
import { CommentsSplitter, PanelPlacement } from "~/components/panel-placement";
import { Player, PlayerStrip } from "~/components/player";
import { findingMarks, QaLayout, QualityChecks, qaIssues, soundStats } from "~/components/qa";
import { VideoQa } from "~/components/qa-video";
import { ScorePane } from "~/components/score";
import { ShareDialog } from "~/components/share";
import { TrackStatusChip } from "~/components/status-chip";
import { FileContext, ScoreSwitch, VersionNote } from "~/components/tracks";
import { PanelTabs, type SidePanel, Transcript } from "~/components/transcript";
import { TriageView } from "~/components/triage";
import { Button } from "~/components/ui/button";
import { ActionMenu } from "~/components/ui/menu";
import { Segmented } from "~/components/ui/segmented";
import { failureText, Loading } from "~/components/ui/states";
import { cn } from "~/lib/cn";
import { threadsOf } from "~/lib/comments";
import { compareSources, cutAgainst, previousCut } from "~/lib/compare";
import { editSegments } from "~/lib/edit-decisions";
import { useFileMedia } from "~/lib/file-media";
import { useListening } from "~/lib/listening-room";
import { formatDates } from "~/lib/locale";
import type { Loop } from "~/lib/loop";
import { initialFocus, type PageFocus } from "~/lib/pages";
import { usePanelLayout } from "~/lib/panel-layout";
import {
  captionsQuery,
  commentsQuery,
  compareFamilyQuery,
  downloadsQuery,
  editDecisionsQuery,
  type FileDetail,
  fileDetailsQuery,
  fileQuery,
  playbackQuery,
  projectQuery,
  qaQuery,
  reviewQuery,
  trackTakesQuery,
  useMarks,
  usePreferences,
  useProjectCan,
} from "~/lib/queries";
import { fileShareTargets } from "~/lib/shares";
import { useViewer } from "~/lib/viewer";
import { PageFailed } from "~/routes/problem";

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

/**
 * Where a file starts on a DAW's timeline, in seconds since midnight (#450): its Broadcast Wave
 * time reference, or a video's own timecode; zero where it says neither.
 */
function fileStartOf(info: MediaInfo | null): number {
  const bext = fileStart(info?.metadata, info?.audio?.sampleRate);
  if (bext !== null) return bext;
  const clock = info?.video ? videoClock(info.video) : null;
  return clock ? (clock.start * clock.rate.den) / clock.rate.num : 0;
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
  passage = false,
  captions,
  caption,
  onCaption,
  strip,
  compare = null,
  follow,
  gain,
  onMarker,
  activeMarker = null,
}: {
  /** A thread's marker picked over the media (#562), and the thread open beside it. */
  onMarker?: (id: string) => void;
  activeMarker?: string | null;
  file: FileDetail;
  /** What it plays at under the volume: normalised playback's gain, or null while the comparison sets it. */
  gain: number | null;
  /** The page's part of the strip above the player (#15), shown while it waits too. */
  strip?: { lead?: ReactNode; end?: ReactNode };
  /** The comparison under the transport (#44), where it is offered. */
  compare?: { open: boolean; onToggle: () => void } | null;
  /** A video's picture small, beside its lanes, for QA (#42). */
  compact?: boolean;
  /** Only the passage, small, as triage shows it (#632). */
  passage?: boolean;
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
  /** Following a DAW's position (#450): its settings for the View menu, for members. */
  follow?: ReactNode;
}) {
  const client = useQueryClient();
  // A take shared with a guest has no comments for them (#133).
  const markers = useCommentMarkers(file.id, !file.grant?.listenOnly);
  const regions = useRegionMarkers(file.id, !file.grant?.listenOnly);
  const drawings = useFrameDrawings(file.id, file.kind === "video" && !file.grant?.listenOnly);
  const { data: qa } = useQuery({ ...qaQuery(file.id), enabled: showFindings });
  const findings = showFindings ? findingMarks(qa?.findings ?? []) : [];
  const variant = showEdits ? file.variant : null;
  const { data: decisions } = useQuery({
    ...editDecisionsQuery(variant?.trackId ?? "", undefined, variant?.versionId),
    enabled: Boolean(variant),
  });
  const { data: takes } = useQuery({
    ...trackTakesQuery(variant?.trackId ?? ""),
    enabled: Boolean(decisions),
  });
  const edits = useMemo(
    () => editSegments(decisions, (id) => takes?.find((t) => t.id === id)?.number),
    [decisions, takes],
  );
  // A deliverable's cut is compared frame by frame with the one before it (#147).
  const { data: family } = useQuery({
    ...compareFamilyQuery(file.id),
    enabled: file.kind === "video" && Boolean(file.variant),
  });
  // The cut chosen on the comparison page, where it came from there; else the one before.
  const against = (useSearch({ strict: false }) as { against?: string }).against;
  const before = family
    ? ((against ? cutAgainst(family, file.id, against, file.profile) : undefined) ??
      previousCut(family, file.id, file.profile))
    : undefined;
  const cuts = before
    ? {
        ...before,
        // Where the two cuts' comments and findings are set side by side (#137).
        compare:
          comparePage && file.variant
            ? {
                trackId: file.variant.trackId,
                a: before.previous.versionNumber,
                b: file.variant.versionNumber,
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
  // Waiting, the strip above stays: the version and variant can still be changed.
  const waiting = (message: ReactNode) => (
    <div className="flex flex-[1_0_auto] flex-col">
      {(strip?.lead || strip?.end) && <PlayerStrip lead={strip.lead}>{strip.end}</PlayerStrip>}
      <Notice>{message}</Notice>
    </div>
  );
  if (file.streamStatus === "failed")
    return waiting(
      "This file could not be prepared for playback. Upload it again, or ask whoever runs the instance.",
    );
  if (file.mediaInfo === null) return waiting("Measuring the file.");
  if (file.streamStatus === "pending") return waiting("Preparing for playback.");
  if (file.streamStatus !== "ready")
    return waiting("This file is not ready for playback yet. Come back in a moment.");
  if (error) return waiting(failureText(error));
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
      onMarker={onMarker}
      activeMarker={activeMarker}
      findings={findings}
      // Triage's passage is the passage alone (#632): no lane of edits under it.
      edits={variant && !passage ? edits : []}
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
      passage={passage}
      follow={follow}
      gain={gain}
      onExpired={() => client.resetQueries({ queryKey: playbackQuery(file.id).queryKey })}
    />
  );
}

/** A guest's facts about the file (#635), folded under one "Details" until asked for. */
function GuestDetails({ facts }: { facts: [string, string][] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col border-t border-hairline">
      <Button
        variant="ghost"
        size="sm"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="-mx-2 mt-1 self-start text-ink-3"
      >
        <Icon name={open ? "chevronDown" : "chevronRight"} size={14} />
        Details
      </Button>
      {open && (
        <dl className="m-0 flex flex-col">
          {facts.map(([term, value]) => (
            <div
              key={term}
              className="grid grid-cols-[minmax(0,120px)_1fr] gap-x-6 border-b border-hairline py-2.5"
            >
              <dt className="text-[13px] text-ink-3">{term}</dt>
              <dd className="tabular m-0 truncate text-[13px] text-ink-2">{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
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
        { value: "qa", label: "QA", badge: issues },
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
  /** The passage being looped, kept in the address so it holds across versions and variants. */
  loop?: Loop | null;
  onLoop?: (loop: Loop | null) => void;
}) {
  const { data: file, error, refetch } = useQuery(fileQuery(fileId));
  // Whether this person may download it at all, and so whether to offer it (#136).
  const { data: downloads } = useQuery(downloadsQuery(fileId));
  const [downloading, setDownloading] = useState(false);
  const [cue, setCue] = useState(0);
  /** A comment begun from a finding (#43), for the composer to start from. */
  const [seed, setSeed] = useState<CommentSeed | undefined>(undefined);
  /** A source comparison should bring in and play first: before, for before and after. */
  const [focus, setFocus] = useState<CompareFocus | null>(null);
  const { guest } = useViewer();
  const navigate = useNavigate();
  const wide = useWide();
  // The checksum for QA's format panel (#491) comes with the details, which members may read.
  const { data: fileDetails } = useQuery({
    ...fileDetailsQuery(fileId),
    enabled: !guest && view === "qa",
  });
  // What QA measured, for its row of figures (#634); the checks keep the same query fresh.
  const { data: qaData } = useQuery({ ...qaQuery(fileId), enabled: view === "qa" });
  const preferences = usePreferences();
  /** On a document: the page shown, and the region drawn or thread picked on it. */
  const [pageFocus, setPageFocus] = useState<PageFocus>(initialFocus);
  const [frameDraft, setFrameDraft] = useState<FrameDraft | null>(null);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [versioning, setVersioning] = useState(false);
  const [sharing, setSharing] = useState(false);
  /** The thread whose marker was picked over the media (#562): opened and marked beside it. */
  const [pickedThread, setPickedThread] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a thread belongs to its file.
  useEffect(() => setPickedThread(null), [fileId]);
  const [chosenNormal, setChosenNormal] = useNormalisedChoice();
  // Arriving from another version or variant: start where that one was (#15).
  const { media, onMedia } = useFileMedia(fileId, startAt, onStarted);
  // Leading or following a listening room (#200) with this page's player; members only.
  const listening = useListeningSync(fileId, file?.projectId ?? "", guest ? null : media);
  // Following a DAW's position (#450, decision 240), from where the file starts on its timeline:
  // its own Broadcast Wave time reference, or a video's own timecode, as far as either says.
  const room = useListening();
  const follow = useFollowRecorder(
    guest ? null : media,
    fileStartOf(file?.mediaInfo ?? null),
    Boolean(room?.room && !room.leading && room.status !== "ended"),
  );
  // Where the comments sit on a wide screen, this viewer's choice (#15).
  const [layout, setLayout] = usePanelLayout();
  /** Where the comments were before they were put away, so the toggle brings them back there. */
  const lastPlace = useRef<"right" | "below" | null>(null);
  if (layout.comments !== "hidden") lastPlace.current = layout.comments;
  const commentsShown = layout.comments !== "hidden";
  // The same query as the pane's: the header's toggle carries the count of open threads, the
  // one place a wide screen says it (#642).
  const { data: commentList } = useQuery({
    ...commentsQuery(fileId),
    // A take shared with a guest to hear has no comments for them (#133).
    enabled: file !== undefined && !file.grant?.listenOnly,
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
  // The comparison of versions and variants (#44), opened from the transport as the
  // prototype's; asking to hear a passage before and after opens it too.
  const [compareOpen, setCompareOpen] = useState(false);
  const { data: compareFamily } = useQuery({
    ...compareFamilyQuery(fileId),
    enabled: file?.kind === "audio" && Boolean(file?.variant),
  });
  // A track belongs to its file; the panel stays as it was where the next file has tracks too.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset whenever the file changes.
  useEffect(() => {
    setCaptionId(null);
    setTranscriptId(null);
  }, [fileId]);
  const can = useProjectCan(guest || !file ? undefined : file.projectId);
  // A guest's trail names the review the file was opened from (#666).
  const { data: openedFrom } = useQuery({
    ...reviewQuery(reviewId ?? ""),
    enabled: Boolean(guest && reviewId),
  });
  // Guests see the files of their reviews, never the project around them.
  const { data: project } = useQuery({
    ...projectQuery(file?.projectId ?? ""),
    enabled: Boolean(file) && !guest,
  });
  if (error) return <PageFailed what="This file" error={error} retry={refetch} />;
  if (!file) return <Loading />;
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
      ...(target.label && file.variant
        ? { outside: { label: target.label, trackId: file.variant.trackId } }
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
      // The check named once (#564): "True peak 0.9 dBTP", not "True peak: True peak 0.9 dBTP".
      body: findingLine(finding),
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
  const comparable = allows("compare") && file.kind === "audio" && file.streamStatus === "ready";
  // Comparison sets the volume while it is shown (its sources level-matched); otherwise the
  // player plays at the page's gain under the volume (#493).
  const comparing = comparable && shown === "review";
  const playerGain = comparing && compareOpen ? null : gain;
  const summary = mediaSummary(file.kind, file.mediaInfo, file.streamStatus);
  /**
   * The format's facts in words (#635), said once on the page: QA's Format for a recording, a
   * guest's Details. Never a MIME type or a codec's id.
   */
  const container = containerName(file.mediaInfo?.format, file.contentType);
  const formatFacts: [string, ReactNode][] = [
    ...(file.mediaInfo?.audio
      ? [["Sound", soundLine(file.mediaInfo.audio)] as [string, string]]
      : []),
    ["File", [container, formatBytes(file.byteSize)].filter(Boolean).join(" · ")],
    // The checksum, with a copy, where the details have arrived (#491).
    ...(fileDetails
      ? [
          ["Checksum", <Checksum key="sum" sha256={fileDetails.storage.sha256} />] as [
            string,
            ReactNode,
          ],
        ]
      : []),
  ];
  /** What a file with no player is, in words (#635): never its MIME type. */
  const fileWords = fileSummary(file) === file.contentType ? "File" : fileSummary(file);
  /** What a guest may read of the file (#635), behind a disclosure so comments come first. */
  const guestFacts: [string, string][] = [
    ["Format", mediaFormat(file.mediaInfo) ?? fileWords],
    ["File", [container, formatBytes(file.byteSize)].filter(Boolean).join(" · ")],
    ...(file.mediaInfo?.duration !== undefined
      ? [["Length", formatClock(file.mediaInfo.duration)] as [string, string]]
      : []),
    ["Added", dateFormat.format(new Date(file.createdAt))],
  ];
  const crumbs: Crumb[] = guest
    ? [
        { key: "reviews", link: <Link to="/g">Your reviews</Link> },
        // The review it was opened from (#666), so a guest never loses which one they are in.
        ...(reviewId && openedFrom
          ? [
              {
                key: "review",
                link: (
                  <Link to="/g/reviews/$reviewId" params={{ reviewId }}>
                    {openedFrom.title}
                  </Link>
                ),
              },
            ]
          : []),
      ]
    : [
        {
          key: "project",
          link: (
            <Link to="/projects/$projectId/files" params={{ projectId: file.projectId }}>
              {project?.name ?? "Project"}
            </Link>
          ),
        },
      ];
  /**
   * A track's file is titled by its track, in full (#561): the strip under the header says
   * which version and variant it is, as the prototype has it. A loose file keeps its name.
   */
  const title = file.variant ? file.variant.trackName : file.name;
  // What QA shows beside the checks, for a recording and for a video alike.
  const loudness = file.mediaInfo?.audio && allows("meters") && preferences.showLoudness && (
    <Loudness
      fileId={file.id}
      media={media}
      layout={file.mediaInfo.audio.channelLayout}
      // QA's row of figures gives integrated loudness and true peak where QA is a tool here.
      figures={!allows("qa")}
    />
  );
  const metadata = file.mediaInfo?.metadata && (
    <EmbeddedMetadataPanel
      fileId={file.id}
      metadata={file.mediaInfo.metadata}
      sampleRate={file.mediaInfo.audio?.sampleRate}
      // A recording's metadata can be corrected (decision 264), by whoever organises its files
      // and has QA, where they have turned the editor on.
      editor={
        !guest &&
        file.kind === "audio" &&
        preferences.showMetadataEditor &&
        allows("qa") &&
        can("organise")
      }
    />
  );
  /** The track's score, where it is linked and this viewer has it: shown from the strip. */
  const hasScore = Boolean(
    file.variant?.scoreFileId &&
      allows("score") &&
      (file.kind === "audio" || file.kind === "video"),
  );
  /** Something to compare with: another version, variant or take this viewer may hear. */
  const compareOffered =
    comparing &&
    Boolean(compareFamily && compareSources(compareFamily, file.id, file.profile).length > 0);
  // The strip above the player (#15): the version and variant, or a loose file's versions
  // (#149), leading; the score's switch at its end, before the player's own menus.
  const strip = {
    lead:
      shown !== "triage" && (file.variant || file.chain.some((v) => v.id === file.id)) ? (
        <>
          <FileContext file={file} media={media} guest={guest} />
          <FileChain file={file} />
          {/* Where the track stands (#498), moved on from here by those who may. */}
          {file.variant && !guest && (
            <TrackStatusChip trackId={file.variant.trackId} projectId={file.projectId} />
          )}
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
      passage={shown === "triage"}
      captions={captions}
      caption={captionId}
      onCaption={setCaptionId}
      follow={guest ? undefined : <FollowRecorderSettings follow={follow} />}
      gain={playerGain}
      onMarker={(id) => {
        setPickedThread(id);
        // Its thread is beside the player: shown if the comments were put away.
        if (layout.comments === "hidden") setLayout({ comments: lastPlace.current ?? "right" });
      }}
      activeMarker={pickedThread ?? focusComment ?? null}
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
                  {title}
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
        <TriageView
          file={file}
          media={media}
          // The passage alone (#632), as the prototype's triage has it; pages stay pages.
          player={playback}
          onLoop={onLoop}
          onDone={() => onView("review")}
        />
      </>
    );
  const mayDownload = downloads !== undefined && downloads.level !== "none";
  const downloadButton = mayDownload ? (
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
  /** The comments shown or put away, from one place whatever their state, with how many are open. */
  const commentsButton =
    shown === "review" && !file.grant?.listenOnly ? (
      <Button
        variant="ghost"
        size="sm"
        aria-label={
          commentList ? `Comments, ${threadsOf(commentList).open.length} open` : "Comments"
        }
        aria-pressed={commentsShown}
        title={commentsShown ? "Hide comments" : "Show comments"}
        // Only a wide screen puts the comments away; a phone always shows them.
        className={cn("hidden lg:inline-flex", commentsShown && "bg-raised text-ink")}
        onClick={() =>
          setLayout({ comments: commentsShown ? "hidden" : (lastPlace.current ?? "right") })
        }
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
  /** A guest's details, folded (#635): the comments come first under the player. */
  const detailList = guest ? <GuestDetails facts={guestFacts} /> : null;

  /** What the column beside the comments holds: the player and what goes with it, or pages. */
  let main: ReactNode;
  const qaShown = shown !== "review";
  if (plays || qaShown) {
    // A recording or a video, full-bleed in its column (#15): the strip, the player and its
    // transport, then the comparison, the line of loudness and issues, the version's note and
    // the score. More than the frame holds scrolls, the comments staying beside it. QA keeps
    // the player at the top and scrolls what was measured under it. Both views share one tree,
    // so switching between them never remounts the player or stops the music.
    /** The score beside the player on a wide screen (#646), rather than under its transport. */
    const scoreBeside =
      !qaShown && hasScore && layout.score && file.variant?.scoreFileId ? (
        <ScorePane
          scoreFileId={file.variant.scoreFileId}
          guest={guest}
          onHide={() => setLayout({ score: false })}
          width={layout.scoreWidth}
          onWidth={(scoreWidth) => setLayout({ scoreWidth })}
        />
      ) : null;
    const column = (
      <div
        className={cn(
          "flex flex-col lg:min-h-0 lg:flex-1",
          !qaShown && "scroll-quiet lg:overflow-y-auto",
          scoreBeside && "min-w-0",
        )}
      >
        <ListeningNotice sync={listening} />
        <div className={qaShown ? "flex shrink-0 flex-col border-b border-line" : "contents"}>
          {playback}
        </div>
        {qaShown ? (
          <div className="scroll-quiet p-4 lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:p-6">
            {/* One layout for a recording and a video (#634). */}
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
              <QaLayout
                stats={[
                  ...(allows("qa") ? soundStats(qaData?.findings ?? []) : []),
                  ...(file.mediaInfo?.duration !== undefined
                    ? [{ label: "Length", value: formatClock(file.mediaInfo.duration) }]
                    : []),
                ]}
                checks={
                  allows("qa") && (
                    <QualityChecks
                      fileId={file.id}
                      media={media}
                      canChoose={!guest && can("edit_workflows")}
                      onLoop={allows("loops") ? hear : undefined}
                      onComment={canComment ? commentOn : undefined}
                    />
                  )
                }
                format={formatFacts}
                aside={metadata}
              >
                {loudness}
              </QaLayout>
            )}
          </div>
        ) : (
          <>
            {comparing && compareOpen && (
              <Compare file={file} media={media} focus={focus} gain={gain} />
            )}
            {!guest && <VersionNote file={file} />}
            {/* A file's details are the Details sheet's (#635); a guest's fold away here. */}
            {detailList && <div className="px-3 pb-4 lg:px-4">{detailList}</div>}
          </>
        )}
      </div>
    );
    main = scoreBeside ? (
      <div className="flex flex-col lg:min-h-0 lg:flex-1 lg:flex-row">
        {column}
        {scoreBeside}
      </div>
    ) : (
      column
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
        {detailList && <div className="px-3 pb-4 lg:px-4">{detailList}</div>}
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
        {detailList && <div className="px-3 pb-4 lg:px-4">{detailList}</div>}
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
        title={title}
        // Media formats show in the player; other files say what they are here.
        meta={summary ? undefined : fileWords}
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
              {/* On a phone, Download goes into "…" so Share, the page's main action, stays in reach. */}
              {wide && downloadButton}
              {/* Sharing this file (#489): the sheet the browser and a track's versions open too. */}
              {can("request_reviews") && project && !project.archivedAt && (
                <Button variant="secondary" size="sm" onClick={() => setSharing(true)}>
                  <Icon name="link" size={14} />
                  Share
                </Button>
              )}
              <ActionMenu
                always
                label="file"
                actions={[
                  ...(!wide && mayDownload
                    ? [{ label: "Download…", onSelect: () => setDownloading(true) }]
                    : []),
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
                  // A track's takes (#644): reached from here and the track page, never the version menu.
                  ...(file.variant && can("view_takes")
                    ? [
                        {
                          label: "Takes of this track",
                          onSelect: () =>
                            void navigate({
                              to: "/tracks/$trackId",
                              params: { trackId: file.variant?.trackId ?? "" },
                              search: { view: "takes" },
                            }),
                        },
                      ]
                    : []),
                  "divider" as const,
                  // The details sheet (#561), as the prototype offers it: from the menu.
                  { label: "Details", onSelect: () => onDetails(true) },
                ]}
              />
            </>
          )
        }
      />
      {versioning && <NewVersionDialog file={file} onClose={() => setVersioning(false)} />}
      {sharing && (
        // A track's file shares its version, with the file alone as the other choice (#578).
        <ShareDialog
          projectId={file.projectId}
          {...fileShareTargets(file)}
          onClose={() => setSharing(false)}
        />
      )}
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
                focus={pickedThread ?? focusComment}
              />
            )}
          </div>
        )}
      </div>
    </>
  );
}

/** Whether the window is a wide screen's (Tailwind's `lg`), where the header has room for more. */
function useWide(): boolean {
  const query = "(min-width: 64rem)";
  const [wide, setWide] = useState(
    () => typeof matchMedia !== "function" || matchMedia(query).matches,
  );
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const media = matchMedia(query);
    const change = () => setWide(media.matches);
    change();
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  return wide;
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
