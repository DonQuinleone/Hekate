import {
  chooseMix,
  formatBytes,
  formatDuration,
  type ImportProposal,
  importable,
  leaveOut,
  markImported,
  NAME_TOKENS,
  type ProposedTake,
  placeTakes,
  proposeTakeImport,
  renameSession,
  type SessionSummary,
  takeHeld,
} from "@hekate/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Icon } from "~/components/icons";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/choice";
import { Dialog } from "~/components/ui/dialog";
import { Field } from "~/components/ui/field";
import { Input, Select } from "~/components/ui/input";
import { type ChosenFile, UploadDialog } from "~/components/ui/upload-dialog";
import { cn } from "~/lib/cn";
import { formatDates } from "~/lib/locale";
import type { Picked } from "~/lib/picked-files";
import {
  projectSessionsQuery,
  projectTracksQuery,
  sessionQuery,
  type Track,
  useSessionMutations,
} from "~/lib/queries";
import { readSources } from "~/lib/take-import";
import { uploadFile } from "~/lib/upload";

const dayFormat = formatDates({ day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
/** "14 October 2026": a recorded day, the same in every time zone. */
const dayOf = (iso: string) => dayFormat.format(new Date(`${iso}T12:00:00Z`));

const count = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** Takes made at once, once their files are in. */
const BATCH = 20;
/** Files uploaded at once; each sends its chunks three at a time. */
const SENDING = 2;

const DEFAULT_PATTERN = "T{take} {mic}";

/** A take's line: its name, when it starts, how long, and how many files. */
function takeLine(take: ProposedTake) {
  return [
    take.label,
    take.timecode && !take.label.includes(take.timecode) ? take.timecode : null,
    take.length ? formatDuration(take.length) : null,
    count(take.files.length, "file"),
  ]
    .filter(Boolean)
    .join(" · ");
}

function TakeRow({
  take,
  tracks,
  selected,
  onSelect,
  onTrack,
  onMix,
}: {
  take: ProposedTake;
  tracks: Track[];
  selected: boolean;
  onSelect: (on: boolean) => void;
  onTrack: (trackId: string | null) => void;
  onMix: (fileKey: string) => void;
}) {
  const held = takeHeld(take);
  return (
    <li
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2 text-[13px]",
        (take.leftOut || take.imported) && "opacity-60",
      )}
    >
      <Checkbox
        checked={selected}
        onChange={(e) => onSelect(e.target.checked)}
        aria-label={`Select ${take.label}`}
      />
      <Icon name="take" size={13} className="shrink-0 text-ink-3" />
      <span className="min-w-0 flex-1 basis-48">
        <span className="block truncate text-ink">{takeLine(take)}</span>
        <span
          className={cn(
            "block truncate",
            held && !take.leftOut && !take.imported ? "text-signal" : "text-ink-3",
          )}
        >
          {held ??
            (take.chosen
              ? "Track chosen"
              : `${tracks.find((t) => t.id === take.trackId)?.name ?? ""}, ${Math.round(take.confidence * 100)}% sure`)}
        </span>
      </span>
      <span className="flex w-full gap-2 pl-[52px] @3xl/app:w-auto @3xl/app:pl-0">
        {take.files.length > 1 && (
          <Select
            size="sm"
            className="min-w-0 flex-1 @3xl/app:w-36 @3xl/app:flex-none"
            aria-label={`Mix of ${take.label}`}
            value={take.mix ?? ""}
            onChange={(e) => onMix(e.target.value)}
          >
            {!take.mix && <option value="">Which is the mix?</option>}
            {take.files.map((f) => (
              <option key={f.key} value={f.key}>
                {f.microphone ?? f.name}
              </option>
            ))}
          </Select>
        )}
        <Select
          size="sm"
          className="min-w-0 flex-1 @3xl/app:w-44 @3xl/app:flex-none"
          aria-label={`Track of ${take.label}`}
          value={take.trackId ?? ""}
          onChange={(e) => onTrack(e.target.value || null)}
        >
          <option value="">Choose a track</option>
          {tracks.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>
      </span>
    </li>
  );
}

interface Progress {
  done: number;
  total: number;
  failed: { label: string; message: string }[];
}

/**
 * Take import (#45): every file of a day's recording dropped at once, read here before anything
 * is sent, and the organisation proposed (sessions, takes by take number and timecode, each
 * take's mix, the track it is of) for someone to correct, with undo, before it is made. Each
 * take's mix is uploaded into its track's folder and made the track's next take, a batch at a
 * time, so an import stopped part way keeps what it made and can carry on.
 */
export function TakeImportDialog({
  projectId,
  onClose,
}: {
  projectId: string;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const { data: tracks = [] } = useQuery(projectTracksQuery(projectId));
  const { data: existing = [] } = useQuery(projectSessionsQuery(projectId));
  const { create, importTakes } = useSessionMutations(projectId);
  const [pattern, setPattern] = useState(DEFAULT_PATTERN);
  const [picked, setPicked] = useState<Picked[] | null>(null);
  const [reading, setReading] = useState<number | null>(null);
  const [read, setRead] = useState<Awaited<ReturnType<typeof readSources>> | null>(null);
  const [proposal, setProposal] = useState<ImportProposal | null>(null);
  const [history, setHistory] = useState<ImportProposal[]>([]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [progress, setProgress] = useState<Progress | null>(null);
  /** Null when nothing is being checked; empty while checking; else why it could not be. */
  const [checking, setChecking] = useState<string | null>(null);
  const [made, setMade] = useState<Set<string>>(new Set());
  const stopper = useRef(new AbortController());

  useEffect(
    () => () => {
      stopper.current.abort();
      choice.current?.abort();
    },
    [],
  );

  /** The latest choice of files: reading one that was replaced comes to nothing. */
  const choice = useRef<AbortController | null>(null);
  const choose = async (files: ChosenFile[]) => {
    choice.current?.abort();
    const list: Picked[] = files.flatMap((c) =>
      c.file ? [{ file: c.file, folder: c.folder }] : [],
    );
    if (list.length === 0) {
      setPicked(null);
      setRead(null);
      setReading(null);
      setChecking(null);
      return;
    }
    const mine = new AbortController();
    choice.current = mine;
    setPicked(list);
    setRead(null);
    setChecking(null);
    setReading(0);
    const found = await readSources(
      list,
      (done) => {
        if (!mine.signal.aborted) setReading(done);
      },
      mine.signal,
    );
    if (mine.signal.aborted) return;
    setRead(found);
    setReading(null);
  };

  const propose = async () => {
    if (!read) return;
    const proposed = proposeTakeImport(read.sources, {
      pattern,
      tracks,
      sessions: existing.map((s: SessionSummary) => ({
        id: s.id,
        name: s.name,
        recordedOn: s.recordedOn,
      })),
      dayName: dayOf,
    });
    // What a session already holds is not made again: an import carried on after a break.
    // Until that is known, nothing is proposed, so nothing can be made twice.
    const made = new Set<string>();
    setChecking("");
    try {
      for (const id of new Set(proposed.sessions.map((s) => s.sessionId))) {
        if (!id) continue;
        const session = await client.fetchQuery(sessionQuery(id));
        for (const row of session.takeRows) if (row.file) made.add(`${id}/${row.file.name}`);
      }
    } catch (failure) {
      setChecking(
        `The takes already in this project's sessions could not be checked: ${
          failure instanceof Error ? failure.message : "try again"
        }`,
      );
      return;
    }
    setChecking(null);
    setProposal(markImported(proposed, made));
    setHistory([]);
    setSelected(new Set());
  };

  const edit = (next: ImportProposal) => {
    if (!proposal) return;
    setHistory((h) => [...h, proposal]);
    setProposal(next);
  };
  const undo = () => {
    const last = history[history.length - 1];
    if (!last) return;
    setHistory((h) => h.slice(0, -1));
    setProposal(last);
  };

  const plan = proposal ? importable(proposal) : [];
  const toMake = plan.flatMap((s) => s.takes).filter((t) => !made.has(t.key));
  const importing = progress !== null && progress.done + progress.failed.length < progress.total;

  const run = async () => {
    if (!proposal || !read || toMake.length === 0) return;
    const signal = stopper.current.signal;
    setProgress({ done: 0, total: toMake.length, failed: [] });
    const fail = (take: ProposedTake, failure: unknown) =>
      setProgress(
        (p) =>
          p && {
            ...p,
            failed: [
              ...p.failed,
              {
                label: take.label,
                message: failure instanceof Error ? failure.message : "It could not be imported",
              },
            ],
          },
      );
    // New sessions first, each with the tracks its takes are of.
    const sessionIds = new Map<string, string>();
    for (const session of plan) {
      if (session.sessionId) {
        sessionIds.set(session.key, session.sessionId);
        continue;
      }
      if (!session.takes.some((t) => !made.has(t.key))) continue;
      try {
        const madeSession = await create.mutateAsync({
          name: session.name.trim() || "Imported takes",
          recordedOn: session.recordedOn,
          trackIds: [...new Set(session.takes.map((t) => t.trackId as string))],
        });
        sessionIds.set(session.key, madeSession.id);
        // Carrying on later adds to it, not to another of the same name.
        setProposal(
          (p) =>
            p && {
              ...p,
              sessions: p.sessions.map((s) =>
                s.key === session.key ? { ...s, sessionId: madeSession.id } : s,
              ),
            },
        );
      } catch (failure) {
        for (const take of session.takes) fail(take, failure);
      }
    }
    const queue = plan
      .flatMap((s) => s.takes.map((take) => ({ take, sessionId: sessionIds.get(s.key) })))
      .filter((q) => !made.has(q.take.key) && q.sessionId !== undefined);
    const ready: { take: ProposedTake; fileId: string; sessionId: string }[] = [];
    const flush = async () => {
      // Stopped: what is uploaded and not yet a take stays a file in its track's folder.
      if (signal.aborted) return;
      const batch = ready.splice(0, ready.length);
      if (batch.length === 0) return;
      try {
        await importTakes.mutateAsync({
          takes: batch.map((b) => ({
            fileId: b.fileId,
            trackId: b.take.trackId as string,
            sessionId: b.sessionId,
            label: b.take.label,
            // The number it was recorded as, so a take already logged is given its file (#51).
            take: b.take.take,
          })),
        });
        setMade((m) => new Set([...m, ...batch.map((b) => b.take.key)]));
        setProgress((p) => p && { ...p, done: p.done + batch.length });
      } catch (failure) {
        for (const b of batch) fail(b.take, failure);
      }
    };
    let next = 0;
    const send = async () => {
      while (next < queue.length && !signal.aborted) {
        const { take, sessionId } = queue[next] as (typeof queue)[number];
        next += 1;
        const file = take.mix ? read.files.get(take.mix) : undefined;
        const track = tracks.find((t) => t.id === take.trackId);
        if (!file || !track || !sessionId) {
          fail(take, new Error("Its mix is no longer there"));
          continue;
        }
        try {
          const sent = await uploadFile(file, {
            projectId,
            folderId: track.folderId,
            signal,
            onProgress: () => {},
          });
          ready.push({ take, fileId: sent.id, sessionId });
          if (ready.length >= BATCH) await flush();
        } catch (failure) {
          if (!signal.aborted) fail(take, failure);
        }
      }
    };
    await Promise.all(Array.from({ length: SENDING }, send));
    await flush();
  };

  const finished =
    progress !== null && !importing && progress.failed.length === 0 && toMake.length === 0;
  useEffect(() => {
    if (!finished || !proposal) return;
    const first = proposal.sessions.find((s) => s.sessionId)?.sessionId;
    onClose();
    if (first) void navigate({ to: "/sessions/$sessionId", params: { sessionId: first } });
  }, [finished, proposal, onClose, navigate]);

  const stop = () => {
    stopper.current.abort();
    stopper.current = new AbortController();
    onClose();
  };

  const total = picked?.reduce((n, p) => n + p.file.size, 0) ?? 0;
  const allKeys = proposal?.sessions.flatMap((s) => s.takes.map((t) => t.key)) ?? [];
  const someLeftOut = proposal?.sessions.some((s) =>
    s.takes.some((t) => selected.has(t.key) && t.leftOut),
  );

  const title = "Import takes";
  const description =
    "Drop every file of a session. Takes are grouped by take number and timecode, with their mix found among the microphones, and matched to tracks by name.";
  if (!proposal)
    return (
      <UploadDialog
        title={title}
        description={description}
        onClose={onClose}
        width="lg"
        inputLabel="Session files"
        folderLabel="Session folder"
        listLabel="Files of the session"
        prompt="Drop the session's files or folder here"
        hint="Or choose them. Only their headers are read until you import."
        multiple
        onChange={(files) => void choose(files)}
        fields={
          <Field
            label="File-name pattern"
            hint={`Read where the files carry no iXML: ${NAME_TOKENS.map((t) => `{${t}}`).join(", ")}, and * for anything.`}
          >
            <Input value={pattern} onChange={(e) => setPattern(e.target.value)} />
          </Field>
        }
        what={
          picked &&
          (reading !== null
            ? `Reading ${reading.toLocaleString()} of ${count(picked.length, "file")}.`
            : `${count(picked.length, "file")}, ${formatBytes(total)}. Their headers are read here; nothing is uploaded until the takes are imported.`)
        }
        error={checking || null}
        action="Propose the takes"
        disabled={!read || reading !== null || checking === ""}
        onSubmit={propose}
      />
    );
  return (
    <Dialog
      title={title}
      description={description}
      onClose={importing ? stop : onClose}
      width="lg"
      footer={
        <>
          <Button variant="ghost" onClick={importing ? stop : onClose}>
            {importing ? "Stop" : "Cancel"}
          </Button>
          {!importing && (
            <Button variant="secondary" onClick={undo} disabled={history.length === 0}>
              Undo
            </Button>
          )}
          <Button
            variant="primary"
            onClick={() => void run()}
            disabled={importing || toMake.length === 0}
          >
            {importing
              ? "Importing"
              : progress && made.size > 0
                ? `Import the other ${count(toMake.length, "take")}`
                : toMake.length === 0
                  ? "Import"
                  : `Import ${count(toMake.length, "take")}`}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {progress && (
          <div
            role="status"
            className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[13px] text-ink-2"
          >
            {importing && <span className="breathe size-2 rounded-full border border-ink-2" />}
            <span>
              {importing
                ? `Importing: ${progress.done.toLocaleString()} of ${count(progress.total, "take")}`
                : `Imported ${count(progress.done, "take")}`}
              {progress.failed.length > 0 && `; ${progress.failed.length} could not be`}
            </span>
            <span className="ml-auto h-1 w-40 overflow-hidden rounded-full bg-raised">
              <span
                className="block h-full bg-ink-2 transition-[width]"
                style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }}
              />
            </span>
          </div>
        )}
        {progress && progress.failed.length > 0 && !importing && (
          <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[13px] text-signal">
            {progress.failed.map((f) => (
              <li key={f.label}>
                {f.label}: {f.message}
              </li>
            ))}
          </ul>
        )}
        {proposal.sessions.length === 0 ? (
          <p className="m-0 text-[13px] text-ink-2">
            Nothing here makes a take: no file has a take number or a timecode.
          </p>
        ) : (
          <div className="flex min-h-9 flex-wrap items-center gap-2 text-[13px] text-ink-3">
            <Checkbox
              aria-label="Select every take"
              checked={selected.size > 0 && selected.size === allKeys.length}
              onChange={(e) => setSelected(new Set(e.target.checked ? allKeys : []))}
            />
            <span className="mr-auto">
              {selected.size > 0
                ? `${selected.size} selected`
                : `${count(allKeys.length, "take")} in ${count(proposal.sessions.length, "session")}`}
            </span>
            {selected.size > 0 && (
              <>
                <Select
                  size="sm"
                  className="w-44"
                  aria-label="Put the selected takes on a track"
                  value=""
                  onChange={(e) => {
                    if (e.target.value) edit(placeTakes(proposal, selected, e.target.value));
                  }}
                >
                  <option value="">Put on a track</option>
                  {tracks.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => edit(leaveOut(proposal, selected, !someLeftOut))}
                >
                  {someLeftOut ? "Bring back" : "Leave out"}
                </Button>
              </>
            )}
          </div>
        )}
        {proposal.sessions.map((s) => (
          <section key={s.key} aria-label={s.name} className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <Icon name="mic" size={14} className="text-ink-3" />
              {s.sessionId && existing.some((e) => e.id === s.sessionId) ? (
                <span className="text-[14px] text-ink">{s.name}</span>
              ) : (
                <Input
                  size="sm"
                  className="w-56"
                  aria-label="Session name"
                  value={s.name}
                  onChange={(e) => edit(renameSession(proposal, s.key, e.target.value))}
                />
              )}
              <span className="text-[13px] text-ink-3">
                {[
                  s.recordedOn && dayOf(s.recordedOn) !== s.name.trim()
                    ? dayOf(s.recordedOn)
                    : null,
                  s.sessionId && existing.some((e) => e.id === s.sessionId)
                    ? "adds to this session"
                    : "a new session",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </div>
            <ul className="m-0 ml-5 flex list-none flex-col divide-y divide-line rounded-panel border border-line bg-sunken p-0">
              {s.takes.map((t) => (
                <TakeRow
                  key={t.key}
                  take={t}
                  tracks={tracks}
                  selected={selected.has(t.key)}
                  onSelect={(on) =>
                    setSelected((was) => {
                      const next = new Set(was);
                      if (on) next.add(t.key);
                      else next.delete(t.key);
                      return next;
                    })
                  }
                  onTrack={(trackId) => edit(placeTakes(proposal, new Set([t.key]), trackId))}
                  onMix={(key) => edit(chooseMix(proposal, t.key, key))}
                />
              ))}
            </ul>
          </section>
        ))}
        {proposal.unplaced.length > 0 && (
          <p className="m-0 text-[12px] text-ink-3">
            {proposal.unplaced.length === 1
              ? "1 file is left out: "
              : `${count(proposal.unplaced.length, "file")} are left out: `}
            {proposal.unplaced
              .slice(0, 3)
              .map((u) => `“${u.name}” ${u.reason}`)
              .join("; ")}
            {proposal.unplaced.length > 3 && `; and ${proposal.unplaced.length - 3} more`}.
          </p>
        )}
        <p className="m-0 text-[12px] text-ink-3">
          Each take brings its mix, uploaded into its track's folder; its other microphones stay
          where they are for now.
        </p>
      </div>
    </Dialog>
  );
}
