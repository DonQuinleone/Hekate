import { Link, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Avatar } from "~/components/avatar";
import { CommentsColumn, orderThreads } from "~/components/comments/column";
import { DownloadDialog, FileDetailsSheet } from "~/components/details";
import { ExportCommentsDialog, ImportCommentsDialog } from "~/components/exports";
import { Icon } from "~/components/icons";
import { ListeningNotice, ListenTogether } from "~/components/listen-together";
import { usePageHeader } from "~/components/page-header";
import { markersFrom, PageViewer } from "~/components/pages";
import { CompareBar, type Source } from "~/components/player/compare";
import { usePlayback } from "~/components/player/playback";
import { FrequencyScale, Spectrogram } from "~/components/player/spectrogram";
import {
  defaultView,
  LoopBar,
  Seg,
  Transport,
  type View,
  ViewMenu,
} from "~/components/player/transport";
import {
  EditLane,
  type EditStretch,
  type Marker,
  Ruler,
  Waveform,
} from "~/components/player/waveform";
import { QaView } from "~/components/qa";
import { VideoQaView } from "~/components/qa-video";
import { Dot } from "~/components/status";
import {
  CaptionLine,
  CaptionsMenu,
  PanelTabs,
  type SidePanel,
  TranscriptColumn,
} from "~/components/transcript";
import { Button } from "~/components/ui/button";
import { ActionMenu, Dropdown, MenuList, usePopover } from "~/components/ui/menu";
import { AddVariationDialog } from "~/components/variation-dialog";
import { Filmstrip, Frame } from "~/components/video";
import {
  AudioLayoutMenu,
  CompareCuts,
  type DrawTool,
  DrawToolbar,
  GoTo,
  SafeAreas,
} from "~/components/video-tools";
import {
  comments as allComments,
  takes as allTakes,
  type Comment,
  captionTracksFor,
  fileById,
  findingsFor,
  personById,
  projectById,
  reviewById,
  variationOf,
} from "~/data";
import { cn } from "~/lib/cn";
import { chainOf, qaSummary } from "~/lib/files";
import { dueIn, formatDateTime, formatReference } from "~/lib/format";
import { latestDecision, needsYou } from "~/lib/reviews";
import { useViewer, visibleComments } from "~/viewer/context";
import { Refused, useScreenState } from "~/viewer/state-gate";
import { TriagePage } from "./triage.tsx";

const VIEW_KEY = "hekate.prototype.view";
const LAYOUT_KEY = "hekate.prototype.layout";

function remembered<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...(JSON.parse(raw) as Partial<T>) } : fallback;
  } catch {
    return fallback;
  }
}
function remember(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Not remembered.
  }
}

function useView(): [View, (v: View) => void] {
  const [view, setView] = useState<View>(() => remembered(VIEW_KEY, defaultView));
  return [
    view,
    (v) => {
      setView(v);
      remember(VIEW_KEY, v);
    },
  ];
}

/** Where the panels sit. The viewer's, and remembered. */
interface Layout {
  comments: "right" | "below" | "hidden";
  width: number;
  score: boolean;
  scoreHeight: number;
}
const defaultLayout: Layout = {
  comments: "right",
  width: 400,
  score: false,
  scoreHeight: 360,
};

function useLayout(): [Layout, (patch: Partial<Layout>) => void] {
  const [layout, setLayout] = useState<Layout>(() => remembered(LAYOUT_KEY, defaultLayout));
  return [
    layout,
    (patch) =>
      setLayout((l) => {
        const next = { ...l, ...patch };
        remember(LAYOUT_KEY, next);
        return next;
      }),
  ];
}

/** A handle between two panels: drag to resize. */
function Splitter({
  axis,
  onDrag,
  className,
}: {
  axis: "x" | "y";
  onDrag: (delta: number) => void;
  className?: string;
}) {
  const last = useRef(0);
  return (
    <div
      role="separator"
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      className={cn(
        "group/split relative z-10 shrink-0 touch-none",
        axis === "x" ? "w-1.5 cursor-col-resize" : "h-1.5 cursor-row-resize",
        className,
      )}
      onPointerDown={(e) => {
        last.current = axis === "x" ? e.clientX : e.clientY;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!(e.buttons & 1)) return;
        const now = axis === "x" ? e.clientX : e.clientY;
        onDrag(now - last.current);
        last.current = now;
      }}
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute rounded-full bg-line-strong opacity-0 transition-opacity group-hover/split:opacity-100 group-active/split:bg-signal group-active/split:opacity-100",
          axis === "x"
            ? "top-1/2 left-0.5 h-10 w-0.5 -translate-y-1/2"
            : "top-0.5 left-1/2 h-0.5 w-10 -translate-x-1/2",
        )}
      />
    </div>
  );
}

/** Where the comments panel sits. */
function PanelPlacement({ layout, set }: { layout: Layout; set: (p: Partial<Layout>) => void }) {
  const [open, setOpen, box] = usePopover();
  return (
    <div ref={box} className="relative hidden @3xl/app:block">
      <button
        type="button"
        aria-label="Panel position"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={cn(
          "flex size-7 items-center justify-center rounded-control text-ink-3 transition-colors hover:bg-raised hover:text-ink",
          open && "bg-raised text-ink",
        )}
      >
        <Icon name={layout.comments === "below" ? "layoutBottom" : "layoutRight"} size={14} />
      </button>
      {open && (
        <MenuList
          anchor={box}
          onClose={() => setOpen(false)}
          actions={[
            {
              label: "Comments on the right",
              checked: layout.comments === "right",
              onSelect: () => set({ comments: "right" }),
            },
            {
              label: "Comments below",
              checked: layout.comments === "below",
              onSelect: () => set({ comments: "below" }),
            },
          ]}
        />
      )}
    </div>
  );
}

