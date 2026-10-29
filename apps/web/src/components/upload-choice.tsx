import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import type { Picked } from "~/lib/picked-files";
import { type Track, useProjectCan, useTrackMutations } from "~/lib/queries";
import { type UploadedFile, uploadFile } from "~/lib/upload";
import {
  actionFor,
  byName,
  defaultChoice,
  describePlan,
  isAudio,
  planUpload,
  rememberChoice,
  type TrackGrouping,
  trackNameFrom,
  type UploadChoice,
} from "~/lib/upload-plan";
import { Choice, Radio } from "./ui/choice";
import { Field } from "./ui/field";
import { Input, Select } from "./ui/input";
import { type ChosenFile, UploadDialog } from "./ui/upload-dialog";
import { letThrough, versionProblem } from "./version-problem";

/**
 * Uploading into a music project (#485): audio is asked what it is before it goes up, in the
 * upload dialog itself. A new track (the file becomes its version 1, named from the file), a
 * new version of a track that exists (each file a variation, as the track's own new-version
 * dialog has it), or just a file. Several files can be a track each or one track with a
 * version per file. The choice last made is remembered per project; files dropped on a
 * track's row open on a new version of it. Anything that is not audio goes up as it is,
 * alongside. The tracks and versions are made with the routes that exist, once the files are
 * uploaded.
 */
