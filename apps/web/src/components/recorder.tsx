import {
  frameRates,
  type RecorderStatus,
  type TakeTrigger,
  timecodeLabel,
  timecodeNow,
} from "@hekate/shared";
import { useEffect, useId, useState } from "react";
import { Button } from "~/components/ui/button";
import { Floating } from "~/components/ui/floating";
import { Select } from "~/components/ui/input";
import { usePopover } from "~/components/ui/menu";
import { cn } from "~/lib/cn";
import {
  defaultRecorderOptions,
  type RecorderInput,
  type RecorderOptions,
} from "~/lib/recorders/adapter";
import { useRecorder } from "~/lib/recorders/provider";
import { recorderDefinition, recorderDefinitions } from "~/lib/recorders/registry";
import { listening, type RecorderDrive } from "~/lib/recorders/take-driver";

/** The present, again every so often, for a timecode readout to play on between positions. */
export function useTicking(on: boolean, every = 40) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const id = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(id);
  }, [on, every]);
  return now;
}

/** The channels of an audio input offered for the timecode, from 0. */
const CHANNELS = [0, 1, 2, 3, 4, 5, 6, 7];

const firstName = (name: string) => name.split(/\s+/)[0] ?? name;

/** The recorder's timecode now, and its rate, as words; null before it has said. */
export function useRecorderReadout(): { timecode: string; rate: string } | null {
  const recorder = useRecorder();
  const position = recorder?.position ?? null;
  const now = useTicking(Boolean(position?.rolling));
  if (!recorder || !position || !listening(recorder.status)) return null;
  return {
    timecode: timecodeLabel(timecodeNow(position, now)),
    rate: frameRates[position.timecode.rate].label,
  };
}

/** The devices a kind of recorder could listen to, read again whenever it connects. */
function useInputs(kind: string, connectedState: string): RecorderInput[] {
  const [inputs, setInputs] = useState<RecorderInput[]>([]);
  useEffect(() => {
    let live = true;
    void connectedState;
    void recorderDefinition(kind)
      ?.inputs()
      .then((found) => {
        if (live) setInputs(found);
      });
    return () => {
      live = false;
    };
  }, [kind, connectedState]);
  return inputs;
}

/** What the status says, for the line under the choices. */
const statusWords = (status: RecorderStatus) =>
  status.state === "silent" ? status.detail : status.state === "connecting" ? "Connecting…" : null;

/**
 * The take log's recorder (#51, decision 240), as the prototype draws it: one quiet control
 * beside the log's status, opening the connection's settings. Only the browser that connects
 * a recorder drives takes from it; the others see who does.
 */
