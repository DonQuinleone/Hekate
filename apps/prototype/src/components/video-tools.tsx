import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Icon, type IconName } from "~/components/icons";
import { Kbd } from "~/components/label";
import { MenuList, usePopover } from "~/components/ui/menu";
import { Switch } from "~/components/ui/toggle";
import type { File } from "~/data";
import { cn } from "~/lib/cn";
import { Frame } from "./video";

export type DrawTool = "select" | "box" | "circle" | "line" | "arrow" | "free" | "text";
const tools: { id: DrawTool; label: string; icon: IconName }[] = [
  { id: "select", label: "Select", icon: "pin" },
  { id: "box", label: "Box", icon: "grid" },
  { id: "circle", label: "Circle", icon: "record" },
  { id: "line", label: "Line", icon: "edit" },
  { id: "arrow", label: "Arrow", icon: "arrowRight" },
  { id: "free", label: "Freehand", icon: "pulse" },
  { id: "text", label: "Text", icon: "tag" },
];
const colours = ["var(--hk-signal)", "#e9e8e3", "#5ec2e6", "#8be58b"];

/** Drawing on the frame: the tool, the colour, undo. The drawing joins the comment being written. */
export function DrawToolbar({
  tool,
  onTool,
  colour,
  onColour,
  onClose,
}: {
  tool: DrawTool;
  onTool: (t: DrawTool) => void;
  colour: string;
  onColour: (c: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="rise-in absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-0.5 rounded-full bg-overlay p-1 shadow-3">
      {tools.map((t) => (
        <button
          key={t.id}
          type="button"
          aria-label={t.label}
          aria-pressed={tool === t.id}
          title={t.label}
          onClick={() => onTool(t.id)}
          className={cn(
            "flex size-8 items-center justify-center rounded-full transition-colors",
            tool === t.id ? "bg-raised text-ink" : "text-ink-2 hover:text-ink",
          )}
        >
          <Icon name={t.icon} size={14} />
        </button>
      ))}
      <span className="mx-1 h-5 w-px bg-line-strong" />
      {colours.map((c) => (
        <button
          key={c}
          type="button"
          aria-label="Colour"
          aria-pressed={colour === c}
          onClick={() => onColour(c)}
          className={cn(
            "flex size-8 items-center justify-center rounded-full",
            colour === c && "bg-raised",
          )}
        >
          <span className="size-3.5 rounded-full" style={{ background: c }} />
        </button>
      ))}
      <span className="mx-1 h-5 w-px bg-line-strong" />
      <button
        type="button"
        aria-label="Undo"
        className="flex size-8 items-center justify-center rounded-full text-ink-2 hover:text-ink"
      >
        <Icon name="back5" size={14} />
      </button>
      <button
        type="button"
        aria-label="Stop drawing"
        onClick={onClose}
        className="flex size-8 items-center justify-center rounded-full text-ink-2 hover:text-ink"
      >
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}

/** Mattes and safe areas over the frame. */
export function SafeAreas({ matte, safe }: { matte: "none" | "2.39" | "1.85"; safe: boolean }) {
  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden="true">
      {matte !== "none" && (
        <>
          <div
            className="absolute inset-x-0 top-0 bg-black/80"
            style={{ height: matte === "2.39" ? "12.5%" : "4%" }}
          />
          <div
            className="absolute inset-x-0 bottom-0 bg-black/80"
            style={{ height: matte === "2.39" ? "12.5%" : "4%" }}
          />
        </>
      )}
      {safe && (
        <>
          <div className="absolute inset-[5%] border border-paper/30" />
          <div className="absolute inset-[10%] border border-dashed border-paper/30" />
          <span className="absolute top-[5%] left-[5%] -translate-y-full text-[10px] text-paper/50">
            action safe
          </span>
          <span className="absolute top-[10%] left-[10%] -translate-y-full text-[10px] text-paper/50">
            title safe
          </span>
        </>
      )}
    </div>
  );
}

/** Two cuts over each other with a wipe, or side by side. */
export function CompareCuts({
  a,
  b,
  labels,
  compare,
  time,
  mode,
  onMode,
  onClose,
}: {
  a: File;
  b: File;
  /** "Cut 2", "Cut 3": each cut's name, laid on its picture. */
  labels: [string, string];
  /** The two cuts on the comparison page, where their comments and findings are (#137). */
  compare?: { trackId: string; a: number; b: number };
  time: number;
  mode: "wipe" | "side";
  onMode: (m: "wipe" | "side") => void;
  onClose: () => void;
}) {
  const [split, setSplit] = useState(0.5);
  return (
    <div className="flex flex-col gap-2">
      {mode === "side" ? (
        <div className="grid grid-cols-2 gap-2">
          <div className="relative">
            <Frame file={a} time={time} className="rounded-panel" />
            <CutLabel>{labels[0]}</CutLabel>
          </div>
          <div className="relative">
            <Frame file={b} time={time} className="rounded-panel" />
            <CutLabel>{labels[1]}</CutLabel>
          </div>
        </div>
      ) : (
        <div className="relative overflow-hidden rounded-panel">
          <Frame file={a} time={time} />
          <div className="absolute inset-0 overflow-hidden" style={{ width: `${split * 100}%` }}>
            <div style={{ width: `${100 / split}%` }}>
              <Frame file={b} time={time} />
            </div>
          </div>
          <div
            className="pointer-events-none absolute top-0 bottom-0 w-px bg-signal shadow-[0_0_8px_var(--hk-signal)]"
            style={{ left: `${split * 100}%` }}
          />
          <CutLabel>{labels[1]}</CutLabel>
          <CutLabel right>{labels[0]}</CutLabel>
        </div>
      )}
      <div className="flex items-center gap-3 text-[12px] text-ink-3">
        {/* Which cut is which, the labels on the frame say. */}
        <span className="font-medium text-ink">Compare cuts</span>
        {/* In the bar, not over the frame, which a click still plays and pauses. */}
        {mode === "wipe" && (
          <input
            type="range"
            min={0}
            max={1}
            step={0.005}
            value={split}
            onChange={(e) => setSplit(Number(e.target.value))}
            aria-label="Wipe"
            className="w-40"
          />
        )}
        <div
          role="radiogroup"
          className="ml-auto flex rounded-control border border-line bg-ground/60 p-0.5"
        >
          {(["wipe", "side"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              onClick={() => onMode(m)}
              className={cn(
                "h-6 rounded-[4px] px-2 text-[12px]",
                mode === m ? "bg-overlay text-ink shadow-2" : "text-ink-3 hover:text-ink",
              )}
            >
              {m === "wipe" ? "Wipe" : "Side by side"}
            </button>
          ))}
        </div>
        {compare && (
          <Link
            to="/tracks/$trackId/compare"
            params={{ trackId: compare.trackId }}
            search={{ a: String(compare.a), b: String(compare.b) }}
            className="hover:text-ink"
          >
            Comments and findings
          </Link>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="Stop comparing"
          title="Stop comparing"
          className="hover:text-ink"
        >
          <Icon name="close" size={14} />
        </button>
      </div>
    </div>
  );
}

function CutLabel({ children, right = false }: { children: string; right?: boolean }) {
  return (
    <span
      className={cn(
        "pointer-events-none absolute top-2 rounded-[4px] bg-ground/80 px-1.5 py-0.5 text-[12px] text-ink",
        right ? "right-2" : "left-2",
      )}
    >
      {children}
    </span>
  );
}

/** Go to a timecode, typed. */
export function GoTo({ onGo }: { onGo: (seconds: number) => void }) {
  const [open, setOpen, box] = usePopover();
  const [value, setValue] = useState("00:00:12:00");
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={cn(
          "flex h-8 items-center gap-1.5 rounded-control px-2.5 text-[13px] text-ink-2 transition-colors hover:bg-raised hover:text-ink",
          open && "bg-raised text-ink",
        )}
      >
        <Icon name="clock" size={14} />
        Go to
      </button>
      {open && (
        <form
          className="rise-in absolute right-0 z-30 mt-1 flex items-center gap-2 rounded-panel bg-overlay p-2 shadow-3"
          onSubmit={(e) => {
            e.preventDefault();
            const [h = 0, m = 0, s = 0, f = 0] = value.split(":").map(Number);
            onGo(h * 3600 + m * 60 + s + f / 25);
            setOpen(false);
          }}
        >
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-label="Timecode"
            className="tabular h-8 w-32 rounded-control border border-line bg-ground/60 px-2 text-[13px] text-ink focus:border-edge-strong focus:outline-none"
          />
          <Kbd>↵</Kbd>
        </form>
      )}
    </div>
  );
}

/**
 * The channels of a recording or a cut (#74): stereo, 5.1 or an Atmos bed, with solo and mute
 * per channel and a stereo downmix of anything wider. The button says what is changed.
 */
export function AudioLayoutMenu({ layout }: { layout: string }) {
  const [open, setOpen, box] = usePopover();
  const channels = layout.startsWith("5.1")
    ? ["L", "R", "C", "LFE", "Ls", "Rs"]
    : layout.toLowerCase().includes("atmos")
      ? ["L", "R", "C", "LFE", "Lss", "Rss", "Lrs", "Rrs", "Ltf", "Rtf"]
      : ["L", "R"];
  const [muted, setMuted] = useState<Set<string>>(new Set());
  const [solo, setSolo] = useState<string | null>(null);
  const [downmix, setDownmix] = useState(false);
  const [binaural, setBinaural] = useState(false);
  const heard = [
    solo ? `Solo ${solo}` : null,
    !solo && muted.size > 0 ? `${[...muted].join(", ")} muted` : null,
    binaural ? "binaural" : downmix ? "stereo downmix" : null,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={cn(
          "flex h-8 items-center gap-1.5 rounded-control px-2.5 text-[13px] text-ink-2 transition-colors hover:bg-raised hover:text-ink",
          open && "bg-raised text-ink",
        )}
      >
        <Icon name="volume" size={14} />
        Channels
        {heard && (
          <span className="text-signal">{heard.charAt(0).toUpperCase() + heard.slice(1)}</span>
        )}
      </button>
      {open && (
        <div className="rise-in absolute right-0 z-30 mt-1 flex w-64 flex-col gap-2 rounded-panel bg-overlay p-3 shadow-3">
          <span className="text-[13px] text-ink">Channels: {layout}</span>
          <ul className="flex flex-col gap-1">
            {channels.map((c) => (
              <li key={c} className="flex items-center gap-2 text-[13px] text-ink-2">
                <span className="w-10">{c}</span>
                <button
                  type="button"
                  aria-pressed={solo === c}
                  onClick={() => setSolo(solo === c ? null : c)}
                  className={cn(
                    "size-6 rounded-chip border text-[11px]",
                    solo === c ? "border-signal bg-signal text-ground" : "border-line text-ink-3",
                  )}
                >
                  S
                </button>
                <button
                  type="button"
                  aria-pressed={muted.has(c)}
                  onClick={() =>
                    setMuted((m) => {
                      const n = new Set(m);
                      if (n.has(c)) n.delete(c);
                      else n.add(c);
                      return n;
                    })
                  }
                  className={cn(
                    "size-6 rounded-chip border text-[11px]",
                    muted.has(c) ? "border-ink-3 bg-raised text-ink" : "border-line text-ink-3",
                  )}
                >
                  M
                </button>
                <span className="ml-auto h-1 w-16 overflow-hidden rounded-full bg-raised">
                  <span
                    className="block h-full bg-ink-2"
                    style={{ width: `${55 + ((c.length * 13) % 40)}%` }}
                  />
                </span>
              </li>
            ))}
          </ul>
          {channels.length > 2 && (
            <div className="flex items-center justify-between text-[13px] text-ink">
              Hear the stereo downmix
              <Switch
                label="Hear the stereo downmix"
                checked={downmix}
                onChange={(on) => {
                  setDownmix(on);
                  if (on) setBinaural(false);
                }}
              />
            </div>
          )}
          {channels.length > 2 && (
            <div className="flex items-center justify-between text-[13px] text-ink">
              Hear it binaurally, on headphones
              <Switch
                label="Hear it binaurally, on headphones"
                checked={binaural}
                onChange={(on) => {
                  setBinaural(on);
                  if (on) setDownmix(false);
                }}
              />
            </div>
          )}
          {heard && (
            <button
              type="button"
              onClick={() => {
                setSolo(null);
                setMuted(new Set());
                setDownmix(false);
                setBinaural(false);
              }}
              className="w-fit text-[13px] text-ink-3 hover:text-ink"
            >
              Hear it as recorded
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export { MenuList };
