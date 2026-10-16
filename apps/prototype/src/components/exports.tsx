import { useState } from "react";
import { Icon } from "~/components/icons";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import { Select } from "~/components/ui/input";
import { type Comment, categories, type File, personById } from "~/data";
import { cn } from "~/lib/cn";
import { formatClock } from "~/lib/format";

const targets = [
  "Pyramix",
  "SADiE",
  "Pro Tools",
  "Sequoia",
  "Nuendo",
  "Reaper",
  "Final Cut Pro",
  "DaVinci Resolve",
  "Premiere Pro",
  "Avid Media Composer",
  "CSV",
  "Plain text",
];

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
  const [target, setTarget] = useState("Pyramix");
  const [scope, setScope] = useState("version");
  const [done, setDone] = useState(false);
  const list = comments.filter((c) => !c.parentId).slice(0, 3);
  return (
    <Dialog
      title="Export comments"
      description={`${comments.filter((c) => !c.parentId).length} threads on ${file.name}`}
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
        <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
          For
          <Select value={target} onChange={(e) => setTarget(e.target.value)}>
            {targets.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
          Scope
          <Select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="version">This version</option>
            <option value="open">Open only</option>
            <option value="category">By category…</option>
            <option value="replies">With replies</option>
            <option value="all">All versions</option>
          </Select>
        </label>
        <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
          Encoding
          <Select defaultValue="utf8">
            <option value="utf8">UTF-8</option>
            <option value="latin1">Latin-1 (older Pyramix)</option>
          </Select>
        </label>
        <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
          Time base
          <Select defaultValue="tc">
            <option value="tc">Timecode from the file's start</option>
            <option value="samples">Samples</option>
            <option value="bars">Bars, where typed</option>
          </Select>
        </label>
      </div>
      <div className="mt-4 flex flex-col gap-1 rounded-panel border border-line bg-sunken p-3 text-[12px] text-ink-2">
        <span className="text-ink-3">Preview · {target}</span>
        {list.map((c, i) => (
          <span key={c.id} className="tabular truncate">
            {String(i + 1).padStart(3, "0")}{" "}
            {c.anchor.kind === "time" ? formatClock(c.anchor.start) : "00:00.000"} [
            {categories.find((x) => x.id === c.categoryId)?.name ?? "—"}]{" "}
            {personById(c.authorId).name.split(" ")[0]}: {c.body}
          </span>
        ))}
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
      description="Pyramix, SADiE, Pro Tools, Sequoia, Nuendo, Reaper, Final Cut Pro, DaVinci Resolve, Premiere Pro, Avid, CSV or plain text."
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
            Maple V2 markers.txt · Pyramix marker list · {rows.length} rows
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
