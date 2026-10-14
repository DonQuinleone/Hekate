import { Link, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Avatar } from "~/components/avatar";
import { CommentsColumn, orderThreads } from "~/components/comments/column";
import { Icon } from "~/components/icons";
import { Label } from "~/components/label";
import { usePageHeader } from "~/components/page-header";
import { markersFrom, PageViewer } from "~/components/pages";
import { CompareBar, type Source } from "~/components/player/compare";
import { usePlayback } from "~/components/player/playback";
import { FrequencyScale, Spectrogram } from "~/components/player/spectrogram";
import {
  defaultView,
  LoopBar,
  Transport,
  type View,
  ViewMenu,
} from "~/components/player/transport";
import { type Marker, Ruler, Waveform } from "~/components/player/waveform";
import { QaView } from "~/components/qa";
import { Button } from "~/components/ui/button";
import { ActionMenu } from "~/components/ui/menu";
import { Filmstrip, Frame } from "~/components/video";
import {
  comments as allComments,
  type Comment,
  fileById,
  findingsFor,
  personById,
  projectById,
  reviewById,
  variationOf,
} from "~/data";
import { cn } from "~/lib/cn";
import { fileDetails, qaSummary } from "~/lib/files";
import { formatDateTime, formatReference } from "~/lib/format";
import { useViewer, visibleComments } from "~/viewer/context";
import { Refused, useScreenState } from "~/viewer/state-gate";
import { Soon } from "./_soon.tsx";

const VIEW_KEY = "hekate.prototype.view";

function useView(): [View, (v: View) => void] {
  const [view, setView] = useState<View>(() => {
    try {
      const raw = localStorage.getItem(VIEW_KEY);
      return raw ? { ...defaultView, ...(JSON.parse(raw) as Partial<View>) } : defaultView;
    } catch {
      return defaultView;
    }
  });
  return [
    view,
    (v) => {
      setView(v);
      try {
        localStorage.setItem(VIEW_KEY, JSON.stringify(v));
      } catch {
        // Not remembered.
      }
    },
  ];
}

function Chip<T extends string | number>({
  value,
  current,
  label,
  hint,
  onClick,
}: {
  value: T;
  current: T;
  label: string;
  hint?: string;
  onClick: () => void;
}) {
  const on = value === current;
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        "tabular flex h-7 items-center gap-1.5 rounded-[4px] px-2.5 text-xs",
        on ? "bg-overlay text-ink shadow-2" : "text-ink-2 hover:text-ink",
      )}
    >
      {label}
      {hint && <span className="text-ink-3">{hint}</span>}
    </button>
  );
}

