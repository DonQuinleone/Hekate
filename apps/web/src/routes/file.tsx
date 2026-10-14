import { formatBytes, formatChannels, formatDuration, type MediaInfo } from "@hekate/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { Comments, useCommentMarkers } from "~/components/comments";
import { Compare } from "~/components/compare";
import { mediaSummary } from "~/components/files";
import { Loudness } from "~/components/loudness";
import { type Crumb, PageHeader } from "~/components/page-header";
import { Player } from "~/components/player";
import { FileContext } from "~/components/tracks";
import type { Loop } from "~/lib/loop";
import { type FileDetail, fileQuery, playbackQuery, projectQuery } from "~/lib/queries";
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
}: {
  file: FileDetail;
  onMedia: (element: HTMLMediaElement | null) => void;
  loop: Loop | null;
  onLoop: (loop: Loop | null) => void;
}) {
  const client = useQueryClient();
  const markers = useCommentMarkers(file.id);
  const ready = file.streamStatus === "ready";
  const { data, error } = useQuery({ ...playbackQuery(file.id), enabled: ready });
  if (file.kind !== "audio" && file.kind !== "video") {
    return <Notice>Previews for documents and images arrive with protected viewing.</Notice>;
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

export function FilePage({
  fileId,
  loop = null,
  onLoop = () => {},
}: {
  fileId: string;
  /** The passage being looped, kept in the address so it holds across versions and variations. */
  loop?: Loop | null;
  onLoop?: (loop: Loop | null) => void;
}) {
  const { data: file, error } = useQuery(fileQuery(fileId));
  const [media, setMedia] = useState<HTMLMediaElement | null>(null);
  const { guest } = useViewer();
  // Guests see the files of their reviews, never the project around them.
  const { data: project } = useQuery({
    ...projectQuery(file?.projectId ?? ""),
    enabled: Boolean(file) && !guest,
  });
  if (error) return <p className="p-8 text-signal">{error.message}</p>;
  if (!file) return <p className="p-8 text-ink-3">Loading</p>;
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
        { key: "projects", link: <Link to="/">Projects</Link> },
        {
          key: "project",
          link: (
            <Link to="/projects/$projectId" params={{ projectId: file.projectId }}>
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
      <PageHeader
        crumbs={crumbs}
        title={file.name}
        // Media formats show in the player; other files say what they are here.
        meta={summary ? undefined : file.contentType}
      />
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-5 sm:px-6">
        {!guest && <FileContext file={file} />}
        <div className="grid grid-cols-1 items-start gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="flex min-w-0 flex-col gap-6">
            <Playback file={file} onMedia={setMedia} loop={loop} onLoop={onLoop} />
            {!guest && file.kind === "audio" && file.streamStatus === "ready" && (
              <Compare file={file} media={media} />
            )}
            {file.mediaInfo?.audio && (
              <Loudness
                fileId={file.id}
                media={media}
                layout={file.mediaInfo.audio.channelLayout}
              />
            )}
            <dl className="m-0 hidden flex-col border-t border-hairline lg:flex">{detailRows}</dl>
          </div>
          <Comments
            fileId={file.id}
            projectId={file.projectId}
            media={media}
            loop={loop}
            onLoop={(next) => {
              // One action: the passage is looped and heard from its start.
              onLoop(next);
              if (media) {
                media.currentTime = next.start;
                void media.play().catch(() => undefined);
              }
            }}
          />
          <dl className="m-0 flex flex-col border-t border-hairline lg:hidden">{detailRows}</dl>
        </div>
      </div>
    </>
  );
}
