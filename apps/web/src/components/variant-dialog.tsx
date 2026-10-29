import { capital, variantNameFrom } from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  projectFilesQuery,
  projectTracksQuery,
  type Track,
  useItemWords,
  useTrackMutations,
  type Version,
} from "~/lib/queries";
import { type UploadedFile, uploadFile } from "~/lib/upload";
import { primaryOf, variantNames } from "~/lib/versions";
import { kindIcon } from "./files";
import { Icon } from "./icons";
import { ToggleChip } from "./ui/chip";
import { Checkbox } from "./ui/choice";
import { Field } from "./ui/field";
import { Input, Select } from "./ui/input";
import { Dropdown } from "./ui/menu";
import { UploadDialog } from "./ui/upload-dialog";

/** Audio and video in the project that no version uses yet: what can become a variant. */
export function useLooseMedia(track: Track) {
  const { data: files = [] } = useQuery(projectFilesQuery(track.projectId));
  const { data: tracks = [] } = useQuery(projectTracksQuery(track.projectId));
  const used = new Set(
    tracks.flatMap((t) => t.versions.flatMap((v) => v.variants.map((x) => x.fileId))),
  );
  return files.filter((f) => (f.kind === "audio" || f.kind === "video") && !used.has(f.id));
}

/**
 * Another variant of a version, or a corrected file in place of one: dropped, chosen or
 * picked from the project's loose files. Opened from the track's versions page and from the
 * variant switch above the player (#486), which then follows the new one once it plays.
 * A new one is named as its file is, or with one of the names the project's variants
 * already go by.
 */
export function VariantDialog({
  track,
  version,
  mode,
  onClose,
  onAdded,
}: {
  track: Track;
  version: Version;
  mode: "add" | "replace";
  onClose: () => void;
  /** Once a variant is added: the file it was made of, for whoever wants to open it. */
  onAdded?: ((fileId: string) => void) | undefined;
}) {
  const { addVariant, replaceFile } = useTrackMutations(track.projectId);
  const { words, versionLabel, video } = useItemWords(track.projectId);
  const loose = useLooseMedia(track);
  const { data: tracks = [] } = useQuery(projectTracksQuery(track.projectId));
  const suggestions = variantNames(
    tracks,
    version.variants.map((v) => v.name),
  );
  /** The file chosen, by name, and the variant's name read from it until one is typed. */
  const [chosen, setChosen] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [primary, setPrimary] = useState(false);
  const [target, setTarget] = useState(primaryOf(version)?.id ?? "");
  const replacing = version.variants.find((v) => v.id === target);
  return (
    <UploadDialog<UploadedFile>
      title={
        mode === "add"
          ? `Add a ${words.variant} to ${versionLabel(version.number)}`
          : `Replace a file of ${versionLabel(version.number)}`
      }
      description={
        mode === "add"
          ? video
            ? "Another treatment of the same cut, such as a 9:16 or a subtitled rendition beside the main one."
            : "Another treatment of the same edit, such as a wet mix beside the dry one."
          : "A corrected export in its place. Its comments move to the new file; the old one stays in the project."
      }
      onClose={onClose}
      inputLabel={mode === "add" ? `The ${words.variant}'s file` : "The corrected file"}
      prompt="Drop the file here, or choose it"
      accept="audio/*,video/*"
      send={(file, onProgress, signal) =>
        uploadFile(file, {
          projectId: track.projectId,
          folderId: track.folderId,
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
      onChange={(files) => {
        const file = files[0];
        setChosen(file?.name ?? null);
        setName(file ? variantNameFrom(file.name, track.name) : "");
      }}
      fields={
        <>
          {mode === "replace" && version.variants.length > 1 && (
            <Field label={capital(words.variant)}>
              <Select value={target} onChange={(e) => setTarget(e.target.value)}>
                {version.variants.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name} · {v.fileName}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {mode === "add" && chosen && (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-end gap-4">
                <Field label="Name" className="w-48">
                  <Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
                </Field>
                <label className="flex h-9 cursor-pointer items-center gap-2 text-[14px] text-ink-2">
                  <Checkbox checked={primary} onChange={(e) => setPrimary(e.target.checked)} />
                  Make it the primary
                </label>
              </div>
              {/* The names the project's other variants go by: one press names this one. */}
              {suggestions.length > 0 && (
                <fieldset className="m-0 flex flex-wrap items-center gap-1 border-0 p-0">
                  <legend className="sr-only">
                    {capital(words.variant)} names used in this project
                  </legend>
                  <span aria-hidden="true" className="mr-1 text-[12px] text-ink-3">
                    Used in this project
                  </span>
                  {suggestions.map((s) => (
                    <ToggleChip key={s} pressed={name.trim() === s} onClick={() => setName(s)}>
                      {s}
                    </ToggleChip>
                  ))}
                </fieldset>
              )}
            </div>
          )}
        </>
      }
      what={
        mode === "add"
          ? `Uploaded into the ${words.track}'s folder, beside the other ${words.variants} of ${versionLabel(version.number)}.`
          : replacing
            ? `In place of ${replacing.fileName}.`
            : undefined
      }
      action={mode === "add" ? `Add ${words.variant}` : "Replace"}
      onSubmit={async ([first]) => {
        if (!first?.result) return;
        if (mode === "add") {
          await addVariant.mutateAsync({
            versionId: version.id,
            fileId: first.result.id,
            name: name.trim() || "Main",
            primary,
          });
          onAdded?.(first.result.id);
        } else {
          await replaceFile.mutateAsync({ variantId: target, fileId: first.result.id });
        }
        onClose();
      }}
    />
  );
}
