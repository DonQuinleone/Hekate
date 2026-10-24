import {
  type FrameRateId,
  frameRates,
  parseTimecodeLabel,
  type RecorderPosition,
  secondsOfTimecode,
  timecodeAtFrame,
  timecodeLabel,
} from "@hekate/shared";
import { useEffect, useRef, useState } from "react";
import { useRecorderReadout } from "~/components/recorder";
import { Input, Select } from "~/components/ui/input";
import { Toggle } from "~/components/ui/toggle";
import type { RecorderInput } from "~/lib/recorders/adapter";
import { chaseStep } from "~/lib/recorders/chase";
import { dawMidi } from "~/lib/recorders/midi";
import { useRecorder } from "~/lib/recorders/provider";
import { recorderDefinition } from "~/lib/recorders/registry";
import { listening } from "~/lib/recorders/take-driver";

/** How often the player is checked against the DAW between its positions. */
const CHASE_EVERY_MS = 250;

export interface FollowRecorder {
  on: boolean;
  setOn(on: boolean): void;
  /** Where the file starts on the DAW's timeline, in seconds since midnight. */
  startsAt: number;
  setStartsAt(seconds: number): void;
  /** Whether a listening room's leader moves this player instead. */
  held: boolean;
}

/**
 * The player following a DAW (#450, decision 240) on the file page: while on, the page's media
 * element chases the tab's recorder (the DAW over MIDI, connected here for timecode alone if
 * nothing is connected yet; or the recorder the take log reads). It stays off while the member
 * follows someone's listening room, whose leader already moves the player.
 */
export function useFollowRecorder(
  media: HTMLMediaElement | null,
  fileStart: number,
  held: boolean,
): FollowRecorder {
  const recorder = useRecorder();
  const [on, setOn] = useState(false);
  const [startsAt, setStartsAt] = useState(fileStart);
  /** Whether turning it on connected the DAW, so turning it off lets it go again. */
  const ours = useRef(false);
  useEffect(() => setStartsAt(fileStart), [fileStart]);

  const active = on && !held;
  const kind = recorder?.kind ?? null;
  const connect = recorder?.connect;
  useEffect(() => {
    if (!active || kind || !connect) return;
    ours.current = true;
    void connect(dawMidi.kind, { input: null, channel: 0, trigger: "off" });
  }, [active, kind, connect]);
  const disconnect = recorder?.disconnect;
  useEffect(() => {
    if (on || !ours.current) return;
    ours.current = false;
    disconnect?.();
  }, [on, disconnect]);

  const subscribe = recorder?.subscribe;
  useEffect(() => {
    if (!active || !media || !subscribe) return;
    let last: RecorderPosition | null = null;
    const apply = () => {
      if (!last || media.readyState < 1) return;
      const step = chaseStep(
        {
          time: media.currentTime,
          paused: media.paused,
          rate: media.playbackRate,
          duration: media.duration,
        },
        last,
        startsAt,
        Date.now(),
      );
      if (step.rate !== null) media.playbackRate = step.rate;
      if (step.seek !== null) media.currentTime = step.seek;
      // A browser that wants a tap before it plays keeps the player where it is.
      if (step.play === true) void media.play().catch(() => undefined);
      if (step.play === false) media.pause();
    };
    const stop = subscribe((event) => {
      if (event.type !== "position") return;
      last = event.position;
      apply();
    });
    const timer = setInterval(apply, CHASE_EVERY_MS);
    return () => {
      stop();
      clearInterval(timer);
    };
  }, [active, media, subscribe, startsAt]);

  return { on, setOn, startsAt, setStartsAt, held };
}

/** The file's start as a label at the recorder's rate (or 25 before it has said). */
const labelOf = (seconds: number, rate: FrameRateId) =>
  timecodeLabel(
    timecodeAtFrame(Math.round((seconds * frameRates[rate].num) / frameRates[rate].den), rate),
  );

/**
 * In the player's View menu, as the prototype draws it: "Follow the DAW", and once on, the MIDI
 * input and where the file starts on the DAW's timeline, with what it hears.
 */
export function FollowRecorderSettings({ follow }: { follow: FollowRecorder }) {
  const recorder = useRecorder();
  const readout = useRecorderReadout();
  const position = recorder?.position ?? null;
  const rate: FrameRateId = position?.timecode.rate ?? "25";
  const [typed, setTyped] = useState(() => labelOf(follow.startsAt, rate));
  const [inputs, setInputs] = useState<RecorderInput[]>([]);
  const statusState = recorder?.status.state;
  useEffect(() => {
    let live = true;
    void statusState;
    void dawMidi.inputs().then((found) => {
      if (live) setInputs(found);
    });
    return () => {
      live = false;
    };
  }, [statusState]);
  // Shown afresh when the start or the rate changes.
  useEffect(() => setTyped(labelOf(follow.startsAt, rate)), [follow.startsAt, rate]);
  if (!recorder) return null;
  const connectedKind = recorder.kind && listening(recorder.status) ? recorder.kind : null;
  const other = connectedKind && connectedKind !== dawMidi.kind;
  const title = other ? "Follow the recorder" : "Follow the DAW";
  const unsupported = other ? null : dawMidi.unsupported();
  const failed = recorder.status.state === "failed" ? recorder.status.reason : null;
  return (
    <div className="flex flex-col gap-2.5 border-t border-hairline pt-2.5">
      <Toggle
        label={title}
        hint={
          other
            ? `Plays where ${recorderDefinition(connectedKind)?.short ?? "the recorder"}'s timecode is`
            : "Plays where its MIDI timecode is"
        }
        checked={follow.on}
        onChange={follow.setOn}
      />
      {follow.on && (
        <>
          <div className="grid grid-cols-[minmax(0,1fr)_112px] gap-2">
            {!other && (
              <label className="flex min-w-0 flex-col gap-1 text-[12px] text-ink-3">
                MIDI input
                <Select
                  size="sm"
                  value={recorder.kind === dawMidi.kind ? (recorder.options.input ?? "") : ""}
                  onChange={(e) =>
                    void recorder.connect(dawMidi.kind, {
                      input: e.target.value || null,
                      channel: 0,
                      trigger: recorder.kind === dawMidi.kind ? recorder.options.trigger : "off",
                    })
                  }
                >
                  <option value="">The first MIDI input</option>
                  {inputs.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.label}
                    </option>
                  ))}
                </Select>
              </label>
            )}
            <label
              className={
                other
                  ? "col-span-2 flex flex-col gap-1 text-[12px] text-ink-3"
                  : "flex flex-col gap-1 text-[12px] text-ink-3"
              }
            >
              File starts at
              <Input
                size="sm"
                value={typed}
                inputMode="numeric"
                onChange={(e) => setTyped(e.target.value)}
                onBlur={() => {
                  const tc = parseTimecodeLabel(typed, rate);
                  if (!tc) return setTyped(labelOf(follow.startsAt, rate));
                  follow.setStartsAt(secondsOfTimecode(tc));
                }}
                className="tabular"
              />
            </label>
          </div>
          <p role="status" className="m-0 text-[12px] text-ink-3">
            {follow.held
              ? "Paused while you follow a listening room."
              : failed
                ? failed
                : unsupported
                  ? unsupported
                  : readout
                    ? `Following ${readout.timecode} at ${readout.rate} fps.`
                    : "Waiting for timecode. Safari has no Web MIDI: use Chrome, Edge or Firefox."}
          </p>
        </>
      )}
    </div>
  );
}
