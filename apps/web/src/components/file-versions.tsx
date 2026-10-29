import { fileChains } from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { filesInTracks } from "~/lib/browser";
import { type FileDetail, projectFilesQuery, projectTracksQuery, useOrganise } from "~/lib/queries";
import { type UploadedFile, uploadFile } from "~/lib/upload";
import { kindIcon } from "./files";
import { Icon } from "./icons";
import { Dropdown } from "./ui/menu";
import { UploadDialog } from "./ui/upload-dialog";

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
  !file.variant && !file.takeId && (file.chain.at(-1)?.id ?? file.id) === file.id;

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
  // Loose files of the same kind, in no chain of their own and in no track.
  const chained = fileChains(
    files.map((f) => ({ id: f.id, previousFileId: f.previousFileId ?? null })),
  );
  const inTracks = filesInTracks(tracks);
  const loose = files.filter(
    (f) => f.id !== file.id && f.kind === file.kind && !chained.has(f.id) && !inTracks.has(f.id),
  );
  const number = (file.chain.at(-1)?.number ?? 1) + 1;
  return (
    <UploadDialog<UploadedFile>
      title="New version"
      description={`V${number} of ${file.name}. It takes the file's place in the list; the versions before it stay a step away.`}
      onClose={onClose}
      width="sm"
      inputLabel="The new version"
      prompt="Drop the new version here, or choose it"
      send={(chosen, onProgress, signal) =>
        uploadFile(chosen, {
          projectId: file.projectId,
          folderId: file.folderId,
          signal,
          onProgress: (p) => onProgress(p.total ? p.sent / p.total : 0),
        })
      }
      alternatives={
        loose.length > 0
          ? (add) => (
              <Dropdown
                size="sm"
                value="From the project"
                actions={loose.map((f) => ({
                  label: f.name,
                  icon: <Icon name={kindIcon[f.kind]} size={13} />,
                  onSelect: () =>
                    add({
                      key: f.id,
                      name: f.name,
                      size: f.byteSize,
                      result: { id: f.id, name: f.name, kind: f.kind, byteSize: f.byteSize },
                    }),
                }))}
              />
            )
          : undefined
      }
      what={`It goes into the same folder as V${number - 1}, and the page moves to it.`}
      action={(chosen) =>
        chosen.some((c) => c.file) ? `Upload version ${number}` : `Add version ${number}`
      }
      onSubmit={async ([chosen]) => {
        const made = chosen?.result;
        if (!made) return;
        await nextVersion.mutateAsync({ id: file.id, fileId: made.id });
        onClose();
        void navigate({ to: "/files/$fileId", params: { fileId: made.id } });
      }}
    />
  );
}
