import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Icon } from "~/components/icons";
import { TrackView } from "~/components/tracks";
import { projectQuery, trackQuery } from "~/lib/queries";

export function TrackPage({ trackId }: { trackId: string }) {
  const { data: track, error } = useQuery(trackQuery(trackId));
  const { data: project } = useQuery({
    ...projectQuery(track?.projectId ?? ""),
    enabled: Boolean(track),
  });
  if (error) return <p className="p-8 text-signal">{error.message}</p>;
  if (!track) return <p className="p-8 text-ink-3">Loading</p>;
  const count = track.versions.length;
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-8 sm:px-8">
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2 text-[13px]">
        <Link to="/" className="shrink-0 text-ink-3 no-underline hover:text-ink">
          Projects
        </Link>
        <span className="text-edge">/</span>
        <Link
          to="/projects/$projectId"
          params={{ projectId: track.projectId }}
          className="truncate text-ink-3 no-underline hover:text-ink"
        >
          {project?.name ?? "Project"}
        </Link>
        <span className="text-edge">/</span>
        <span className="truncate font-medium text-ink">{track.name}</span>
      </nav>
      <div className="flex flex-col gap-2">
        <span className="inline-flex h-[22px] w-fit items-center gap-1.5 rounded-chip border border-hairline px-2 label text-ink-2">
          <Icon name="music" size={12} />
          Track
        </span>
        <h1 className="m-0 break-words text-[28px] font-medium tracking-[-0.02em]">{track.name}</h1>
        <p className="tabular m-0 text-[13px] text-ink-2">
          {count === 0 ? "No versions yet" : `${count} ${count === 1 ? "version" : "versions"}`}
        </p>
      </div>
      <TrackView trackId={track.id} />
    </div>
  );
}
