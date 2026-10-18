import { useState } from "react";
import { Icon, type IconName } from "~/components/icons";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import { Select } from "~/components/ui/input";
import { Dropdown, type MenuAction } from "~/components/ui/menu";
import { type Comment, categories, type File, personById } from "~/data";
import { cn } from "~/lib/cn";
import { formatClock } from "~/lib/format";

/** Audio editors, then video, then the open formats, each by its own mark. */
const groups: [string, IconName][][] = [
  [
    ["Pro Tools", "protools"],
    ["Nuendo", "steinberg"],
    ["Reaper", "reaper"],
  ],
  [
    ["Final Cut Pro", "apple"],
    ["DaVinci Resolve", "resolve"],
    ["Premiere Pro", "premiere"],
    ["Avid Media Composer", "avid"],
  ],
  [
    ["CSV", "spreadsheet"],
    ["Plain text", "text"],
  ],
];
const markOf = new Map(groups.flat());

/** A mark at the text's height, in a slot wide enough for Avid's wordmark. */
function Mark({ name }: { name: IconName }) {
  return (
    <span className="flex w-8 shrink-0 justify-center text-ink-2">
      <Icon name={name} size={name === "avid" ? 9 : 14} />
    </span>
  );
}

/** A version's comments as a timed list for a target application, or a printable sheet. */
export function ExportCommentsDialog({
  file,
  comments,
  onClose,
}: {
  file: File;
  comments: Comment[];
  onClose: () => void;
}) {
  const [target, setTarget] = useState("DaVinci Resolve");
  const [scope, setScope] = useState("open");
  const [time, setTime] = useState("tc-hour");
  const [done, setDone] = useState(false);
  const threads = comments.filter((c) => !c.parentId);
  const list = threads
    .filter((c) => c.anchor.kind === "time" && (scope.startsWith("all") || !c.resolved))
    .slice(0, 2);
  const midi = target === "Pro Tools";
  const xml = target === "Final Cut Pro" || target === "Premiere Pro";
  const free = target === "CSV" || target === "Plain text";
  const tc = (s: number) => {
    const f = Math.round(s * 25);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p((time === "tc-hour" ? 1 : 0) + Math.floor(f / 90000))}:${p(Math.floor(f / 1500) % 60)}:${p(Math.floor(f / 25) % 60)}:${p(f % 25)}`;
  };
  return (
    <Dialog
      title="Export comments"
      description={`${threads.length} threads on ${file.name}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="secondary">Printable sheet</Button>
          <Button variant="primary" onClick={() => setDone(true)}>
            <Icon name="download" size={14} />
            {done ? "Exported" : "Export"}
          </Button>
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
                <Mark name={markOf.get(target) ?? "file"} />
                <span className="truncate">{target}</span>
              </>
            }
            actions={groups.flatMap((group, i) => [
              ...(i > 0 ? (["divider"] as const) : []),
              ...group.map(
                ([label, mark]): MenuAction => ({
                  label,
                  icon: <Mark name={mark} />,
                  checked: label === target,
                  onSelect: () => setTarget(label),
                }),
              ),
            ])}
          />
        </div>
        <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
          Scope
          <Select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="open">Open threads</option>
            <option value="open-replies">Open threads, with replies</option>
            <option value="all">All threads</option>
            <option value="all-replies">All threads, with replies</option>
          </Select>
        </label>
        {!midi && (
          <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
            Time base
            <Select value={time} onChange={(e) => setTime(e.target.value)}>
              <option value="tc">Timecode from 00:00:00:00</option>
              <option value="tc-hour">Timecode from 01:00:00:00</option>
              {free && <option value="seconds">Seconds from the file's start</option>}
              {free && <option value="samples">Samples from the file's start</option>}
            </Select>
          </label>
        )}
        {!midi && time.startsWith("tc") && (
          <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
            Frame rate
            <Select defaultValue="25">
              {["23.976", "24", "25", "29.97", "29.97 drop", "30", "50", "59.94", "60"].map((r) => (
                <option key={r} value={r}>
                  {r} fps
                </option>
              ))}
            </Select>
          </label>
        )}
        {!xml && (
          <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
            Encoding
            <Select defaultValue="utf8">
              <option value="utf8">UTF-8</option>
              <option value="latin1">Latin-1 (older systems)</option>
            </Select>
          </label>
        )}
      </div>
      <div className="mt-4 flex min-w-0 flex-col gap-1 rounded-panel border border-line bg-sunken p-3 text-[12px] text-ink-2">
        <span className="text-ink-3">Preview · {target}</span>
        {midi ? (
          <span>A MIDI file with {list.length} markers, in seconds from the file's start.</span>
        ) : (
          list.map((c, i) => (
            <span key={c.id} className="truncate whitespace-pre font-mono">
              {String(i + 1).padStart(3, "0")}
              {"  "}
              {c.anchor.kind === "time" ? tc(c.anchor.start) : formatClock(0)}
              {"  "}
              {personById(c.authorId).name}: {c.body}
            </span>
          ))
        )}
        <span className="text-ink-3">
          Threads without a time are left out of marker lists; CSV and plain text keep them.
        </span>
      </div>
    </Dialog>
  );
}

