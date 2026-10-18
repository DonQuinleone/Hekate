import {
  type CommentExportOptions,
  type ExportTarget,
  type ExportTimeBase,
  exportChoices,
  exportComments,
  exportTargets,
  type FrameRateId,
  frameRates,
  type MediaInfo,
  nearestFrameRate,
  speakersOf,
  threadsForExport,
} from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Icon, type IconName } from "~/components/icons";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import { Field } from "~/components/ui/field";
import { Select } from "~/components/ui/input";
import { Dropdown, type MenuAction } from "~/components/ui/menu";
import { commentsQuery } from "~/lib/queries";

const scopes = {
  open: { label: "Open threads", threads: "open", replies: false },
  "open-replies": { label: "Open threads, with replies", threads: "open", replies: true },
  all: { label: "All threads", threads: "all", replies: false },
  "all-replies": { label: "All threads, with replies", threads: "all", replies: true },
} as const;
type Scope = keyof typeof scopes;

const timeBaseLabels: Record<ExportTimeBase, string> = {
  timecode: "Timecode from 00:00:00:00",
  "timecode-hour": "Timecode from 01:00:00:00",
  seconds: "Seconds from the file's start",
  samples: "Samples from the file's start",
};

/** Each application by its own mark (docs/brand.md, Icons); the open formats by theirs. */
const marks: Record<ExportTarget, IconName> = {
  "pro-tools": "protools",
  nuendo: "steinberg",
  reaper: "reaper",
  "final-cut-pro": "apple",
  resolve: "resolve",
  premiere: "premiere",
  avid: "avid",
  csv: "spreadsheet",
  text: "text",
};

/** The list, audio editors first, then video, then the open formats. */
const groups: ExportTarget[][] = [
  ["pro-tools", "nuendo", "reaper"],
  ["final-cut-pro", "resolve", "premiere", "avid"],
  ["csv", "text"],
];

/**
 * A mark at the text's height, centred in a slot wide enough for Avid's, which is a
 * wordmark and drawn a little lower, so the names line up.
 */
function Mark({ target }: { target: ExportTarget }) {
  return (
    <span className="flex w-8 shrink-0 justify-center text-ink-2">
      <Icon name={marks[target]} size={target === "avid" ? 9 : 14} />
    </span>
  );
}

/** Lines of the preview: enough to recognise the format, never the whole file. */
const PREVIEW_LINES = 6;

/**
 * A file's threads as a timed list for another application (#99): a DAW's or an NLE's
 * markers, a spreadsheet or a sheet to read. The preview is the file itself, written here
 * by the same code the server uses; the download comes from the server, which logs it.
 */
