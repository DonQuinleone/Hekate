import { useState } from "react";
import { tracks as allTracks, type Track } from "~/data";
import { Input, Select } from "./ui/input";
import { type ChosenFile, UploadDialog } from "./ui/upload-dialog";

/**
 * Uploading into a music project (#485): audio is asked what it is before it goes up, in the
 * upload dialog itself. A new track (the file becomes its version 1, named from the file), a
 * new version of a track that exists (each file a variation, as the track's own new-version
 * dialog has it), or just a file. Several files can be a track each or one track with a
 * version per file. The choice last made is remembered per project; files dropped on a
 * track's row open on a new version of it. Anything that is not audio goes up as it is.
 */

type UploadChoice = "track" | "version" | "file";
type Grouping = "each" | "one";

/** The files the zone picks here, with what each becomes under each choice. */
const sample: (ChosenFile & { track: string; variation: string })[] = [
  {
    key: "a",
    name: "Pine Apple Rag - V1 mix.wav",
    size: 28_400_000,
    track: "Pine Apple Rag",
    variation: "V1 mix",
  },
  {
    key: "b",
    name: "Pine Apple Rag - V2 mix.wav",
    size: 28_600_000,
    track: "Pine Apple Rag",
    variation: "V2 mix",
  },
  {
    key: "c",
    name: "Elite Syncopations - rough.wav",
    size: 31_100_000,
    track: "Elite Syncopations",
    variation: "Rough",
  },
];

const key = (projectId: string) => `hekate.prototype.upload-as.${projectId}`;

function remembered(projectId: string): UploadChoice {
  try {
    const kept = localStorage.getItem(key(projectId));
    return kept === "version" || kept === "file" ? kept : "track";
  } catch {
    return "track";
  }
}

export function UploadFilesDialog({
  projectId,
  folderName,
  onto,
  onClose,
}: {
  projectId: string;
  /** The open folder's name; undefined at the top of the project. */
  folderName?: string;
  /** The track the files were dropped on, if any: a new version of it is the default then. */
  onto?: Track;
  onClose: () => void;
}) {
  const tracks = allTracks
    .filter((t) => t.projectId === projectId)
    .sort((a, b) => a.name.localeCompare(b.name));
  const [chosen, setChosen] = useState<ChosenFile[]>(sample);
  const [choice, setChoice] = useState<UploadChoice>(() =>
    onto ? "version" : remembered(projectId),
  );
  const [grouping, setGrouping] = useState<Grouping>("each");
  const [trackId, setTrackId] = useState(onto?.id ?? tracks[0]?.id ?? "");
  const [primary, setPrimary] = useState("a");
  const target = tracks.find((t) => t.id === trackId) ?? tracks[0];
  const next = (target?.versions.length ?? 0) + 1;
  const where = folderName ?? "the top of the project";
  const into = folderName ? `in ${folderName}` : "at the top of the project";
  const n = chosen.length;
  const pick = (c: UploadChoice) => {
    setChoice(c);
    try {
      localStorage.setItem(key(projectId), c);
    } catch {
      // Not remembered.
    }
  };
  const one = choice === "track" && grouping === "one" && n > 1;
  const ordered = [...chosen].sort((a, b) => a.name.localeCompare(b.name));

  const what =
    choice === "file"
      ? n === 1
        ? `The file is uploaded to ${where} as it is.`
        : `${n} files are uploaded to ${where} as they are.`
      : choice === "version"
        ? n === 1
          ? `The file becomes version ${next} of ${target?.name}.`
          : `${n} files become the variations of version ${next} of ${target?.name}.`
        : one
          ? `${n} files become versions 1 to ${n} of one track ${into}, in name order.`
          : n === 1
            ? `The file becomes version 1 of a new track ${into}.`
            : `${n} files become ${n} tracks ${into}, each at version 1.`;
  const action =
    choice === "file"
      ? `Upload ${n} ${n === 1 ? "file" : "files"}`
      : choice === "version"
        ? `Upload version ${next}`
        : one
          ? "Make the track"
          : n === 1
            ? "Make a track"
            : `Make ${n} tracks`;

  const radio = (name: string, checked: boolean, onChange: () => void, label: string) => (
    <label className="flex cursor-pointer items-center gap-2 text-[14px] text-ink">
      <input type="radio" name={name} checked={checked} onChange={onChange} />
      {label}
    </label>
  );

  return (
    <UploadDialog
      title="Upload"
      description="Audio can become a track, a version of one, or stay a file."
      onClose={onClose}
      width="lg"
      inputLabel="Files to upload"
      prompt="Drop files here, or choose them"
      multiple
      chosen={chosen}
      onPick={() => setChosen(sample)}
      onRemove={(k) => setChosen((c) => c.filter((f) => f.key !== k))}
      before={
        <fieldset className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0">
          <legend className="sr-only">What the audio becomes</legend>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            {radio("upload-as", choice === "track", () => pick("track"), "New track")}
            <span className="flex min-w-0 flex-wrap items-center gap-2">
              {radio("upload-as", choice === "version", () => pick("version"), "New version of")}
              <Select
                aria-label="Track"
                value={target?.id ?? ""}
                onChange={(e) => {
                  setTrackId(e.target.value);
                  pick("version");
                }}
                className="h-7 w-auto max-w-full text-[13px]"
              >
                {tracks.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </span>
            {radio("upload-as", choice === "file", () => pick("file"), "Just a file")}
          </div>
          {choice === "track" && n > 1 && (
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 pl-6">
              {radio(
                "upload-grouping",
                grouping === "each",
                () => setGrouping("each"),
                "A track each",
              )}
              {radio(
                "upload-grouping",
                grouping === "one",
                () => setGrouping("one"),
                `One track, ${n} versions`,
              )}
            </div>
          )}
          {one && (
            <label className="flex flex-col gap-1.5 pl-6 text-[13px] text-ink-2 @3xl/app:w-96">
              Track name
              <Input defaultValue="Pine Apple Rag" />
            </label>
          )}
        </fieldset>
      }
      row={(c) => {
        const s = sample.find((f) => f.key === c.key);
        if (choice === "version")
          return (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <Input
                defaultValue={s?.variation ?? ""}
                aria-label={`Variation name for ${c.name}`}
                className="h-7 w-48 text-[13px]"
              />
              <label className="flex items-center gap-1.5 text-[13px] text-ink-2">
                <input
                  type="radio"
                  name="primary"
                  checked={primary === c.key}
                  onChange={() => setPrimary(c.key)}
                />{" "}
                Primary
              </label>
            </div>
          );
        if (choice === "track" && !one)
          return (
            <Input
              defaultValue={s?.track ?? ""}
              aria-label={`Track name for ${c.name}`}
              className="h-7 w-72 max-w-full text-[13px]"
            />
          );
        if (one)
          return (
            <span className="text-[12px] text-ink-3">
              Version {ordered.findIndex((f) => f.key === c.key) + 1}
            </span>
          );
        return null;
      }}
      what={what}
      action={action}
      onAction={onClose}
    />
  );
}
