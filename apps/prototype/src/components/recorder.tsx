import { useEffect, useState } from "react";
import { Button } from "~/components/ui/button";
import { Floating } from "~/components/ui/floating";
import { Input, Select } from "~/components/ui/input";
import { usePopover } from "~/components/ui/menu";
import { Switch } from "~/components/ui/toggle";
import { cn } from "~/lib/cn";

/**
 * The take log's recorder (#51, #450): one quiet control beside the log's status, opening the
 * connection's settings. The control-room browser reads the recorder live through one adapter
 * per kind of recorder; only the browser that connects one drives takes from it, and everyone
 * else sees the takes in the shared log. The prototype plays the states: not connected,
 * connected and reading, someone else driving, and a failure said plainly.
 */

type Kind = "daw-midi" | "sound-devices" | "ltc";

const kinds: { value: Kind; label: string }[] = [
  { value: "daw-midi", label: "A DAW, over MIDI" },
  { value: "sound-devices", label: "Sound Devices (8-Series, MixPre)" },
  { value: "ltc", label: "Another recorder's timecode out" },
];

const shortName: Record<Kind, string> = {
  "daw-midi": "DAW",
  "sound-devices": "Sound Devices",
  ltc: "Timecode",
};

type Trigger = "off" | "record" | "rolling";

export function RecorderControl() {
  const [open, setOpen, box] = usePopover();
  const [kind, setKind] = useState<Kind>("daw-midi");
  const [connected, setConnected] = useState(false);
  const [trigger, setTrigger] = useState<Trigger>("record");
  const [failed, setFailed] = useState<string | null>(null);
  /** Prototype only: someone else's browser drives takes from the recorder. */
  const [othersDrive, setOthersDrive] = useState(false);
  const [frames, setFrames] = useState(14 * 25);
  useEffect(() => {
    if (!connected) return;
    const id = setInterval(() => setFrames((f) => f + 1), 40);
    return () => clearInterval(id);
  }, [connected]);
  const tc = `11:02:${String(Math.floor(frames / 25) % 60).padStart(2, "0")}:${String(frames % 25).padStart(2, "0")}`;
  const midi = kind === "daw-midi";
  const label = connected
    ? `${shortName[kind]} · ${tc}`
    : othersDrive
      ? "Tomas drives the recorder"
      : "Recorder";
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={cn(
          "flex h-7 items-center gap-1.5 rounded-control px-2 text-[12px] text-ink-3 hover:bg-raised hover:text-ink",
          (open || connected) && "text-ink",
          open && "bg-raised",
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            "size-[7px] rounded-full",
            failed
              ? "border-[1.5px] border-signal"
              : connected || othersDrive
                ? "bg-ink-2"
                : "border-[1.5px] border-ink-3",
          )}
        />
        <span className="tabular">{label}</span>
      </button>
      {open && (
        <Floating
          anchor={box}
          align="end"
          side="bottom"
          onClose={() => setOpen(false)}
          role="dialog"
          aria-label="Recorder"
          data-e2e-overlap
          className="rise-in flex w-[340px] max-w-[calc(100vw-32px)] flex-col gap-3 rounded-panel-lg bg-overlay p-4 shadow-4"
        >
          <div className="flex flex-col gap-1">
            <span className="text-[14px] font-medium text-ink">Recorder</span>
            <p className="m-0 text-[13px] text-ink-3">
              Timecode in and out, and optionally each take's start and stop, read from the recorder
              by this browser. Everyone sees the takes in the log.
            </p>
          </div>
          {othersDrive && !connected && (
            <p className="m-0 rounded-control bg-raised/60 px-3 py-2 text-[13px] text-ink-2">
              Tomas Varga's browser drives takes from a DAW. Connecting here takes over from it.
            </p>
          )}
          <label className="flex flex-col gap-1 text-[12px] text-ink-3">
            Recorder
            <Select
              value={kind}
              disabled={connected}
              onChange={(e) => {
                setKind(e.target.value as Kind);
                setFailed(null);
                setTrigger(e.target.value === "daw-midi" ? "record" : "off");
              }}
              className="h-8 text-[13px]"
            >
              {kinds.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </Select>
          </label>
          {midi ? (
            <label className="flex flex-col gap-1 text-[12px] text-ink-3">
              MIDI input
              <Select defaultValue="iac" className="h-8 text-[13px]">
                <option value="iac">IAC Driver Bus 1</option>
                <option value="loop">loopMIDI Port</option>
              </Select>
            </label>
          ) : (
            <div className="grid grid-cols-[minmax(0,1fr)_96px] gap-2">
              <label className="flex min-w-0 flex-col gap-1 text-[12px] text-ink-3">
                Audio input
                <Select defaultValue="scarlett" className="h-8 text-[13px]">
                  <option value="scarlett">Scarlett 4i4 USB</option>
                  <option value="built-in">MacBook Pro Microphone</option>
                </Select>
              </label>
              <label className="flex flex-col gap-1 text-[12px] text-ink-3">
                Channel
                <Select defaultValue="2" className="h-8 text-[13px]">
                  <option value="1">1</option>
                  <option value="2">2</option>
                  <option value="3">3</option>
                  <option value="4">4</option>
                </Select>
              </label>
            </div>
          )}
          <label className="flex flex-col gap-1 text-[12px] text-ink-3">
            Start and stop takes
            <Select
              value={trigger}
              onChange={(e) => setTrigger(e.target.value as Trigger)}
              className="h-8 text-[13px]"
            >
              <option value="off">No, fill in timecode only</option>
              {midi && <option value="record">When the DAW records</option>}
              <option value="rolling">
                {midi ? "When the DAW rolls" : "When its timecode rolls (Rec Run)"}
              </option>
            </Select>
          </label>
          <p className="m-0 text-[12px] text-ink-3">
            {midi
              ? trigger === "record"
                ? "Reads the DAW's machine control, so the browser asks to allow MIDI system messages. Set the DAW to send MIDI timecode and MMC to this port. Safari has no Web MIDI: use Chrome, Edge or Firefox."
                : "Reads the DAW's MIDI timecode; the browser asks to allow MIDI. Safari has no Web MIDI: use Chrome, Edge or Firefox."
              : "Connect the recorder's timecode out to this input. A browser cannot read its take numbers: type them, or let the import match them."}
          </p>
          {failed && (
            <p role="alert" className="m-0 text-[13px] text-signal">
              {failed}
            </p>
          )}
          {connected && (
            <p role="status" className="m-0 flex items-center gap-2 text-[13px] text-ink-2">
              <span aria-hidden="true" className="breathe size-1.5 rounded-full bg-signal" />
              <span className="tabular">Reading {tc} at 25 fps</span>
            </p>
          )}
          <div className="flex items-center gap-2 border-t border-line pt-3">
            {connected ? (
              <Button size="sm" variant="secondary" onClick={() => setConnected(false)}>
                Disconnect
              </Button>
            ) : (
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  setFailed(null);
                  setOthersDrive(false);
                  setConnected(true);
                }}
              >
                {othersDrive ? "Take over" : "Connect"}
              </Button>
            )}
            {/* Prototype only: the states someone else's browser and a refusal bring. */}
            {!connected && (
              <span className="ml-auto flex gap-1">
                <Button size="sm" variant="quiet" onClick={() => setOthersDrive((on) => !on)}>
                  Another drives
                </Button>
                <Button
                  size="sm"
                  variant="quiet"
                  onClick={() =>
                    setFailed(
                      midi
                        ? "MIDI was not allowed. Allow it for this site in the browser's settings, then connect again."
                        : "The audio input was not allowed. Allow the microphone for this site in the browser's settings, then connect again.",
                    )
                  }
                >
                  Refused
                </Button>
              </span>
            )}
          </div>
        </Floating>
      )}
    </div>
  );
}