export function ExportCommentsDialog({
  file,
  onClose,
}: {
  file: { id: string; name: string; kind: string; mediaInfo: MediaInfo | null };
  onClose: () => void;
}) {
  const { data: comments } = useQuery(commentsQuery(file.id));
  const [target, setTarget] = useState<ExportTarget>("resolve");
  const [scope, setScope] = useState<Scope>("open");
  const [time, setTime] = useState<ExportTimeBase>("timecode-hour");
  const ownFps = file.mediaInfo?.video?.fps;
  const [rate, setRate] = useState<FrameRateId>(ownFps ? nearestFrameRate(ownFps) : "25");
  const [encoding, setEncoding] = useState<"utf-8" | "latin-1">("utf-8");
  const [done, setDone] = useState(false);

  const source = {
    name: file.name,
    duration: file.mediaInfo?.duration ?? null,
    sampleRate: file.mediaInfo?.audio?.sampleRate ?? null,
    fps: ownFps ?? null,
    video: file.kind === "video",
  };
  const choices = exportChoices(target, source);
  // A time base the target cannot write falls back to its first; MIDI has none.
  const shownTime = choices.timeBases.includes(time) ? time : choices.timeBases[0];
  const timecode = shownTime === "timecode" || shownTime === "timecode-hour";
  const options: CommentExportOptions = {
    target,
    threads: scopes[scope].threads,
    replies: scopes[scope].replies,
    time: shownTime ?? "timecode",
    rate,
    encoding,
  };
  // Channels by the recording's own speakers, as the server's download names them (#74).
  const audio = file.mediaInfo?.audio;
  const threads = comments
    ? threadsForExport(comments, audio && audio.channels >= 2 ? speakersOf(audio) : [])
    : [];
  const out = comments ? exportComments(threads, source, options) : null;
  const preview = out?.text?.split(/\r?\n/).filter(Boolean).slice(0, PREVIEW_LINES) ?? [];

  const query = new URLSearchParams({
    target,
    threads: options.threads,
    replies: String(options.replies),
    ...(shownTime ? { time: shownTime } : {}),
    ...(timecode ? { rate } : {}),
    ...(choices.encoding ? { encoding } : {}),
  });
  const href = `/api/files/${file.id}/comments/export?${query}`;
  const sheetHref = `/api/files/${file.id}/comments/sheet?${new URLSearchParams({
    threads: options.threads,
    replies: String(options.replies),
  })}`;
  const roots = threads.length;
  const empty = out !== null && out.written === 0;

  return (
    <Dialog
      title="Export comments"
      description={`${roots} ${roots === 1 ? "thread" : "threads"} on ${file.name}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {/* The same threads on paper (#134), whatever the application; made by the server. */}
          <Button variant="secondary" asChild>
            <a href={sheetHref} download>
              Printable sheet
            </a>
          </Button>
          {out && !empty ? (
            <Button variant="primary" asChild>
              <a href={href} download onClick={() => setDone(true)}>
                <Icon name="download" size={14} />
                {done ? "Exported" : "Export"}
              </a>
            </Button>
          ) : (
            <Button variant="primary" disabled>
              <Icon name="download" size={14} />
              Export
            </Button>
          )}
        </>
      }
    >
      <div className="grid gap-4 @md/app:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-1.5 text-[13px] text-ink-2">
          <span aria-hidden="true">For</span>
          <Dropdown
            variant="field"
            label="For"
            value={
              <>
                <Mark target={target} />
                <span className="truncate">{exportTargets[target].label}</span>
              </>
            }
            actions={groups.flatMap((group, i) => [
              ...(i > 0 ? (["divider"] as const) : []),
              ...group.map(
                (id): MenuAction => ({
                  label: exportTargets[id].label,
                  icon: <Mark target={id} />,
                  checked: id === target,
                  onSelect: () => {
                    setTarget(id);
                    setDone(false);
                  },
                }),
              ),
            ])}
          />
        </div>
        <Field label="Scope">
          <Select value={scope} onChange={(e) => setScope(e.target.value as Scope)}>
            {(Object.keys(scopes) as Scope[]).map((id) => (
              <option key={id} value={id}>
                {scopes[id].label}
              </option>
            ))}
          </Select>
        </Field>
        {shownTime ? (
          <Field label="Time base">
            <Select value={shownTime} onChange={(e) => setTime(e.target.value as ExportTimeBase)}>
              {choices.timeBases.map((t) => (
                <option key={t} value={t}>
                  {timeBaseLabels[t]}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        {timecode && (
          <Field
            label="Frame rate"
            hint={ownFps ? "The video's own, unless you choose another." : undefined}
          >
            <Select value={rate} onChange={(e) => setRate(e.target.value as FrameRateId)}>
              {(Object.keys(frameRates) as FrameRateId[]).map((id) => (
                <option key={id} value={id}>
                  {frameRates[id].label} fps
                </option>
              ))}
            </Select>
          </Field>
        )}
        {choices.encoding && (
          <Field label="Encoding">
            <Select
              value={encoding}
              onChange={(e) => setEncoding(e.target.value as "utf-8" | "latin-1")}
            >
              <option value="utf-8">UTF-8</option>
              <option value="latin-1">Latin-1 (older systems)</option>
            </Select>
          </Field>
        )}
      </div>
      <div className="mt-4 flex min-w-0 flex-col gap-1 rounded-panel border border-line bg-sunken p-3 text-[12px] text-ink-2">
        <span className="text-ink-3">Preview · {exportTargets[target].label}</span>
        {!out ? (
          <span className="text-ink-3">Loading</span>
        ) : empty ? (
          <span>
            Nothing to export: no {options.threads === "open" ? "open " : ""}threads
            {choices.untimed ? "" : " with a time"}.
          </span>
        ) : out.text === null ? (
          <span>
            A MIDI file with {out.written} {out.written === 1 ? "marker" : "markers"}, in seconds
            from the file's start.
          </span>
        ) : (
          preview.map((line, i) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: preview lines have no identity.
              key={i}
              className="truncate whitespace-pre font-mono"
            >
              {line}
            </span>
          ))
        )}
        {exportTargets[target].howTo && (
          <span className="text-ink-3">
            In {exportTargets[target].label}: {exportTargets[target].howTo}
          </span>
        )}
        {out && out.untimed > 0 && (
          <span className="text-ink-3">
            {out.untimed} {out.untimed === 1 ? "thread has" : "threads have"} no time and{" "}
            {out.untimed === 1 ? "is" : "are"} left out.
          </span>
        )}
      </div>
    </Dialog>
  );
}