/** A marker list from a DAW or an NLE, read back as comments with an author and a colour mapping. */
export function ImportCommentsDialog({ onClose }: { onClose: () => void }) {
  const [dropped, setDropped] = useState(false);
  const rows = [
    { time: "0:06.200", text: "pedal", colour: "Red", ok: true },
    { time: "0:17.600", text: "rubato keep", colour: "Green", ok: true },
    { time: "0:52.000", text: "??", colour: "Yellow", ok: false },
  ];
  return (
    <Dialog
      title="Import a marker list"
      description="Pro Tools, Nuendo, Reaper, Final Cut Pro, DaVinci Resolve, Premiere Pro, Avid, CSV or plain text."
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!dropped} onClick={onClose}>
            Import {rows.filter((r) => r.ok).length} comments
          </Button>
        </>
      }
    >
      {!dropped ? (
        <button
          type="button"
          onClick={() => setDropped(true)}
          className="flex w-full flex-col items-center gap-2 rounded-panel-lg border border-dashed border-line-strong px-6 py-10 text-center transition-colors hover:border-edge-strong hover:bg-raised/40"
        >
          <Icon name="upload" size={20} className="text-ink-3" />
          <span className="text-[14px] text-ink">Drop the marker list here, or choose it</span>
          <span className="text-[13px] text-ink-3">The format is read from the file.</span>
        </button>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-2 text-[13px] text-ink-2">
            <Icon name="file" size={14} className="text-ink-3" />
            Maple V2 markers.txt · Avid Media Composer markers · {rows.length} markers
          </div>
          <div className="grid gap-4 @md/app:grid-cols-2">
            <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
              Author
              <Select defaultValue="p-tomas">
                <option value="p-tomas">Tomas Varga</option>
                <option value="p-alex">Alex Rivera</option>
              </Select>
            </label>
            <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
              Anchor
              <Select defaultValue="time">
                <option value="time">At the marker's time</option>
                <option value="whole">Whole file</option>
              </Select>
            </label>
          </div>
          <div className="flex flex-col gap-1.5 text-[13px] text-ink-2">
            Colours become categories
            {["Red", "Green", "Yellow"].map((c, i) => (
              <span key={c} className="flex items-center gap-3">
                <span className="w-16 text-ink">{c}</span>
                <Select defaultValue={categories[i]?.id} className="w-48">
                  {categories.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
                  <option value="">No category</option>
                </Select>
              </span>
            ))}
          </div>
          <ul className="flex flex-col divide-y divide-line rounded-panel border border-line bg-sunken text-[12px]">
            {rows.map((r) => (
              <li
                key={r.time}
                className={cn("flex items-center gap-3 px-3 py-1.5", !r.ok && "text-signal")}
              >
                <span className="tabular w-16">{r.time}</span>
                <span className="flex-1 truncate text-ink-2">{r.text}</span>
                <span className="text-ink-3">{r.colour}</span>
                {!r.ok && <span>past the end of the file</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Dialog>
  );
}

/** The QA report, stamped with the project and the engineer. */
export function QaReportDialog({ file, onClose }: { file: File; onClose: () => void }) {
  const [format, setFormat] = useState<"pdf" | "csv" | "json">("pdf");
  return (
    <Dialog
      title="QA report"
      description={file.name}
      onClose={onClose}
      width="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={onClose}>
            <Icon name="download" size={14} />
            Download {format.toUpperCase()}
          </Button>
        </>
      }
    >
      <div className="flex gap-1">
        {(["pdf", "csv", "json"] as const).map((f) => (
          <button
            key={f}
            type="button"
            aria-pressed={format === f}
            onClick={() => setFormat(f)}
            className={cn(
              "h-9 flex-1 rounded-control border text-[13px] uppercase transition-colors",
              format === f
                ? "border-signal/60 bg-signal/10 text-ink"
                : "border-line text-ink-3 hover:text-ink",
            )}
          >
            {f}
          </button>
        ))}
      </div>
      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px]">
        <dt className="text-ink-3">Stamped with</dt>
        <dd className="text-ink">Endless Hall Records · Joplin Rags · Tomas Varga, Engineer</dd>
        <dt className="text-ink-3">Profile</dt>
        <dd className="text-ink">Apple Digital Masters</dd>
        <dt className="text-ink-3">Includes</dt>
        <dd className="text-ink">
          Findings, loudness and its history, format, embedded metadata, the version it was measured
          on
        </dd>
      </dl>
    </Dialog>
  );
}
