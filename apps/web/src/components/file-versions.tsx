import { fileChains } from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type DragEvent, useRef, useState } from "react";
import { filesInTracks } from "~/lib/browser";
import { cn } from "~/lib/cn";
import { type FileDetail, projectFilesQuery, projectTracksQuery, useOrganise } from "~/lib/queries";
import { uploadFile } from "~/lib/upload";
import { kindIcon } from "./files";
import { Icon } from "./icons";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { FileInput } from "./ui/input";
import { Dropdown } from "./ui/menu";

/**
 * A loose file's simple version chain (#149): every version one step away, the one shown
 * marked, as a track's versions are. Nothing for a file in no chain.
 */
export function FileChain({ file }: { file: FileDetail }) {
  if (file.chain.length === 0) return null;
  return (
    <nav aria-label="Versions" className="flex flex-wrap items-center gap-1 text-[13px]">
      {file.chain.map((v) => {
        const current = v.id === file.id;
        return (
          <Link
            key={v.id}
            to="/files/$fileId"
            params={{ fileId: v.id }}
            // The review it was opened from holds while moving along the chain.
            search={(prev) => ({ review: prev.review })}
            aria-current={current ? "page" : undefined}
            title={v.name}
            className={cn(
              "tabular h-6 rounded-chip border px-2 font-mono text-[11px] leading-6 no-underline",
              current
                ? "border-edge bg-raised text-ink"
                : "border-transparent text-ink-3 hover:text-ink",
            )}
          >
            V{v.number}
          </Link>
        );
      })}
    </nav>
  );
}

/** Whether a new version can follow this file: a loose file, the latest of its chain. */
export const takesVersions = (file: FileDetail) =>
  !file.variation && !file.takeId && (file.chain.at(-1)?.id ?? file.id) === file.id;

/**
 * A file's next version (#149): dropped or chosen from this computer, uploaded into the
 * file's folder, or one of the project's loose files of the same kind. It takes the file's
 * place in the list, and the page moves to it.
 */
export function NewVersionDialog({ file, onClose }: { file: FileDetail; onClose: () => void }) {
  const navigate = useNavigate();
  const { nextVersion } = useOrganise(file.projectId);
  const { data: files = [] } = useQuery(projectFilesQuery(file.projectId));
  const { data: tracks = [] } = useQuery(projectTracksQuery(file.projectId));
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [sending, setSending] = useState<{ name: string; share: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Loose files of the same kind, in no chain of their own and in no track.
  const chained = fileChains(
    files.map((f) => ({ id: f.id, previousFileId: f.previousFileId ?? null })),
  );
  const inTracks = filesInTracks(tracks);
  const loose = files.filter(
    (f) => f.id !== file.id && f.kind === file.kind && !chained.has(f.id) && !inTracks.has(f.id),
  );
  const link = async (fileId: string) => {
    await nextVersion.mutateAsync({ id: file.id, fileId });
    onClose();
    void navigate({ to: "/files/$fileId", params: { fileId } });
  };
  const send = async (chosen: File) => {
    setError(null);
    setSending({ name: chosen.name, share: 0 });
    try {
      const made = await uploadFile(chosen, {
        projectId: file.projectId,
        folderId: file.folderId,
        signal: new AbortController().signal,
        onProgress: (p) => setSending({ name: chosen.name, share: p.total ? p.sent / p.total : 0 }),
      });
      await link(made.id);
    } catch (failed) {
      setError(failed instanceof Error ? failed.message : "The new version could not be added");
      setSending(null);
    }
  };
  const pick = (fileId: string) => {
    setError(null);
    link(fileId).catch((failed: unknown) =>
      setError(failed instanceof Error ? failed.message : "The new version could not be added"),
    );
  };
  const drop = (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    const dropped = event.dataTransfer.files[0];
    if (dropped && !sending) void send(dropped);
  };
  const number = (file.chain.at(-1)?.number ?? 1) + 1;
  return (
    <Dialog
      title="New version"
      description={`V${number} of ${file.name}. It takes the file's place in the list; the versions before it stay a step away.`}
      onClose={onClose}
      width="sm"
    >
      <FileInput
        ref={input}
        aria-label="The new version"
        onChange={(event) => {
          const chosen = event.target.files?.[0];
          if (chosen) void send(chosen);
          event.target.value = "";
        }}
      />
      {/* biome-ignore lint/a11y/noStaticElementInteractions: dropping is a shortcut; the buttons do the same. */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={drop}
        className={cn(
          "flex flex-col gap-3 rounded-panel border border-dashed p-4 transition-colors",
          over ? "border-ink-3 bg-raised/40" : "border-edge",
        )}
      >
        {sending ? (
          <p className="tabular m-0 truncate text-[13px] text-ink-2" aria-live="polite">
            Sending {sending.name} · {Math.round(sending.share * 100)}%
          </p>
        ) : (
          <p className="m-0 text-[13px] text-ink-2">Drop the new version here, or choose it.</p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={Boolean(sending) || nextVersion.isPending}
            onClick={() => input.current?.click()}
          >
            <Icon name="upload" size={13} />
            Choose a file
          </Button>
          {loose.length > 0 && !sending && (
            <Dropdown
              size="sm"
              value="From the project"
              actions={loose.map((f) => ({
                label: f.name,
                icon: <Icon name={kindIcon[f.kind]} size={13} />,
                onSelect: () => pick(f.id),
              }))}
            />
          )}
        </div>
      </div>
      {error && (
        <p role="alert" className="m-0 mt-3 text-[13px] text-signal">
          {error}
        </p>
      )}
    </Dialog>
  );
}
