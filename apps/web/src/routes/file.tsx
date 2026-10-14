import { formatBytes, formatChannels, formatDuration, type MediaInfo } from "@hekate/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { Comments, useCommentMarkers } from "~/components/comments";
import { kindIcon, mediaSummary } from "~/components/files";
import { Icon } from "~/components/icons";
import { Player } from "~/components/player";
import { type FileDetail, fileQuery, playbackQuery, projectQuery } from "~/lib/queries";

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
}: {
  file: FileDetail;
  onMedia: (element: HTMLMediaElement | null) => void;
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

export function FilePage({ fileId }: { fileId: string }) {
  const { data: file, error } = useQuery(fileQuery(fileId));
  const [media, setMedia] = useState<HTMLMediaElement | null>(null);
  const { data: project } = useQuery({
    ...projectQuery(file?.projectId ?? ""),
    enabled: Boolean(file),
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
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8 sm:px-8">
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2 text-[13px]">
        <Link to="/" className="shrink-0 text-ink-3 no-underline hover:text-ink">
          Projects
        </Link>
        <span className="text-edge">/</span>
        <Link
          to="/projects/$projectId"
          params={{ projectId: file.projectId }}
          className="truncate text-ink-3 no-underline hover:text-ink"
        >
          {project?.name ?? "Project"}
        </Link>
        <span className="text-edge">/</span>
        <span className="truncate font-medium text-ink">{file.name}</span>
      </nav>
      <div className="flex flex-col gap-2">
        <span className="inline-flex h-[22px] w-fit items-center gap-1.5 rounded-chip border border-hairline px-2 label text-ink-2">
          <Icon name={kindIcon[file.kind]} size={12} />
          {file.kind}
        </span>
        <h1 className="m-0 break-words text-[28px] font-medium tracking-[-0.02em]">{file.name}</h1>
        {summary && <p className="tabular m-0 text-[13px] text-ink-2">{summary}</p>}
      </div>
      <div className="grid grid-cols-1 items-start gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-6">
          <Playback file={file} onMedia={setMedia} />
          <dl className="m-0 hidden flex-col border-t border-hairline lg:flex">{detailRows}</dl>
        </div>
        <Comments fileId={file.id} media={media} />
        <dl className="m-0 flex flex-col border-t border-hairline lg:hidden">{detailRows}</dl>
      </div>
    </div>
  );
}
