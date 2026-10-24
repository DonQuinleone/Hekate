import { useState } from "react";
import { Avatar } from "~/components/avatar";
import { Icon } from "~/components/icons";
import { Label } from "~/components/label";
import { Seg } from "~/components/player/transport";
import { Property } from "~/components/property";
import { Dot } from "~/components/status";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import { Input, Select } from "~/components/ui/input";
import { ActionMenu } from "~/components/ui/menu";
import {
  accessLog,
  captionFormatNames,
  captionKindNames,
  captionTracksFor,
  type File,
  personById,
} from "~/data";
import { cn } from "~/lib/cn";
import { fileDetails } from "~/lib/files";
import { formatBytes, formatDateTime } from "~/lib/format";

/**
 * A video's or a recording's caption tracks (#146, #201): each named for the Captions menu,
 * with what it is for, its language and the format it came as; renamed, exported or removed
 * from its row's menu, and added from a sidecar by whoever may upload.
 */
function CaptionTracks({ file }: { file: File }) {
  const tracks = captionTracksFor(file.id);
  const [adding, setAdding] = useState(false);
  return (
    <section className="flex flex-col gap-1.5">
      <Label>Captions</Label>
      {tracks.length === 0 && (
        <span className="text-[12px] text-ink-3">
          None yet. Add SubRip, WebVTT or TTML files: each is a track in the player's Captions menu
          and a transcript beside the comments.
        </span>
      )}
      <ul className="flex flex-col">
        {tracks.map((t) => (
          <li key={t.id} className="group flex h-8 items-center gap-2 text-[13px]">
            <span className="shrink-0 text-ink">{t.label}</span>
            <span className="min-w-0 flex-1 truncate text-ink-3">
              {captionKindNames[t.kind]} · {captionFormatNames[t.format]} · {t.cues.length} captions
            </span>
            <ActionMenu
              label={t.label}
              actions={[
                { label: "Rename…", onSelect: () => {} },
                { label: "Export as SubRip (.srt)", onSelect: () => {} },
                { label: "Export as WebVTT (.vtt)", onSelect: () => {} },
                { label: "Export as TTML (.ttml)", onSelect: () => {} },
                "divider",
                { label: "Remove", danger: true, onSelect: () => {} },
              ]}
            />
          </li>
        ))}
      </ul>
      <div>
        <Button variant="secondary" size="sm" onClick={() => setAdding(true)}>
          Add captions…
        </Button>
      </div>
      {adding && <AddCaptionsDialog onClose={() => setAdding(false)} />}
    </section>
  );
}

/**
 * Adding a caption track: the file first, then what the menu calls it. Its language and what
 * it is for are read from the file where it says (`.fr.`, `.sdh.`, WebVTT's header, TTML's
 * `xml:lang`) and can be changed before it is added.
 */
function AddCaptionsDialog({ onClose }: { onClose: () => void }) {
  const [language, setLanguage] = useState("fr");
  const [kind, setKind] = useState<"subtitles" | "captions">("subtitles");
  const [label, setLabel] = useState("French");
  return (
    <Dialog
      title="Add captions"
      description="A SubRip (.srt), WebVTT (.vtt) or TTML (.ttml) file, at most 2 MB."
      onClose={onClose}
      width="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onClose}>Add captions</Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex h-10 items-center gap-2 rounded-control border border-line px-3 text-[13px]">
          <Icon name="file" size={14} className="text-ink-3" />
          <span className="min-w-0 flex-1 truncate text-ink">Opening titles.fr.vtt</span>
          <span className="text-ink-3">WebVTT · 18 captions</span>
        </div>
        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] text-ink-2">Language</span>
          <Select value={language} onChange={(e) => setLanguage(e.target.value)}>
            <option value="">Not said</option>
            <option value="en">English</option>
            <option value="fr">French</option>
            <option value="de">German</option>
            <option value="es">Spanish</option>
          </Select>
        </label>
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] text-ink-2">For</span>
          <Seg
            label="What the track is for"
            size="md"
            value={kind}
            onChange={setKind}
            options={[
              { id: "subtitles", label: "Subtitles" },
              { id: "captions", label: "Captions (SDH)" },
            ]}
          />
          <span className="text-[12px] text-ink-3">
            {kind === "subtitles"
              ? "The words, for viewers who hear them."
              : "The words and the sounds, for viewers who are deaf or hard of hearing."}
          </span>
        </div>
        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] text-ink-2">Name in the Captions menu</span>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} />
        </label>
      </div>
    </Dialog>
  );
}