/**
 * Following the DAW in the player (#450): in the View menu, beside normalised playback. Playback
 * chases the DAW's MIDI timecode, less where the file starts on the DAW's timeline, moving only
 * past half a second, so a member leading a listening room can lead it from the DAW.
 */
export function FollowDaw() {
  const [on, setOn] = useState(false);
  const row = "flex items-center justify-between gap-4 text-[13px] text-ink";
  return (
    <div className="flex flex-col gap-2 border-t border-hairline pt-3">
      <div className={row}>
        <span>
          Follow the DAW
          <span className="block text-[12px] text-ink-3">Plays where its MIDI timecode is</span>
        </span>
        <Switch label="Follow the DAW" checked={on} onChange={setOn} />
      </div>
      {on && (
        <>
          <div className="grid grid-cols-[minmax(0,1fr)_112px] gap-2">
            <label className="flex min-w-0 flex-col gap-1 text-[12px] text-ink-3">
              MIDI input
              <Select defaultValue="iac" className="h-8 text-[13px]">
                <option value="iac">IAC Driver Bus 1</option>
                <option value="loop">loopMIDI Port</option>
              </Select>
            </label>
            <label className="flex flex-col gap-1 text-[12px] text-ink-3">
              File starts at
              <Input defaultValue="01:00:00:00" className="tabular h-8 text-[13px]" />
            </label>
          </div>
          <p role="status" className="m-0 text-[12px] text-ink-3">
            Waiting for timecode. Safari has no Web MIDI: use Chrome, Edge or Firefox.
          </p>
        </>
      )}
    </div>
  );
}
