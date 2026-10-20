import { allowsDownload, type DownloadKind } from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { downloadsQuery, useRequestDownload, useRequestScoresDownload } from "~/lib/queries";
import { Icon } from "./icons";
import { Button } from "./ui/button";
import { ChoiceCard } from "./ui/choice";
import { Dialog } from "./ui/dialog";

/**
 * The download permission at work (#136): what you get, and that it is made for you and
 * logged. The link it opens works once, in this session, for five minutes.
 */
export function DownloadDialog({
  fileId,
  name,
  marks,
  onClose,
}: {
  fileId: string;
  name: string;
  /** For a track's score: the track whose score marks are drawn over its pages (#52). */
  marks?: string;
  onClose: () => void;
}) {
  const { data } = useQuery(downloadsQuery(fileId));
  const request = useRequestDownload(fileId);
  const id = useId();
  const usable = (kind: DownloadKind) =>
    Boolean(data && allowsDownload(data.level, kind) && data[kind].available);
  const [picked, setPicked] = useState<DownloadKind | null>(null);
  const which: DownloadKind | null =
    picked ?? (usable("original") ? "original" : usable("proxy") ? "proxy" : null);
  const start = () => {
    if (!which) return;
    request.mutate(
      { kind: which, marks },
      {
        // The browser saves it from the response; the page stays where it is.
        onSuccess: ({ url }) => {
          window.location.assign(url);
          onClose();
        },
      },
    );
  };
  return (
    <Dialog
      title="Download"
      description={name}
      onClose={onClose}
      width="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!which || request.isPending} onClick={start}>
            <Icon name="download" size={14} />
            {request.isPending ? "Preparing…" : "Download"}
          </Button>
        </>
      }
    >
      <fieldset className="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0">
        <legend className="sr-only">What to download</legend>
        {(["proxy", "original"] as const).map((kind) => {
          const allowed = data ? allowsDownload(data.level, kind) : false;
          return (
            <ChoiceCard
              key={kind}
              name={`${id}-kind`}
              value={kind}
              checked={which === kind}
              disabled={!usable(kind)}
              onChange={() => setPicked(kind)}
              title={kind === "proxy" ? "Proxy" : "Original"}
              hint={
                data
                  ? allowed
                    ? data[kind].detail
                    : `${data[kind].detail} · not in your permissions`
                  : "Loading"
              }
              className="has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50"
            />
          );
        })}
      </fieldset>
      {request.error && (
        <p role="alert" className="m-0 mt-3 text-[13px] text-signal">
          {request.error.message}
        </p>
      )}
      <p className="m-0 mt-3 text-[12px] text-ink-3">
        {data && !data.marked
          ? "Audio carries no mark yet. The download is written to the access log."
          : marks
            ? "The score marks drawn over every page, made for you with your name across it, and written to the access log."
            : "Made for you, with your name drawn across it, and written to the access log."}
      </p>
    </Dialog>
  );
}

/**
 * Every track's score in a project with its marks, as one PDF (#52): as reviewed, or drawn
 * again at print resolution. Each score needs the download permission, and each is logged.
 */
export function ScoresDownloadDialog({
  projectId,
  count,
  can,
  onClose,
}: {
  projectId: string;
  /** How many tracks have a score. */
  count: number;
  /** Which kinds the role allows. */
  can: Record<DownloadKind, boolean>;
  onClose: () => void;
}) {
  const request = useRequestScoresDownload(projectId);
  const id = useId();
  const [picked, setPicked] = useState<DownloadKind | null>(null);
  const which: DownloadKind | null =
    picked ?? (can.original ? "original" : can.proxy ? "proxy" : null);
  const start = () => {
    if (!which) return;
    request.mutate(which, {
      onSuccess: ({ url }) => {
        window.location.assign(url);
        onClose();
      },
    });
  };
  const hints: Record<DownloadKind, string> = {
    proxy: "Every page as reviewed, as one PDF",
    original: "Every page at print resolution, as one PDF",
  };
  return (
    <Dialog
      title="Download"
      description={`Every score, ${count} tracks, with their marks`}
      onClose={onClose}
      width="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!which || request.isPending} onClick={start}>
            <Icon name="download" size={14} />
            {request.isPending ? "Preparing…" : "Download"}
          </Button>
        </>
      }
    >
      <fieldset className="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0">
        <legend className="sr-only">What to download</legend>
        {(["proxy", "original"] as const).map((kind) => (
          <ChoiceCard
            key={kind}
            name={`${id}-kind`}
            value={kind}
            checked={which === kind}
            disabled={!can[kind]}
            onChange={() => setPicked(kind)}
            title={kind === "proxy" ? "Proxy" : "Original"}
            hint={can[kind] ? hints[kind] : `${hints[kind]} · not in your permissions`}
            className="has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50"
          />
        ))}
      </fieldset>
      {request.error && (
        <p role="alert" className="m-0 mt-3 text-[13px] text-signal">
          {request.error.message}
        </p>
      )}
      <p className="m-0 mt-3 text-[12px] text-ink-3">
        Each score in the tracks' order with its marks drawn over every page, made for you with your
        name across it, and each written to the access log.
      </p>
    </Dialog>
  );
}