/** What the server knows about a file, and who has touched it. */
export function FileDetailsSheet({ file, onClose }: { file: File; onClose: () => void }) {
  const log = accessLog.filter((e) => e.fileId === file.id);
  const renditions =
    file.kind === "audio"
      ? [
          "HLS, AAC 256 kb/s, encrypted segments",
          "Peaks, 1 ms resolution",
          file.media.channels && file.media.channels > 2 ? "Stereo downmix for the player" : null,
        ]
      : file.kind === "video"
        ? [
            "HLS, H.264 1080p and 540p, encrypted",
            "HLS, AV1 1080p (royalty-free)",
            "Filmstrip, 12 frames",
            "Audio peaks",
          ]
        : file.kind === "document" || file.kind === "image"
          ? [`${file.media.pages ?? 1} pages at 1600 px, watermarked on render`]
          : ["None: served for download only"];
  return (
    <div className="absolute inset-y-0 right-0 z-30 flex w-full max-w-[380px] flex-col border-l border-line bg-overlay shadow-4">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
        <h2 className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">Details</h2>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="flex size-8 items-center justify-center rounded-control text-ink-3 hover:bg-raised hover:text-ink"
        >
          <Icon name="close" size={14} />
        </button>
      </div>
      <div className="scroll-quiet flex min-h-0 flex-1 flex-col gap-5 overflow-auto p-4">
        <section className="flex flex-col gap-0.5">
          <Property name="Name">
            <span className="truncate">{file.name}</span>
          </Property>
          <Property name="Format">{fileDetails(file)}</Property>
          <Property name="Size">{formatBytes(file.size)}</Property>
          <Property name="Checksum">
            <span className="tabular truncate text-ink-2">sha256 · 9f3c…e21a</span>
          </Property>
          <Property name="Uploaded">
            <Avatar personId={file.uploadedBy} size={18} />
            {personById(file.uploadedBy).name}, {formatDateTime(file.uploadedAt)}
          </Property>
          <Property name="Storage">Hetzner Object Storage (S3)</Property>
          <Property name="At rest">
            <Dot state="approved" />
            Encrypted, key k-3f1a, rotated 2 Oct
          </Property>
          <Property name="Analysis">
            {file.state === "ready" ? (
              <>
                <Dot state="passed" />
                Done
              </>
            ) : file.state === "pending" ? (
              <>
                <Dot state="working" />
                Running
              </>
            ) : (
              <>
                <Dot state="changes_requested" />
                Failed
              </>
            )}
          </Property>
        </section>
        <section className="flex flex-col gap-1.5">
          <Label>Renditions</Label>
          {renditions.filter(Boolean).map((r) => (
            <span key={r} className="text-[13px] text-ink-2">
              {r}
            </span>
          ))}
          <span className="text-[12px] text-ink-3">
            The original never leaves storage except through a permitted, watermarked download.
          </span>
        </section>
        {(file.kind === "video" || file.kind === "audio") && <CaptionTracks file={file} />}
        <section className="flex flex-col gap-1.5">
          <Label>Access · {log.length}</Label>
          {log.map((e) => (
            <span key={e.id} className="flex items-center gap-2 text-[12px] text-ink-3">
              <span className="tabular w-[92px] shrink-0">{formatDateTime(e.at)}</span>
              <span className="truncate text-ink-2">
                {e.personId ? personById(e.personId).name : "Someone"}
                {e.guest ? " (guest)" : ""}
              </span>
              <span className="ml-auto shrink-0">{e.action}</span>
            </span>
          ))}
          {log.length === 0 && <span className="text-[12px] text-ink-3">Nothing logged yet.</span>}
        </section>
      </div>
    </div>
  );
}

/** The download permission at work: what you get, and that it is marked and logged. */
export function DownloadDialog({
  file,
  allowed,
  onClose,
}: {
  file: File;
  allowed: "proxy" | "original";
  onClose: () => void;
}) {
  const [which, setWhich] = useState<"proxy" | "original">(
    allowed === "original" ? "original" : "proxy",
  );
  const [done, setDone] = useState(false);
  return (
    <Dialog
      title="Download"
      description={file.name}
      onClose={onClose}
      width="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => setDone(true)}>
            <Icon name="download" size={14} />
            {done ? "Preparing…" : "Download"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-1.5">
        {(["proxy", "original"] as const).map((w) => {
          const can = w === "proxy" || allowed === "original";
          return (
            <button
              key={w}
              type="button"
              disabled={!can}
              aria-pressed={which === w}
              onClick={() => setWhich(w)}
              className={cn(
                "flex flex-col rounded-panel border px-3 py-2.5 text-left transition-colors",
                which === w ? "border-signal/60 bg-signal/10" : "border-line hover:border-edge",
                !can && "cursor-not-allowed opacity-50",
              )}
            >
              <span className="text-[14px] text-ink">{w === "proxy" ? "Proxy" : "Original"}</span>
              <span className="text-[13px] text-ink-3">
                {w === "proxy"
                  ? file.kind === "video"
                    ? "H.264 1080p, AAC"
                    : "AAC 256 kb/s"
                  : `${fileDetails(file)}, ${formatBytes(file.size)}`}
                {!can && " · not in your permissions"}
              </span>
            </button>
          );
        })}
      </div>
      <p className="mt-3 text-[12px] text-ink-3">
        Marked for you, invisibly and inaudibly, and written to the access log.
      </p>
    </Dialog>
  );
}