/** The reviewer's decision, where they are listening: no going back to the review page. */
function DecisionStrip({ reviewId }: { reviewId: string }) {
  const viewer = useViewer();
  const review = reviewById(reviewId);
  const me = review ? viewer.reviewerIn(review) : undefined;
  const [recorded, setRecorded] = useState<"approved" | "changes_requested" | "submitted" | null>(
    null,
  );
  if (!review || !me || review.kind === "share") return null;
  const due = review.dueAt ? dueIn(review.dueAt) : null;
  const decision = recorded && recorded !== "submitted" ? recorded : latestDecision(me);
  const done = decision || recorded === "submitted" || me.state === "submitted";
  const base = viewer.isGuest ? "/g/reviews/$reviewId" : "/reviews/$reviewId";
  return (
    <div className="border-b border-line bg-raised/30 px-3 py-2.5">
      <div className="flex items-center gap-2 text-[12px] text-ink-3">
        <Link
          to={base}
          params={{ reviewId: review.id }}
          className="truncate font-medium text-ink-2 hover:text-ink"
        >
          {review.title}
        </Link>
        {due && review.status === "open" && (
          <span className={cn("ml-auto shrink-0", due.days < 0 && "text-signal")}>{due.label}</span>
        )}
      </div>
      {done ? (
        <p className="mt-1.5 flex items-center gap-2 text-[13px] text-ink">
          <Dot
            state={
              decision === "changes_requested"
                ? "changes_requested"
                : decision === "approved"
                  ? "approved"
                  : "submitted"
            }
          />
          {decision === "approved"
            ? "You approved"
            : decision === "changes_requested"
              ? "You requested changes"
              : "Feedback submitted"}
          <button
            type="button"
            onClick={() => setRecorded(null)}
            className="ml-auto text-[12px] text-ink-3 hover:text-ink"
          >
            Again
          </button>
        </p>
      ) : needsYou(review, me) ? (
        <div className="mt-2 flex gap-1.5">
          {review.kind === "approval" && me.permissions.decide ? (
            <>
              <Button variant="primary" size="sm" onClick={() => setRecorded("approved")}>
                Approve
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setRecorded("changes_requested")}
              >
                Request changes
              </Button>
            </>
          ) : review.kind === "feedback" ? (
            <Button variant="primary" size="sm" onClick={() => setRecorded("submitted")}>
              Submit feedback
            </Button>
          ) : (
            <span className="text-[12px] text-ink-3">
              You comment; the decision rests with others.
            </span>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function FilePage({
  fileId,
  view: viewParam,
  commentId,
  reviewId,
}: {
  fileId: string;
  view?: string;
  commentId?: string;
  reviewId?: string;
  version?: string;
  variation?: string;
}) {
  const viewer = useViewer();
  const navigate = useNavigate();
  const state = useScreenState();
  const file = fileById(fileId);
  const access = file ? viewer.fileAccess(fileId) : null;
  const project = file ? projectById(file.projectId) : undefined;
  const inTrack = file ? variationOf(file.id) : null;
  const review = reviewId ? reviewById(reviewId) : (access?.review ?? undefined);
  const [selected, setSelected] = useState<string | null>(commentId ?? null);
  const [posted, setPosted] = useState<Comment[]>([]);
  const [view, setView] = useView();
  const [layout, setLayout] = useLayout();
  const [compareOpen, setCompareOpen] = useState(false);
  const [compareSource, setCompareSource] = useState("this");
  const [page, setPage] = useState(1);
  const [scorePage, setScorePage] = useState(1);
  const [sheet, setSheet] = useState<
    "details" | "download" | "export" | "import" | "variation" | null
  >(null);
  const [drawing, setDrawing] = useState<DrawTool | null>(null);
  const [colour, setColour] = useState("var(--hk-signal)");
  const [matte, setMatte] = useState<"none" | "2.39" | "1.85">("none");
  const [safe, setSafe] = useState(false);
  // A caption track shown over the picture (or under the waveform), and the panel beside it.
  const [captionId, setCaptionId] = useState<string | null>(null);
  const [panel, setPanel] = useState<SidePanel>("comments");
  const [transcriptId, setTranscriptId] = useState<string | null>(null);
  const [cuts, setCuts] = useState<"wipe" | "side" | null>(null);
  const duration = file?.media.duration ?? 1;
  const playback = usePlayback(duration, 14.3);
  const tab = viewParam === "qa" ? "qa" : viewParam === "triage" ? "triage" : "review";
  const stage = useRef<HTMLDivElement>(null);
  // How far the waveform is zoomed (#34); the playhead is kept in view, a page at a time.
  const [zoom, setZoom] = useState(1);
  const zoomBox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = zoomBox.current;
    if (!box || zoom <= 1) return;
    const at = (playback.time / duration) * box.scrollWidth;
    if (at < box.scrollLeft || at >= box.scrollLeft + box.clientWidth)
      box.scrollLeft = Math.max(0, at - box.clientWidth * 0.1);
  }, [zoom, playback.time, duration]);
  const [stageHeight, setStageHeight] = useState(360);
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setStageHeight(Math.floor(e.contentRect.height));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const isVideo = file?.kind === "video";
  const isAudio = file?.kind === "audio";
  const isPages = file?.kind === "document" || file?.kind === "image";
  // Caption tracks (#201): a video's or a recording's, in the Captions menu and the transcript.
  const captionTracks = file && (isVideo || isAudio) ? captionTracksFor(file.id) : [];
  const caption = captionTracks.find((t) => t.id === captionId) ?? null;
  const tools = access?.tools ?? new Set();
  const qaAllowed = (isAudio || isVideo) && (tools.has("qa") || tools.has("meters"));
  const all = useMemo(
    () => [...allComments.filter((c) => c.fileId === fileId), ...posted],
    [fileId, posted],
  );
  const visible = access ? visibleComments(all, access, viewer.personId) : [];
  const openThreads = orderThreads(
    visible.filter((c) => !c.parentId && !c.resolved && !c.deferredToStage),
  );
  const markers = openThreads
    .map((c, i): Marker | null => {
      const at =
        c.anchor.kind === "time"
          ? c.anchor.start
          : c.anchor.kind === "region" && c.anchor.at !== undefined
            ? c.anchor.at
            : null;
      return at === null
        ? null
        : {
            id: c.id,
            at,
            end: c.anchor.kind === "time" ? c.anchor.end : undefined,
            number: i + 1,
            active: selected === c.id,
            state: c.assigneeId || c.todo ? "todo" : c.deferredToStage ? "deferred" : "open",
          };
    })
    .filter((m): m is Marker => m !== null);
  /** Where Shift+up and down jump: the comment markers, and QA's findings where QA shows. */
  const marks = [
    ...markers.map((m) => m.at),
    ...(tools.has("qa")
      ? findingsFor(fileId).flatMap((f) => (f.start === undefined ? [] : [f.start]))
      : []),
  ];
  const regionMarkers = markersFrom(visible, openThreads).map((m) => ({
    ...m,
    active: selected === m.id,
  }));
  const score = inTrack?.track.scoreFileId ? fileById(inTrack.track.scoreFileId) : undefined;
  const scoreThreads = score
    ? orderThreads(allComments.filter((c) => c.fileId === score.id && !c.parentId && !c.resolved))
    : [];
  const scoreMarkers = score
    ? markersFrom(
        allComments.filter((c) => c.fileId === score.id),
        scoreThreads,
      )
    : [];
  const summary = file ? qaSummary(file.id) : null;
  const guestWatermark = viewer.isGuest
    ? `${personById(viewer.personId).name} · Endless Hall Records · 14 Oct 2026`
    : undefined;
  const base = viewer.isGuest ? "/g/files/$fileId" : "/files/$fileId";
  /** A loose file's simple version chain (#149), oldest first; empty for a file in none. */
  const chain = file && !inTrack ? chainOf(file) : [];
  const latestInChain = !chain.length || chain[chain.length - 1]?.id === file?.id;
  const _trackName = inTrack?.track.name;

  usePageHeader({
    crumbs: viewer.isGuest
      ? [
          { label: "Your reviews", to: "/g" },
          ...(review ? [{ label: review.title, to: `/g/reviews/${review.id}` }] : []),
        ]
      : project && viewer.canSee(project.id)
        ? [
            { label: project.name, to: `/projects/${project.id}` },
            ...(inTrack
              ? [{ label: inTrack.track.name, to: `/tracks/${inTrack.track.id}?view=versions` }]
              : []),
          ]
        : review
          ? [{ label: review.title, to: `/reviews/${review.id}` }]
          : [],
    title:
      file && access
        ? inTrack
          ? `V${inTrack.version.number} · ${inTrack.variationName}`
          : file.name
        : "Not found",
    heading: inTrack ? "page" : "bar",
    actions:
      file && access ? (
        <>
          {qaAllowed && (
            <Seg
              size="md"
              label="View"
              value={tab === "qa" ? "qa" : "review"}
              onChange={(v) =>
                navigate({
                  to: base,
                  params: { fileId },
                  search: (s) => ({ ...s, view: v === "qa" ? "qa" : undefined }),
                })
              }
              options={[
                { id: "review", label: "Review" },
                {
                  id: "qa",
                  label: "QA",
                  hint: summary && summary.issues > 0 ? String(summary.issues) : undefined,
                },
              ]}
            />
          )}
          {/* The comments shown or put away, from one place whatever their state. */}
          <Button
            variant="ghost"
            size="md"
            aria-label={`Comments, ${openThreads.length} open`}
            aria-pressed={layout.comments !== "hidden"}
            title={layout.comments === "hidden" ? "Show comments" : "Hide comments"}
            className={cn(layout.comments !== "hidden" && "bg-raised text-ink")}
            onClick={() =>
              setLayout({ comments: layout.comments === "hidden" ? "right" : "hidden" })
            }
          >
            <Icon name="comment" size={14} />
            {openThreads.length}
          </Button>
          {/* Listening together (#200): members, on a recording or a video. */}
          {!viewer.isGuest && (isAudio || isVideo) && <ListenTogether fileId={fileId} />}
          {access.download !== "none" && (
            <Button
              variant="ghost"
              size="md"
              title={`Download the ${access.download}, watermarked for you and logged`}
            >
              <Icon name="download" size={14} />
              <span className="hidden @5xl/app:inline">Download</span>
            </Button>
          )}
          {!viewer.isGuest && (
            <ActionMenu
              always
              label="file"
              actions={[
                { label: "Copy link", onSelect: () => {} },
                // A loose file takes a new version in its place (#149); a track's are its own.
                ...(project && !inTrack && latestInChain && viewer.can(project.id, "upload")
                  ? [{ label: "New version…", onSelect: () => {} }]
                  : []),
                ...(access.triage
                  ? [
                      { label: "Export comments…", onSelect: () => setSheet("export") },
                      { label: "Import a marker list…", onSelect: () => setSheet("import") },
                      {
                        label: "Triage comments",
                        onSelect: () =>
                          navigate({
                            to: "/files/$fileId",
                            params: { fileId },
                            search: { view: "triage" },
                          }),
                      },
                    ]
                  : []),
                { label: "Details", onSelect: () => setSheet("details") },
                ...(project && viewer.can(project.id, "organise")
                  ? [
                      "divider" as const,
                      { label: "Rename", onSelect: () => {} },
                      { label: "Move to…", onSelect: () => {} },
                    ]
                  : []),
                ...(project && viewer.can(project.id, "delete")
                  ? ["divider" as const, { label: "Delete…", danger: true, onSelect: () => {} }]
                  : []),
              ]}
            />
          )}
        </>
      ) : undefined,
    revision: tab,
  });

  if (!file || !access || !project) return <Refused />;
  if (state === "expired" && viewer.isGuest)
    return (
      <Refused
        title="Your access has ended"
        text="The window for this review closed on 31 October 2026. Ask the workspace to open it again."
      />
    );
  if (tab === "triage") return <TriagePage file={file} />;

  const pending = file.state === "pending" || state === "processing";
  const failed = file.state === "failed" || state === "failed";
  const previousVersion = inTrack
    ? inTrack.track.versions.find((v) => v.number === inTrack.version.number - 1)
    : undefined;
  const previousFile = previousVersion
    ? fileById(
        (
          previousVersion.variations.find((v) => v.name === inTrack?.variationName) ??
          previousVersion.variations.find((v) => v.primary)
        )?.fileId ?? "",
      )
    : undefined;
  const sources: Source[] = inTrack
    ? [
        {
          id: "this",
          label: `V${inTrack.version.number} · ${inTrack.variationName}`,
          aligned: true,
          gain: "0.0 dB",
        },
        ...inTrack.version.variations
          .filter((v) => v.fileId !== file.id)
          .map((v) => ({
            id: v.fileId,
            label: `V${inTrack.version.number} · ${v.name}`,
            aligned: false,
            gain: v.name === "Wet" ? "+0.4 dB" : "−1.1 dB",
          })),
        ...(previousFile && access.history
          ? [
              {
                id: previousFile.id,
                label: `V${previousVersion?.number} · ${previousVersion?.variations[0]?.name}`,
                aligned: true,
                gain: "−0.6 dB",
              },
            ]
          : []),
      ]
    : [];
  const channels = file.media.channels ?? 2;
  const hearing =
    // A downmix or a soloed channel is said on the Channels button itself.
    channels > 2
      ? `${file.media.layout?.split(" ")[0]} lossless`
      : view.normalised
        ? "normalised to −16 LUFS"
        : undefined;
  const referenceNow =
    inTrack && project.references.bar
      ? formatReference(
          { bar: Math.max(1, Math.floor(playback.time / 1.2) + 1) },
          project.references,
        )
      : undefined;
  const note = inTrack?.version.note;
  const latestNumber = inTrack ? Math.max(...inTrack.track.versions.map((x) => x.number)) : 0;
  const decisionStrip =
    review && viewer.reviewerIn(review) ? <DecisionStrip reviewId={review.id} /> : null;
  const hasTakes =
    isAudio &&
    inTrack !== null &&
    tools.has("takes") &&
    allTakes.some((t) => t.trackId === inTrack.track.id && t.coverage);
  // The version's edit decision list, as a lane under its waveform: the take of each stretch.
  const edits: EditStretch[] =
    isAudio && inTrack && tools.has("takes")
      ? allTakes
          .filter((t) => t.trackId === inTrack.track.id)
          .flatMap((t) =>
            (t.usedIn ?? [])
              .filter((u) => u.versionNumber === inTrack.version.number)
              .map((u) => ({
                start: (u.barFrom - 1) * 1.2,
                end: Math.min(duration, u.barTo * 1.2),
                label: `T${t.number}`,
                bars: `bars ${u.barFrom} to ${u.barTo}`,
                take: true,
              })),
          )
          .filter((e) => e.start < duration)
          .sort((a, b) => a.start - b.start)
      : [];

  const versionMenu = inTrack && (access.history || inTrack.track.versions.length === 1) && (
    <Dropdown
      value={
        <span className="flex items-center gap-1.5 font-medium text-ink">
          V{inTrack.version.number}
          {inTrack.version.number === latestNumber && (
            <span className="font-normal text-ink-3">latest</span>
          )}
        </span>
      }
      actions={[
        ...[...inTrack.track.versions]
          .sort((a, b) => b.number - a.number)
          .map((v) => {
            const target =
              v.variations.find((x) => x.name === inTrack.variationName) ??
              v.variations.find((x) => x.primary) ??
              v.variations[0];
            return {
              label: `V${v.number}`,
              hint:
                v.state === "pending"
                  ? "analysing"
                  : v.state === "failed"
                    ? "failed"
                    : v.number === latestNumber
                      ? "latest"
                      : v.status,
              checked: v.number === inTrack.version.number,
              onSelect: () =>
                target &&
                navigate({ to: base, params: { fileId: target.fileId }, search: (s) => s }),
            };
          }),
        ...(viewer.isGuest
          ? []
          : [
              "divider" as const,
              {
                label: "All versions and notes",
                onSelect: () =>
                  navigate({
                    to: "/tracks/$trackId",
                    params: { trackId: inTrack.track.id },
                    search: { view: "versions" },
                  }),
              },
              ...(hasTakes
                ? [
                    {
                      label: "Takes",
                      onSelect: () =>
                        navigate({
                          to: "/tracks/$trackId",
                          params: { trackId: inTrack.track.id },
                          search: { view: "takes" },
                        }),
                    },
                  ]
                : []),
            ]),
      ]}
    />
  );
  // Whoever may upload adds a variation from the switch itself (#486), so it shows to them
  // even where the version has one variation.
  const canAddVariation = Boolean(
    inTrack && project && !viewer.isGuest && viewer.can(project.id, "upload"),
  );
  const variationSeg = inTrack && (inTrack.version.variations.length > 1 || canAddVariation) && (
    <Seg
      size="md"
      label="Variation"
      value={file.id}
      onChange={(id) => navigate({ to: base, params: { fileId: id }, search: (s) => s })}
      options={inTrack.version.variations.map((v) => ({
        id: v.fileId,
        label: v.name,
        hint: fileById(v.fileId)?.state === "pending" ? "analysing" : undefined,
      }))}
      action={
        canAddVariation
          ? {
              label: "Add a variation…",
              icon: <Icon name="plus" size={14} />,
              onSelect: () => setSheet("variation"),
            }
          : undefined
      }
    />
  );

  // The versions of a loose file, as a track's are chosen (#149).
  const chainMenu = chain.length > 0 && (
    <div className="flex shrink-0 items-center gap-2">
      <Dropdown
        value={
          <span className="flex items-center gap-1.5 font-medium text-ink">
            V{chain.findIndex((f) => f.id === file.id) + 1}
            {latestInChain && <span className="font-normal text-ink-3">latest</span>}
          </span>
        }
        actions={chain
          .map((f, i) => ({
            label: `V${i + 1}`,
            hint: i === chain.length - 1 ? "latest" : f.name,
            checked: f.id === file.id,
            onSelect: () => navigate({ to: base, params: { fileId: f.id }, search: (s) => s }),
          }))
          .reverse()}
      />
    </div>
  );

  const strip = (isAudio || isVideo) && (
    <>
      <ListeningNotice fileId={fileId} />
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-3 py-2 @3xl/app:px-4">
        {versionMenu}
        {variationSeg}
        {!access.history && inTrack && (
          <span className="text-[13px] text-ink-3">V{inTrack.version.number} is under review</span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {score && isAudio && tools.has("score") && (
            <button
              type="button"
              aria-pressed={layout.score}
              onClick={() => setLayout({ score: !layout.score })}
              className={cn(
                "flex h-8 items-center gap-1.5 rounded-control px-2.5 text-[13px] transition-colors",
                layout.score
                  ? "bg-raised text-ink shadow-1"
                  : "text-ink-2 hover:bg-raised hover:text-ink",
              )}
            >
              <Icon name="score" size={14} />
              Score
            </button>
          )}
          {isVideo && !pending && !failed && (
            <>
              <button
                type="button"
                aria-pressed={drawing !== null}
                onClick={() => setDrawing(drawing ? null : "arrow")}
                className={cn(
                  "flex h-8 items-center gap-1.5 rounded-control px-2.5 text-[13px] transition-colors",
                  drawing
                    ? "bg-raised text-ink shadow-1"
                    : "text-ink-2 hover:bg-raised hover:text-ink",
                )}
              >
                <Icon name="edit" size={14} />
                Draw
              </button>
              <Dropdown
                value={
                  <span className="flex items-center gap-1.5">
                    <Icon name="grid" size={14} />
                    Frame
                  </span>
                }
                align="right"
                actions={[
                  { label: "Safe areas", checked: safe, onSelect: () => setSafe((v) => !v) },
                  {
                    label: "Matte 2.39:1",
                    checked: matte === "2.39",
                    onSelect: () => setMatte(matte === "2.39" ? "none" : "2.39"),
                  },
                  {
                    label: "Matte 1.85:1",
                    checked: matte === "1.85",
                    onSelect: () => setMatte(matte === "1.85" ? "none" : "1.85"),
                  },
                  "divider",
                  {
                    label: "Compare cuts: wipe",
                    checked: cuts === "wipe",
                    onSelect: () => setCuts("wipe"),
                  },
                  {
                    label: "Compare cuts: side by side",
                    checked: cuts === "side",
                    onSelect: () => setCuts("side"),
                  },
                ]}
              />
              {captionTracks.length > 0 && (
                <CaptionsMenu tracks={captionTracks} current={captionId} onChange={setCaptionId} />
              )}
              <GoTo onGo={(t) => playback.seek(t)} />
              <AudioLayoutMenu layout={file.media.layout ?? "stereo"} />
            </>
          )}
          {isAudio && !pending && !failed && captionTracks.length > 0 && (
            <CaptionsMenu tracks={captionTracks} current={captionId} onChange={setCaptionId} />
          )}
          {isAudio && !pending && !failed && channels >= 2 && (
            <AudioLayoutMenu layout={file.media.layout ?? "stereo"} />
          )}
          {isAudio && !pending && !failed && (
            <ViewMenu
              view={view}
              onView={setView}
              spectrogramAllowed={tools.has("spectrogram")}
              normaliseAllowed={tools.has("normalise") && project.normalisation === "optional"}
            />
          )}
        </div>
      </div>
    </>
  );

  const waveHeight = Math.max(
    160,
    Math.min(stageHeight - 36, view.split ? 64 * channels + 40 : 520),
  );
  const spectroHeight = Math.max(100, Math.round(waveHeight * 0.45));

  const stageInner = pending ? (
    <div className="flex flex-col items-center gap-2 px-4 py-14 text-center">
      <Dot state="working" className="size-[10px]" />
      <p className="text-[14px] text-ink">Preparing this {isVideo ? "cut" : "recording"}</p>
      <p className="max-w-sm text-[13px] text-ink-3">
        Measuring, drawing the waveform and packaging the protected stream. Comments on the whole
        file can be written now; the player follows in a minute or two.
      </p>
    </div>
  ) : failed ? (
    <div className="flex flex-col items-center gap-2 px-4 py-14 text-center">
      <Icon name="warning" className="text-signal" />
      <p className="text-[14px] text-ink">This file could not be prepared for playback</p>
      <p className="max-w-sm text-[13px] text-ink-3">
        The container says 96 kHz but holds 44.1 kHz frames.{" "}
        {viewer.can(project.id, "upload")
          ? "Re-export it and replace the file from the track."
          : "Whoever uploaded it has been told."}
      </p>
      {viewer.can(project.id, "upload") && (
        <Button variant="secondary" size="sm">
          Replace file
        </Button>
      )}
    </div>
  ) : isVideo ? (
    <div className="flex min-h-0 flex-1 flex-col justify-center px-3 pb-1 @3xl/app:px-4">
      {cuts && previousFile ? (
        <CompareCuts
          a={previousFile}
          b={file}
          labels={[
            `Cut ${(inTrack?.version.number ?? 2) - 1}`,
            `Cut ${inTrack?.version.number ?? 2}`,
          ]}
          compare={
            inTrack
              ? {
                  trackId: inTrack.track.id,
                  a: inTrack.version.number - 1,
                  b: inTrack.version.number,
                }
              : undefined
          }
          time={playback.time}
          mode={cuts}
          onMode={setCuts}
          onClose={() => setCuts(null)}
        />
      ) : (
        <div
          className="relative mx-auto w-full shrink-0"
          style={{
            maxWidth: Math.max(
              240,
              (stageHeight - 110) *
                (file.media.height && file.media.width && file.media.height > file.media.width
                  ? 9 / 16
                  : 16 / 9),
            ),
          }}
        >
          <Frame
            file={file}
            time={playback.time}
            watermark={
              guestWatermark ??
              (project.id === "proj-titles"
                ? `${personById(viewer.personId).name} · 14 Oct 2026`
                : undefined)
            }
            className="rounded-panel shadow-3"
            portrait={
              file.media.height !== undefined &&
              file.media.width !== undefined &&
              file.media.height > file.media.width
            }
          />
          <SafeAreas matte={matte} safe={safe} />
          {caption && <CaptionLine cues={caption.cues} time={playback.time} over />}
          {drawing && (
            <>
              <svg
                className="pointer-events-none absolute inset-0 h-full w-full"
                aria-hidden="true"
              >
                <ellipse
                  cx="62%"
                  cy="30%"
                  rx="9%"
                  ry="14%"
                  fill="none"
                  stroke={colour}
                  strokeWidth={2}
                />
                <line x1="72%" y1="22%" x2="86%" y2="14%" stroke={colour} strokeWidth={2} />
              </svg>
              <DrawToolbar
                tool={drawing}
                onTool={setDrawing}
                colour={colour}
                onColour={setColour}
                onClose={() => setDrawing(null)}
              />
            </>
          )}
        </div>
      )}
      <Filmstrip file={file} playback={playback} markers={openThreads} />
      <Ruler duration={duration} video className="mt-1" />
    </div>
  ) : (
    <div className="flex flex-col px-3 pb-1 @3xl/app:px-4">
      {/* Zoomed in, it scrolls, a page at a time with the playhead; the ruler widens with it. */}
      <div ref={zoomBox} className={cn(zoom > 1 && "overflow-x-auto overscroll-x-contain")}>
        <div className="flex flex-col" style={{ width: `${zoom * 100}%` }}>
          {view.spectrogram !== "instead" && (
            <Waveform
              seed={file.seed}
              duration={duration}
              channels={channels}
              layout={file.media.layout}
              playback={playback}
              split={view.split}
              markers={markers}
              colour={view.wave.colour}
              opacity={view.wave.opacity}
              amplitude={view.wave.height}
              findings={tools.has("qa") ? findingsFor(file.id) : undefined}
              onMarker={(id) => setSelected(id)}
              height={view.spectrogram === "below" ? waveHeight - spectroHeight - 8 : waveHeight}
              overlay={
                view.spectrogram === "behind" ? (
                  <Spectrogram
                    seed={file.seed}
                    width={1200}
                    height={waveHeight}
                    colourMap={view.colourMap}
                    scale={view.scale}
                    className="absolute inset-0 h-full w-full opacity-60"
                  />
                ) : undefined
              }
            />
          )}
          {(view.spectrogram === "below" || view.spectrogram === "instead") && (
            <div
              className={cn(
                "relative overflow-hidden rounded-control",
                view.spectrogram === "below" && "mt-2",
              )}
              style={{ height: view.spectrogram === "instead" ? waveHeight : spectroHeight }}
            >
              <Spectrogram
                seed={file.seed}
                width={1200}
                height={view.spectrogram === "instead" ? waveHeight : spectroHeight}
                colourMap={view.colourMap}
                scale={view.scale}
                className="absolute inset-0 h-full w-full"
              />
              <FrequencyScale
                height={view.spectrogram === "instead" ? waveHeight : spectroHeight}
                scale={view.scale}
              />
              <div
                className="pointer-events-none absolute top-0 bottom-0 w-px bg-signal"
                style={{ left: `${(playback.time / duration) * 100}%` }}
              />
            </div>
          )}
          {edits.length > 0 && (
            <EditLane edits={edits} duration={duration} playback={playback} className="mt-1.5" />
          )}
          <Ruler duration={duration} className="mt-1" />
        </div>
      </div>
      {caption && <CaptionLine cues={caption.cues} time={playback.time} over={false} />}
    </div>
  );

  const player = (isAudio || isVideo) && (
    <section aria-label="Player" className="flex min-h-0 flex-1 flex-col">
      <div ref={stage} className="flex min-h-[240px] flex-1 flex-col justify-center">
        {stageInner}
      </div>
      {!pending && !failed && (
        <div className="shrink-0 border-t border-line">
          <Transport
            playback={playback}
            duration={duration}
            video={isVideo}
            fps={file.media.fps}
            reference={isAudio ? referenceNow : undefined}
            loopsAllowed={tools.has("loops")}
            compareAllowed={tools.has("compare") && sources.length > 1}
            compareOpen={compareOpen}
            onCompare={() => setCompareOpen((o) => !o)}
            hearing={hearing}
            zoom={isAudio ? zoom : undefined}
            onZoom={isAudio ? setZoom : undefined}
            marks={marks}
          />
          <LoopBar playback={playback} />
          {compareOpen && (
            <CompareBar
              sources={sources}
              current={compareSource}
              onCurrent={setCompareSource}
              onClose={() => setCompareOpen(false)}
            />
          )}
        </div>
      )}
    </section>
  );

  const scorePane = score && isAudio && tools.has("score") && layout.score && (
    <section
      aria-label="Score"
      className="flex min-h-0 shrink-0 flex-col border-t border-line"
      style={{ height: layout.scoreHeight }}
    >
      <div className="flex h-9 shrink-0 items-center gap-2 px-4 text-[13px]">
        <span className="font-medium text-ink">Score</span>
        <span className="truncate text-ink-3">{score.name}</span>
        {!viewer.isGuest && (
          <Link
            to="/files/$fileId"
            params={{ fileId: score.id }}
            className="ml-auto text-ink-3 hover:text-ink"
          >
            {scoreThreads.length} comments on the score
          </Link>
        )}
        <button
          type="button"
          aria-label="Hide the score"
          onClick={() => setLayout({ score: false })}
          className="flex size-7 items-center justify-center rounded-control text-ink-3 hover:bg-raised hover:text-ink"
        >
          <Icon name="close" size={13} />
        </button>
      </div>
      <div className="min-h-0 flex-1 px-4 pb-3">
        <PageViewer
          file={score}
          page={scorePage}
          onPage={setScorePage}
          markers={scoreMarkers}
          selected={null}
          onSelect={() => navigate({ to: "/files/$fileId", params: { fileId: score.id } })}
          canDraw={false}
          watermark={guestWatermark}
          compact
        />
      </div>
    </section>
  );

  const commentsColumn = (
    <CommentsColumn
      file={file}
      all={all}
      access={access}
      playback={isAudio || isVideo ? playback : null}
      project={project}
      trackId={inTrack?.track.id ?? null}
      versionNumber={inTrack?.version.number ?? null}
      selected={selected}
      onSelect={setSelected}
      personId={viewer.personId}
      isGuest={viewer.isGuest}
      video={isVideo}
      fps={file.media.fps}
      page={page}
      kind={isPages ? "document" : "media"}
      banner={decisionStrip}
      tools={<PanelPlacement layout={layout} set={setLayout} />}
      heading={
        captionTracks.length > 0
          ? (open) => <PanelTabs panel="comments" onPanel={setPanel} count={open} />
          : undefined
      }
      className="@3xl/app:h-full"
      onPost={(body) =>
        setPosted((p) => [
          ...p,
          {
            id: `new-${p.length}`,
            fileId: file.id,
            authorId: viewer.personId,
            body,
            createdAt: "2026-10-14T21:00:00Z",
            anchor:
              isAudio || isVideo
                ? { kind: "time", start: playback.time }
                : { kind: "region", page, x: 0.1, y: 0.1, width: 0.3, height: 0.1 },
          },
        ])
      }
    />
  );

  // The transcript in the comments' place (#201): the track shown in the player, unless
  // another is chosen here.
  const transcriptColumn = captionTracks.length > 0 && (
    <TranscriptColumn
      tracks={captionTracks}
      trackId={transcriptId ?? captionId}
      onTrack={setTranscriptId}
      playback={playback}
      heading={<PanelTabs panel="transcript" onPanel={setPanel} count={openThreads.length} />}
      tools={<PanelPlacement layout={layout} set={setLayout} />}
      video={isVideo}
      fps={file.media.fps}
      canExport={access.download !== "none"}
      className="@3xl/app:h-full"
    />
  );

  const main: ReactNode = isPages ? (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3 @3xl/app:p-4">
      {chainMenu}
      <PageViewer
        file={file}
        page={page}
        onPage={setPage}
        markers={regionMarkers}
        selected={selected}
        onSelect={setSelected}
        canDraw={access.comment}
        watermark={guestWatermark}
      />
      <p className="text-[12px] text-ink-3">
        {file.kind === "image"
          ? "Drawn by the server and served as a page; the original never reaches a browser."
          : `${file.media.pages} pages drawn from the PDF; the original never reaches a browser.`}
        {viewer.isGuest && " Each page is watermarked for you."}
      </p>
    </div>
  ) : file.kind === "other" ? (
    <div className="relative flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
      {chainMenu && <div className="absolute top-3 left-3 @3xl/app:left-4">{chainMenu}</div>}
      <Icon name="file" size={28} className="text-ink-3" />
      <p className="text-[14px] text-ink">Nothing to show for an archive</p>
      <p className="text-[13px] text-ink-3">
        Comments here are about the whole file.{" "}
        {access.download !== "none" ? "You may download it." : ""}
      </p>
    </div>
  ) : (
    <div className="flex min-h-0 flex-1 flex-col">
      {strip}
      <div className="flex min-h-0 flex-1 flex-col">{player}</div>
      {note && inTrack && (
        <div className="flex shrink-0 items-start gap-2.5 border-t border-line px-4 py-2.5">
          <Avatar personId={inTrack.version.uploadedBy} size={22} />
          <p className="min-w-0 text-[13px] text-ink-2">
            <span className="font-medium text-ink">
              {personById(inTrack.version.uploadedBy).name}
            </span>
            <span className="text-ink-3">
              {" "}
              · V{inTrack.version.number}, {formatDateTime(inTrack.version.uploadedAt)}
            </span>
            <span className="block">{note}</span>
          </p>
        </div>
      )}
      {scorePane}
    </div>
  );

  if (tab === "qa" && isVideo)
    return (
      <div className="fade-in flex min-h-full flex-col @3xl/app:h-full @3xl/app:min-h-0">
        <div className="flex shrink-0 flex-col border-b border-line">
          {strip}
          <div className="flex items-stretch gap-4 px-4 pb-2">
            <Frame
              file={file}
              time={playback.time}
              className="w-[300px] shrink-0 rounded-panel shadow-3"
            />
            <div className="flex min-w-0 flex-1 flex-col justify-end">
              <Filmstrip file={file} playback={playback} markers={openThreads} />
              <Ruler duration={duration} video className="mt-1" />
            </div>
          </div>
          <div className="border-t border-line">
            <Transport
              playback={playback}
              duration={duration}
              video
              fps={file.media.fps}
              loopsAllowed={tools.has("loops")}
              compareAllowed={false}
              compareOpen={false}
              onCompare={() => {}}
              marks={marks}
            />
            <LoopBar playback={playback} />
          </div>
        </div>
        <div className="scroll-quiet min-h-0 flex-1 overflow-auto p-4 @3xl/app:p-6">
          <VideoQaView
            file={file}
            playback={playback}
            previous={previousFile}
            canChooseProfile={viewer.can(project.id, "edit_workflows")}
            canComment={access.comment}
            onComment={() =>
              navigate({ to: base, params: { fileId }, search: (s) => ({ ...s, view: undefined }) })
            }
          />
        </div>
      </div>
    );
  if (tab === "qa")
    return (
      <div className="fade-in flex min-h-full flex-col @3xl/app:h-full @3xl/app:min-h-0">
        <div className="flex shrink-0 flex-col border-b border-line">
          {strip}
          {player}
        </div>
        <div className="scroll-quiet min-h-0 flex-1 overflow-auto p-4 @3xl/app:p-6">
          <QaView
            file={file}
            playback={playback}
            previous={previousFile}
            canChooseProfile={viewer.can(project.id, "edit_workflows")}
            canEditMetadata={viewer.can(project.id, "organise") && tools.has("qa")}
            canComment={access.comment}
            onComment={() =>
              navigate({ to: base, params: { fileId }, search: (s) => ({ ...s, view: undefined }) })
            }
            meters={tools.has("meters")}
          />
        </div>
      </div>
    );

  const dialogs = (
    <>
      {sheet === "details" && <FileDetailsSheet file={file} onClose={() => setSheet(null)} />}
      {sheet === "download" && access.download !== "none" && (
        <DownloadDialog file={file} allowed={access.download} onClose={() => setSheet(null)} />
      )}
      {sheet === "export" && (
        <ExportCommentsDialog file={file} comments={all} onClose={() => setSheet(null)} />
      )}
      {sheet === "import" && <ImportCommentsDialog onClose={() => setSheet(null)} />}
      {sheet === "variation" && inTrack && (
        <AddVariationDialog
          track={inTrack.track}
          version={inTrack.version}
          onClose={() => setSheet(null)}
        />
      )}
    </>
  );
  const below = layout.comments === "below";
  return (
    <div
      className={cn(
        "fade-in flex min-h-full flex-col @3xl/app:h-full @3xl/app:min-h-0 @3xl/app:flex-row",
        below && "@3xl/app:flex-col",
      )}
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{main}</div>
      {layout.comments !== "hidden" && (
        <>
          <div className="h-px shrink-0 bg-line @3xl/app:hidden" />
          {below ? (
            <Splitter
              axis="y"
              onDrag={(_d) => setLayout({ scoreHeight: layout.scoreHeight })}
              className="hidden @3xl/app:block"
            />
          ) : (
            <Splitter
              axis="x"
              onDrag={(d) => setLayout({ width: Math.min(640, Math.max(300, layout.width - d)) })}
              className="hidden @3xl/app:block"
            />
          )}
          <div
            className={cn(
              "flex shrink-0 flex-col border-line @3xl/app:min-h-0 @3xl/app:border-l",
              below
                ? "@3xl/app:h-[320px] @3xl/app:border-t @3xl/app:border-l-0"
                : "@3xl/app:w-[var(--w)]",
            )}
            style={{ ["--w" as string]: `${layout.width}px` }}
          >
            {panel === "transcript" && transcriptColumn ? transcriptColumn : commentsColumn}
          </div>
        </>
      )}
      {dialogs}
    </div>
  );
}