export function FilePage({
  fileId,
  view: viewParam,
  commentId,
  reviewId,
  version: versionParam,
  variation: variationParam,
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
  const [viewOpen, setViewOpen] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  const [compareSource, setCompareSource] = useState("this");
  const [page, setPage] = useState(1);
  const [scorePage, setScorePage] = useState(1);
  const duration = file?.media.duration ?? 1;
  const playback = usePlayback(duration, 14.3);
  const tab = viewParam === "qa" ? "qa" : viewParam === "triage" ? "triage" : "review";
  void versionParam;
  void variationParam;

  const isVideo = file?.kind === "video";
  const isAudio = file?.kind === "audio";
  const isPages = file?.kind === "document" || file?.kind === "image";
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
          };
    })
    .filter((m): m is Marker => m !== null);
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

  const trackName = inTrack?.track.name;
  usePageHeader({
    crumbs: viewer.isGuest
      ? [
          { label: "Your reviews", to: "/g" },
          ...(review ? [{ label: review.title, to: `/g/reviews/${review.id}` }] : []),
        ]
      : [
          { label: "Projects", to: "/projects" },
          ...(project && viewer.canSee(project.id)
            ? [{ label: project.name, to: `/projects/${project.id}` }]
            : review
              ? [{ label: review.title, to: `/reviews/${review.id}` }]
              : []),
        ],
    title: file && access ? (trackName ?? file.name) : "Not found",
    meta:
      file && access
        ? inTrack
          ? `V${inTrack.version.number} · ${inTrack.variationName}`
          : fileDetails(file)
        : undefined,
    actions:
      file && access ? (
        <>
          {qaAllowed && (
            <div
              role="tablist"
              aria-label="View"
              className="flex rounded-control border border-hairline bg-surface p-0.5"
            >
              <button
                type="button"
                role="tab"
                aria-selected={tab === "review"}
                onClick={() =>
                  navigate({
                    to: viewer.isGuest ? "/g/files/$fileId" : "/files/$fileId",
                    params: { fileId },
                    search: (s) => ({ ...s, view: undefined }),
                  })
                }
                className={cn(
                  "h-7 rounded-[4px] px-3 text-[13px] font-medium",
                  tab === "review" ? "bg-overlay text-ink shadow-2" : "text-ink-2 hover:text-ink",
                )}
              >
                Review
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === "qa"}
                onClick={() =>
                  navigate({
                    to: viewer.isGuest ? "/g/files/$fileId" : "/files/$fileId",
                    params: { fileId },
                    search: (s) => ({ ...s, view: "qa" }),
                  })
                }
                className={cn(
                  "flex h-7 items-center gap-1.5 rounded-[4px] px-3 text-[13px] font-medium",
                  tab === "qa" ? "bg-overlay text-ink shadow-2" : "text-ink-2 hover:text-ink",
                )}
              >
                QA
                {summary && summary.issues > 0 && (
                  <span aria-hidden="true" className="size-1.5 rounded-full bg-signal" />
                )}
              </button>
            </div>
          )}
          {access.download !== "none" && (
            <Button
              variant="ghost"
              size="sm"
              title={`Download the ${access.download}, watermarked for you and logged`}
            >
              <Icon name="download" size={14} />
              <span className="hidden @3xl/app:inline">Download</span>
            </Button>
          )}
          {!viewer.isGuest && (
            <ActionMenu
              label="file"
              actions={[
                { label: "Copy link", onSelect: () => {} },
                ...(access.triage
                  ? [
                      { label: "Export comments…", onSelect: () => {} },
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
                { label: "Details", onSelect: () => {} },
                ...(project && viewer.can(project.id, "organise")
                  ? [
                      { label: "Rename", onSelect: () => {} },
                      { label: "Move to…", onSelect: () => {} },
                    ]
                  : []),
                ...(project && viewer.can(project.id, "delete")
                  ? [{ label: "Delete…", danger: true, onSelect: () => {} }]
                  : []),
              ]}
            />
          )}
        </>
      ) : undefined,
  });

  if (!file || !access || !project) return <Refused />;
  if (state === "expired" && viewer.isGuest)
    return (
      <Refused
        title="Your access has ended"
        text="The window for this review closed on 31 October 2026. Ask the organisation to open it again."
      />
    );
  if (tab === "triage") return <Soon title="Triage" round={2} />;

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
    channels > 2
      ? view.downmix
        ? "Hearing: stereo downmix"
        : `Hearing: ${file.media.layout?.split(" ")[0]} lossless`
      : view.normalised
        ? "Normalised to −16 LUFS"
        : undefined;
  const referenceNow =
    inTrack && project.references.bar
      ? formatReference(
          { bar: Math.max(1, Math.floor(playback.time / 1.2) + 1) },
          project.references,
        )
      : undefined;
  const waveHeight = view.split ? Math.min(360, 60 * channels + 40) : 200;
  const spectroHeight = 160;
  const note = inTrack?.version.note;
  const base = viewer.isGuest ? "/g/files/$fileId" : "/files/$fileId";

  const versionChips = inTrack && (access.history || inTrack.track.versions.length === 1) && (
    <div className="flex items-center gap-2">
      <Label>Version</Label>
      <div className="flex rounded-control border border-hairline bg-surface p-0.5">
        {[...inTrack.track.versions]
          .sort((a, b) => a.number - b.number)
          .map((v) => {
            const target =
              v.variations.find((x) => x.name === inTrack.variationName) ??
              v.variations.find((x) => x.primary) ??
              v.variations[0];
            const latest = v.number === Math.max(...inTrack.track.versions.map((x) => x.number));
            return (
              <Chip
                key={v.id}
                value={v.number}
                current={inTrack.version.number}
                label={`V${v.number}`}
                hint={
                  v.state === "pending"
                    ? "analysing"
                    : v.state === "failed"
                      ? "failed"
                      : latest
                        ? "latest"
                        : undefined
                }
                onClick={() =>
                  target &&
                  navigate({ to: base, params: { fileId: target.fileId }, search: (s) => s })
                }
              />
            );
          })}
      </div>
    </div>
  );
  const variationChips = inTrack && inTrack.version.variations.length > 1 && (
    <div className="flex items-center gap-2">
      <Label>Variation</Label>
      <div className="flex rounded-control border border-hairline bg-surface p-0.5">
        {inTrack.version.variations.map((v) => (
          <Chip
            key={v.id}
            value={v.fileId}
            current={file.id}
            label={v.name}
            hint={fileById(v.fileId)?.state === "pending" ? "analysing" : undefined}
            onClick={() => navigate({ to: base, params: { fileId: v.fileId }, search: (s) => s })}
          />
        ))}
      </div>
    </div>
  );

  const player = (isAudio || isVideo) && (
    <section
      aria-label="Player"
      className="rounded-panel-lg border border-hairline bg-surface shadow-1"
    >
      {pending ? (
        <div className="flex flex-col items-center gap-2 px-4 py-14 text-center">
          <span className="size-[10px] animate-pulse rounded-full border-[1.5px] border-ink-3" />
          <p className="m-0 text-[13px] text-ink">Preparing this {isVideo ? "cut" : "recording"}</p>
          <p className="m-0 max-w-sm text-xs text-ink-3">
            Measuring, drawing the waveform and packaging the protected stream. Comments on the
            whole file can be written now; the player follows in a minute or two.
          </p>
        </div>
      ) : failed ? (
        <div className="flex flex-col items-center gap-2 px-4 py-14 text-center">
          <Icon name="warning" className="text-signal" />
          <p className="m-0 text-[13px] text-ink">This file could not be prepared for playback</p>
          <p className="m-0 max-w-sm text-xs text-ink-3">
            The container says 96 kHz but holds 44.1 kHz frames.{" "}
            {project && viewer.can(project.id, "upload")
              ? "Re-export it and replace the file from the track."
              : "Whoever uploaded it has been told."}
          </p>
          {project && viewer.can(project.id, "upload") && (
            <Button variant="secondary" size="sm">
              Replace file
            </Button>
          )}
        </div>
      ) : isVideo ? (
        <div className="p-3">
          <Frame
            file={file}
            time={playback.time}
            watermark={
              guestWatermark ??
              (project.id === "proj-titles"
                ? `${personById(viewer.personId).name} · 14 Oct 2026`
                : undefined)
            }
            className="rounded-control"
            portrait={
              file.media.height !== undefined &&
              file.media.width !== undefined &&
              file.media.height > file.media.width
            }
          />
          {regionMarkers.length === 0 &&
            openThreads
              .filter((c) => c.anchor.kind === "region")
              .map((c) => {
                const a = c.anchor as Extract<Comment["anchor"], { kind: "region" }>;
                if (Math.abs((a.at ?? -99) - playback.time) > 0.5) return null;
                return <div key={c.id} className="pointer-events-none absolute" />;
              })}
          <Filmstrip file={file} playback={playback} markers={openThreads} />
          <Ruler duration={duration} video />
        </div>
      ) : (
        <div className="p-3">
          {view.spectrogram !== "instead" && (
            <Waveform
              seed={file.seed}
              duration={duration}
              channels={channels}
              layout={file.media.layout}
              playback={playback}
              split={view.split}
              markers={markers}
              findings={tools.has("qa") ? findingsFor(file.id) : undefined}
              onMarker={(id) => setSelected(id)}
              height={waveHeight}
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
                "relative overflow-hidden rounded-control border border-hairline-soft bg-sunken",
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
                className="pointer-events-none absolute top-0 bottom-0 w-[2px] bg-signal"
                style={{ left: `${(playback.time / duration) * 100}%` }}
              />
            </div>
          )}
          <Ruler duration={duration} />
        </div>
      )}
      {!pending && !failed && (
        <>
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
        </>
      )}
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

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-4 px-4 py-4 @3xl/app:px-6">
      {(isAudio || isVideo) && (
        <div className="flex flex-wrap items-center gap-4">
          {versionChips}
          {variationChips}
          {!access.history && inTrack && (
            <span className="text-xs text-ink-3">
              V{inTrack.version.number} is the version under review.
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            {summary &&
              (summary.loudness !== null || summary.issues > 0) &&
              qaAllowed &&
              tab === "review" && (
                <Link
                  to={base}
                  params={{ fileId }}
                  search={(s) => ({ ...s, view: "qa" })}
                  className="tabular flex h-7 items-center gap-2 rounded-full border border-hairline bg-surface px-2.5 text-xs text-ink-2 no-underline hover:border-edge hover:text-ink"
                >
                  {summary.issues > 0 ? (
                    <span className="size-[7px] rounded-full border-[1.5px] border-signal" />
                  ) : (
                    <span className="size-[5px] rounded-full bg-ink-3" />
                  )}
                  {summary.loudness !== null && `${summary.loudness.toFixed(1)} LUFS`}
                  {summary.issues > 0 &&
                    ` · ${summary.issues} ${summary.issues === 1 ? "issue" : "issues"}`}
                  {summary.issues === 0 && " · checks pass"}
                </Link>
              )}
            {isAudio && !pending && !failed && (
              <ViewMenu
                view={view}
                onView={setView}
                channels={channels}
                spectrogramAllowed={tools.has("spectrogram")}
                normaliseAllowed={tools.has("normalise") && project.normalisation === "optional"}
                open={viewOpen}
                onOpen={setViewOpen}
              />
            )}
          </div>
        </div>
      )}
      {tab === "qa" ? (
        <div className="flex flex-col gap-4">
          {player}
          <QaView
            file={file}
            playback={playback}
            previous={previousFile}
            canChooseProfile={viewer.can(project.id, "edit_workflows")}
            canComment={access.comment}
            onComment={() =>
              navigate({ to: base, params: { fileId }, search: (s) => ({ ...s, view: undefined }) })
            }
            meters={tools.has("meters")}
          />
        </div>
      ) : (
        <div className="grid items-start gap-4 @5xl/app:grid-cols-[minmax(0,1fr)_400px]">
          <div className="flex min-w-0 flex-col gap-4">
            {isPages ? (
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
            ) : (
              player
            )}
            {note && inTrack && (
              <section
                aria-label="About this version"
                className="flex items-start gap-3 rounded-panel-lg border border-hairline-soft px-4 py-3"
              >
                <Avatar personId={inTrack.version.uploadedBy} size={26} />
                <div className="min-w-0">
                  <div className="text-[13px]">
                    <span className="font-medium text-ink">
                      {personById(inTrack.version.uploadedBy).name}
                    </span>
                    <span className="text-ink-3">
                      {" "}
                      uploaded V{inTrack.version.number} ·{" "}
                      {formatDateTime(inTrack.version.uploadedAt)}
                    </span>
                  </div>
                  <p className="m-0 text-[13px] text-ink-2">{note}</p>
                </div>
              </section>
            )}
            {score && isAudio && tools.has("score") && (
              <section aria-label="Score" className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <h2 className="m-0 text-[15px] font-medium">Score</h2>
                  <span className="text-xs text-ink-3">
                    {score.name} · for reference; type the bars into your comments
                  </span>
                  {!viewer.isGuest && (
                    <Link
                      to="/files/$fileId"
                      params={{ fileId: score.id }}
                      className="ml-auto text-xs text-ink-3 no-underline hover:text-ink"
                    >
                      Comments on the score ({scoreThreads.length})
                    </Link>
                  )}
                </div>
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
              </section>
            )}
            {isPages && (
              <p className="m-0 text-xs text-ink-3">
                {file.kind === "image"
                  ? "Pictures are drawn once by the server and served as pages; the original never reaches a browser."
                  : `Pages the server drew from the PDF, ${file.media.pages} of them; the original never reaches a browser.`}
                {viewer.isGuest && " Each page is watermarked for you."}
              </p>
            )}
            {file.kind === "other" && (
              <section className="rounded-panel-lg border border-hairline bg-surface p-6 text-center shadow-1">
                <Icon name="file" size={28} className="mx-auto text-ink-3" />
                <p className="m-0 mt-2 text-[13px] text-ink">Nothing to show for an archive</p>
                <p className="m-0 text-xs text-ink-3">
                  Comments here are about the whole file.{" "}
                  {access.download !== "none" ? "You may download it." : ""}
                </p>
              </section>
            )}
          </div>
          {commentsColumn}
        </div>
      )}
    </div>
  );
}