export function RecorderControl({ drive, canLog }: { drive: RecorderDrive; canLog: boolean }) {
  const recorder = useRecorder();
  const [open, setOpen, box] = usePopover();
  const readout = useRecorderReadout();
  const remembered = recorder?.remembered ?? null;
  const [kind, setKind] = useState(
    recorder?.kind ?? remembered?.kind ?? recorderDefinitions[0]?.kind ?? "",
  );
  const [chosen, setOptions] = useState<RecorderOptions>(
    recorder?.kind ? recorder.options : (remembered?.options ?? defaultRecorderOptions),
  );
  const status = recorder?.status ?? { state: "idle" };
  const connected = Boolean(recorder?.kind) && listening(status);
  // Connected (here, or from the player), the connection's own choices are the ones shown.
  const current = connected && recorder?.kind ? recorder.kind : kind;
  const options = connected && recorder ? recorder.options : chosen;
  const definition = recorderDefinition(current);
  const inputs = useInputs(current, status.state);
  const labelId = useId();
  if (!recorder || !definition) return null;
  const others = drive.others;
  // Someone who may not log takes sees who drives the recorder, and nothing to change.
  if (!canLog)
    return others ? (
      <span className="flex items-center gap-1.5 text-[12px] text-ink-3">
        <span aria-hidden="true" className="size-[7px] rounded-full bg-ink-3" />
        {firstName(others.by.name)} drives the recorder
      </span>
    ) : null;
  const failed = status.state === "failed" ? status.reason : null;
  const unsupported = definition.unsupported();
  const triggers = definition.triggers;
  const trigger: TakeTrigger = triggers.includes(options.trigger) ? options.trigger : "off";
  const choose = (next: string) => {
    setKind(next);
    const def = recorderDefinition(next);
    const keep =
      remembered?.kind === next ? remembered.options : { ...defaultRecorderOptions, channel: 0 };
    setOptions({ ...keep, trigger: def?.triggers.includes(keep.trigger) ? keep.trigger : "off" });
  };
  const connect = (next: RecorderOptions) => void recorder.connect(current, { ...next, trigger });
  const label = connected
    ? `${definition.short}${readout ? ` · ${readout.timecode}` : ""}`
    : others
      ? `${firstName(others.by.name)} drives the recorder`
      : "Recorder";
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={cn(
          "flex h-7 cursor-pointer items-center gap-1.5 rounded-control border-0 bg-transparent px-2 text-[12px] text-ink-3 hover:bg-raised hover:text-ink",
          (open || connected) && "text-ink",
          open && "bg-raised",
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            "size-[7px] rounded-full",
            failed || drive.lost
              ? "border-[1.5px] border-signal"
              : connected || others
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
          aria-labelledby={labelId}
          data-e2e-overlap
          className="rise-in flex w-[340px] max-w-[calc(100vw-32px)] flex-col gap-3 rounded-panel-lg bg-overlay p-4 shadow-4"
        >
          <div className="flex flex-col gap-1">
            <span id={labelId} className="text-[14px] font-medium text-ink">
              Recorder
            </span>
            <p className="m-0 text-[13px] text-ink-3">
              Timecode in and out, and optionally each take's start and stop, read from the recorder
              by this browser. Everyone sees the takes in the log.
            </p>
          </div>
          {others && !connected && (
            <p className="m-0 rounded-control bg-raised/60 px-3 py-2 text-[13px] text-ink-2">
              {others.by.name}'s browser drives takes from{" "}
              {recorderDefinition(others.kind)?.label.replace(/^A /, "a ") ?? "a recorder"}.
              Connecting here takes over from it.
            </p>
          )}
          {drive.lost && !connected && (
            <p role="alert" className="m-0 text-[13px] text-signal">
              {drive.lost}
            </p>
          )}
          <label className="flex flex-col gap-1 text-[12px] text-ink-3">
            Recorder
            <Select
              size="sm"
              value={definition.kind}
              disabled={connected}
              onChange={(e) => choose(e.target.value)}
            >
              {recorderDefinitions.map((d) => (
                <option key={d.kind} value={d.kind}>
                  {d.label}
                </option>
              ))}
            </Select>
          </label>
          {unsupported ? (
            <p role="alert" className="m-0 text-[13px] text-signal">
              {unsupported}
            </p>
          ) : (
            <>
              <div
                className={cn(
                  "grid gap-2",
                  definition.channels ? "grid-cols-[minmax(0,1fr)_88px]" : "grid-cols-1",
                )}
              >
                <label className="flex min-w-0 flex-col gap-1 text-[12px] text-ink-3">
                  {definition.inputLabel}
                  <Select
                    size="sm"
                    value={options.input ?? ""}
                    onChange={(e) => {
                      const next = { ...options, input: e.target.value || null };
                      setOptions(next);
                      // A new input, connected already: listen to that one instead.
                      if (connected) connect(next);
                    }}
                  >
                    <option value="">
                      {inputs.length === 0
                        ? definition.channels
                          ? "This computer's default input"
                          : "The first MIDI input"
                        : "The first one"}
                    </option>
                    {inputs.map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.label}
                      </option>
                    ))}
                  </Select>
                </label>
                {definition.channels && (
                  <label className="flex flex-col gap-1 text-[12px] text-ink-3">
                    Channel
                    <Select
                      size="sm"
                      value={String(options.channel)}
                      disabled={connected}
                      onChange={(e) => setOptions({ ...options, channel: Number(e.target.value) })}
                    >
                      {CHANNELS.map((c) => (
                        <option key={c} value={String(c)}>
                          {c + 1}
                        </option>
                      ))}
                    </Select>
                  </label>
                )}
              </div>
              <label className="flex flex-col gap-1 text-[12px] text-ink-3">
                Start and stop takes
                <Select
                  size="sm"
                  value={trigger}
                  disabled={connected}
                  onChange={(e) =>
                    setOptions({ ...options, trigger: e.target.value as TakeTrigger })
                  }
                >
                  {triggers.map((t) => (
                    <option key={t} value={t}>
                      {definition.triggerLabels[t] ?? t}
                    </option>
                  ))}
                </Select>
              </label>
              <p className="m-0 text-[12px] text-ink-3">
                {definition.note({ ...options, trigger })}
                {definition.kind === "daw-midi" &&
                  " Safari has no Web MIDI: use Chrome, Edge or Firefox."}
              </p>
            </>
          )}
          {failed && (
            <p role="alert" className="m-0 text-[13px] text-signal">
              {failed}
            </p>
          )}
          {drive.problem && connected && (
            <p role="alert" className="m-0 text-[13px] text-signal">
              {drive.problem}
            </p>
          )}
          {connected && (
            <p role="status" className="m-0 flex items-center gap-2 text-[13px] text-ink-2">
              <span
                aria-hidden="true"
                className={cn(
                  "size-1.5 rounded-full",
                  readout ? "breathe bg-signal" : "border border-ink-3",
                )}
              />
              <span className="tabular">
                {readout
                  ? `Reading ${readout.timecode} at ${readout.rate} fps`
                  : (statusWords(status) ?? "Listening")}
              </span>
            </p>
          )}
          {!connected && statusWords(status) && (
            <p role="status" className="m-0 text-[13px] text-ink-3">
              {statusWords(status)}
            </p>
          )}
          <div className="flex items-center gap-2 border-t border-line pt-3">
            {connected ? (
              <Button size="sm" variant="secondary" onClick={() => recorder.disconnect()}>
                Disconnect
              </Button>
            ) : (
              <Button
                size="sm"
                variant="primary"
                disabled={Boolean(unsupported) || status.state === "connecting"}
                onClick={() => connect(options)}
              >
                {others ? "Take over" : "Connect"}
              </Button>
            )}
          </div>
        </Floating>
      )}
    </div>
  );
}
