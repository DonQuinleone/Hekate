import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { type ChosenFile, UploadDialog } from "~/components/ui/upload-dialog";
import { projectById, type Track, tracks, type Version } from "~/data";

/** The file the zone picks here, as a variation of a version. */
const sample: ChosenFile = {
  key: "instrumental",
  name: "Maple Leaf Rag - V2 instrumental.wav",
  size: 52_400_000,
};

/**
 * The names a project's variations go by (Dry, Wet, Instrumental), to suggest for a new one
 * (#486): each once, the most recently used first, leaving out those the version already has.
 */
export function variationNames(projectId: string, taken: string[], limit = 6): string[] {
  const have = new Set(taken.map((n) => n.toLowerCase()));
  const names: string[] = [];
  const versions = tracks
    .filter((t) => t.projectId === projectId)
    .flatMap((t) => t.versions)
    .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  for (const version of versions) {
    for (const { name } of version.variations) {
      if (have.has(name.toLowerCase())) continue;
      have.add(name.toLowerCase());
      names.push(name);
      if (names.length === limit) return names;
    }
  }
  return names;
}

/**
 * Another variation of a version (#486), from the track's versions page or the variation
 * switch above the player: its file dropped, chosen or picked from the project, named as the
 * file is or with one of the names the project's variations already go by, and made the
 * primary or not.
 */
export function AddVariationDialog({
  track,
  version,
  onClose,
}: {
  track: Track;
  version: Version;
  onClose: () => void;
}) {
  const video = projectById(track.projectId)?.profile === "video";
  const word = video ? "rendition" : "variation";
  const label = video ? `Cut ${version.number}` : `V${version.number}`;
  const [chosen, setChosen] = useState<ChosenFile[]>([sample]);
  const [name, setName] = useState("Instrumental");
  const suggestions = variationNames(
    track.projectId,
    version.variations.map((v) => v.name),
  );
  return (
    <UploadDialog
      title={`Add a ${word} to ${label}`}
      description={
        video
          ? "Another treatment of the same cut, such as a 9:16 or a subtitled rendition beside the main one."
          : "Another treatment of the same edit, such as a wet mix beside the dry one."
      }
      onClose={onClose}
      inputLabel={`The ${word}'s file`}
      prompt="Drop the file here, or choose it"
      chosen={chosen}
      onPick={() => setChosen([sample])}
      onRemove={() => setChosen([])}
      alternatives={
        <Button variant="ghost" size="sm">
          From the project
        </Button>
      }
      fields={
        chosen.length > 0 && (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-end gap-4">
              <label className="flex w-48 flex-col gap-1.5 text-[13px] text-ink-2">
                Name
                <Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
              </label>
              <label className="flex h-9 items-center gap-2 text-[14px] text-ink-2">
                <input type="checkbox" /> Make it the primary
              </label>
            </div>
            {/* The names the project's other variations go by: one press names this one. */}
            {suggestions.length > 0 && (
              <fieldset className="m-0 flex flex-wrap items-center gap-1 border-0 p-0">
                <legend className="sr-only">
                  {video ? "Rendition" : "Variation"} names used in this project
                </legend>
                <span aria-hidden="true" className="mr-1 text-[12px] text-ink-3">
                  Used in this project
                </span>
                {suggestions.map((s) => (
                  <button
                    key={s}
                    type="button"
                    aria-pressed={name.trim() === s}
                    onClick={() => setName(s)}
                    className={
                      name.trim() === s
                        ? "inline-flex h-7 items-center rounded-chip border border-edge bg-raised px-2.5 text-[13px] text-ink shadow-1"
                        : "inline-flex h-7 items-center rounded-chip border border-transparent px-2.5 text-[13px] text-ink-3 transition-colors hover:text-ink"
                    }
                  >
                    {s}
                  </button>
                ))}
              </fieldset>
            )}
          </div>
        )
      }
      what={`Uploaded into the ${video ? "deliverable" : "track"}'s folder, beside the other ${word}s of ${label}.`}
      action={`Add ${word}`}
      onAction={onClose}
    />
  );
}
