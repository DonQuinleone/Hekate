import { fileChains } from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
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
 * A loose file's simple version chain (#149): the version shown, and every other one a step
 * away, newest first, as the prototype chooses a track's. Nothing for a file in no chain.
 */
export function FileChain({ file }: { file: FileDetail }) {
  const navigate = useNavigate();
  const shown = file.chain.find((v) => v.id === file.id);
  if (!shown) return null;
  const latest = file.chain.at(-1)?.id;
  return (
    <div className="flex items-center">
      <Dropdown
        label="Version"
        value={
          <span className="tabular flex items-center gap-1.5 font-medium text-ink">
            V{shown.number}
            {shown.id === latest && <span className="font-normal text-ink-3">latest</span>}
          </span>
        }
        actions={[...file.chain].reverse().map((v) => ({
          label: `V${v.number}`,
          hint: v.id === latest ? "latest" : v.name,
          checked: v.id === file.id,
          // The review it was opened from holds while moving along the chain.
          onSelect: () =>
            void navigate({
              to: "/files/$fileId",
              params: { fileId: v.id },
              search: (prev) => ({ review: prev.review }),
            }),
        }))}
      />
    </div>
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