export function AudioUploadDialog({
  projectId,
  folderId,
  folderName,
  tracks,
  initial,
  onto,
  onClose,
}: {
  projectId: string;
  /** Where plain files and new tracks go; null is the top of the project. */
  folderId: string | null;
  folderName: string | undefined;
  /** The project's tracks, for a new version to go to. */
  tracks: Track[];
  /** Files dropped before the dialog opened. */
  initial?: Picked[] | undefined;
  /** The track the files were dropped on, if any. */
  onto?: Track | null | undefined;
  onClose: () => void;
}) {
  const can = useProjectCan(projectId);
  const client = useQueryClient();
  const { createTrack, createVersion } = useTrackMutations(projectId);
  const mayMakeTracks = can("organise");
  const ordered = byName(tracks);
  const hasTracks = ordered.length > 0;
  const [choice, setChoice] = useState<UploadChoice>(() =>
    defaultChoice({ projectId, droppedOnTrack: Boolean(onto), mayMakeTracks, hasTracks }),
  );
  const [grouping, setGrouping] = useState<TrackGrouping>("each");
  const [trackId, setTrackId] = useState(onto?.id ?? ordered[0]?.id ?? "");
  const [names, setNames] = useState<Record<string, string>>({});
  const [primary, setPrimary] = useState<string | null>(null);
  const [chosen, setChosen] = useState<ChosenFile<UploadedFile>[]>([]);
  // What a run that was refused halfway already made, so trying again carries on from there.
  const made = useRef(new Map<string, string>());
  const landed = useRef(new Set<string>());

  const target = ordered.find((t) => t.id === trackId) ?? ordered[0];
  const audible = (c: ChosenFile<UploadedFile>) => isAudio(c.file ?? { name: c.name });
  const audio = chosen.filter(audible);
  const others = chosen.length - audio.length;
  const folder = folderName ?? null;
  const plan = planUpload(audio, choice, {
    grouping,
    names,
    track: target ? { id: target.id, name: target.name, versions: target.versions.length } : null,
    primary,
  });
  const versionOf = (key: string) =>
    plan.kind === "one-track" ? plan.versions.find((v) => v.key === key)?.number : undefined;
  const pick = (next: UploadChoice) => {
    setChoice(next);
    rememberChoice(projectId, next);
  };

  const run = async (sent: ChosenFile<UploadedFile>[], hint?: unknown) => {
    const fileOf = new Map(sent.flatMap((c) => (c.result ? [[c.key, c.result.id] as const] : [])));
    const main = (fileId: string) => [{ fileId, name: "Main", primary: true }];
    const version = (
      id: string,
      variations: { fileId: string; name: string; primary: boolean }[],
    ) =>
      createVersion.mutateAsync({
        trackId: id,
        variations,
        letThrough: letThrough(hint) || undefined,
      });
    const trackFor = async (key: string, name: string) => {
      const known = made.current.get(key);
      if (known) return known;
      const track = await createTrack.mutateAsync({ name, folderId });
      made.current.set(key, track.id);
      return track.id;
    };
    if (plan.kind === "tracks") {
      for (const t of plan.tracks) {
        const fileId = fileOf.get(t.key);
        if (!fileId || landed.current.has(t.key)) continue;
        await version(await trackFor(t.key, t.name), main(fileId));
        landed.current.add(t.key);
      }
    } else if (plan.kind === "one-track") {
      const id = await trackFor("track", plan.name);
      for (const v of plan.versions) {
        const fileId = fileOf.get(v.key);
        if (!fileId || landed.current.has(v.key)) continue;
        await version(id, main(fileId));
        landed.current.add(v.key);
      }
    } else if (plan.kind === "version") {
      await version(
        plan.track.id,
        plan.variations.flatMap((v) => {
          const fileId = fileOf.get(v.key);
          return fileId ? [{ fileId, name: v.name, primary: v.primary }] : [];
        }),
      );
    }
    void client.invalidateQueries({ queryKey: ["projects", projectId, "files"] });
    onClose();
  };

  const choices = audio.length > 0 && (
    <fieldset className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0">
      <legend className="sr-only">What the audio becomes</legend>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        {mayMakeTracks && (
          <Choice
            type="radio"
            name="upload-as"
            checked={choice === "track"}
            onChange={() => pick("track")}
          >
            New track
          </Choice>
        )}
        {hasTracks && (
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <Choice
              type="radio"
              name="upload-as"
              checked={choice === "version"}
              onChange={() => pick("version")}
            >
              New version of
            </Choice>
            <Select
              size="sm"
              aria-label="Track"
              value={target?.id ?? ""}
              onFocus={() => choice !== "version" && pick("version")}
              onChange={(e) => {
                setTrackId(e.target.value);
                pick("version");
              }}
              className="w-auto max-w-full"
            >
              {ordered.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </span>
        )}
        <Choice
          type="radio"
          name="upload-as"
          checked={choice === "file"}
          onChange={() => pick("file")}
        >
          Just a file
        </Choice>
      </div>
      {choice === "track" && audio.length > 1 && (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 pl-6">
          <Choice
            type="radio"
            name="upload-grouping"
            checked={grouping === "each"}
            onChange={() => setGrouping("each")}
          >
            A track each
          </Choice>
          <Choice
            type="radio"
            name="upload-grouping"
            checked={grouping === "one"}
            onChange={() => setGrouping("one")}
          >
            One track, {audio.length} versions
          </Choice>
        </div>
      )}
      {plan.kind === "one-track" && (
        <Field label="Track name" className="pl-6 @3xl/app:w-96">
          <Input
            value={names.track ?? plan.name}
            onChange={(e) => setNames((n) => ({ ...n, track: e.target.value }))}
          />
        </Field>
      )}
    </fieldset>
  );

  return (
    <UploadDialog<UploadedFile>
      title="Upload"
      description="Audio can become a track, a version of one, or stay a file."
      onClose={onClose}
      width="lg"
      inputLabel="Files to upload"
      prompt="Drop files here, or choose them"
      multiple
      initial={initial}
      send={(file, onProgress, signal) =>
        uploadFile(file, {
          projectId,
          // A version's files live in its track's folder, as the track's own dialog has it.
          folderId:
            plan.kind === "version" && isAudio(file) ? (target?.folderId ?? folderId) : folderId,
          signal,
          onProgress: (p) => onProgress(p.total ? p.sent / p.total : 0),
        })
      }
      onChange={setChosen}
      before={choices}
      row={(c) => {
        if (!audible(c)) return null;
        if (plan.kind === "version") {
          const variation = plan.variations.find((v) => v.key === c.key);
          return (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <Input
                size="sm"
                value={names[c.key] ?? variation?.name ?? ""}
                onChange={(e) => setNames((n) => ({ ...n, [c.key]: e.target.value }))}
                aria-label={`Variation name for ${c.name}`}
                className="w-48 min-w-0 flex-1 @3xl/app:flex-none"
              />
              <label className="flex cursor-pointer items-center gap-1.5 text-[13px] text-ink-2">
                <Radio
                  name="primary"
                  checked={variation?.primary ?? false}
                  onChange={() => setPrimary(c.key)}
                />
                Primary
              </label>
            </div>
          );
        }
        if (plan.kind === "tracks")
          return (
            <Input
              size="sm"
              value={names[c.key] ?? trackNameFrom(c.name)}
              onChange={(e) => setNames((n) => ({ ...n, [c.key]: e.target.value }))}
              aria-label={`Track name for ${c.name}`}
              className="w-72 max-w-full"
            />
          );
        const number = versionOf(c.key);
        return number === undefined ? null : (
          <span className="text-[12px] text-ink-3">Version {number}</span>
        );
      }}
      what={
        chosen.length > 0
          ? audio.length > 0
            ? describePlan(plan, folder, others)
            : describePlan({ kind: "files", count: chosen.length }, folder)
          : undefined
      }
      action={() =>
        audio.length > 0
          ? actionFor(plan, others)
          : actionFor({ kind: "files", count: chosen.length })
      }
      disabled={choice === "version" && !target}
      onSubmit={run}
      problem={versionProblem(can("edit_workflows"))}
    />
  );
}
