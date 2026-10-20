import { useCallback, useEffect, useRef, useState } from "react";

/** The tuning pitches a room asks for: baroque, "Verdi", concert and orchestral A. */
export const TONES = [415, 432, 440, 442] as const;
export type Tone = (typeof TONES)[number];

export const TEMPO_MIN = 30;
export const TEMPO_MAX = 300;
export const TEMPO_DEFAULT = 88;

/** A tempo someone typed, as a whole number the metronome can keep; nothing for no number. */
export function tempoOf(input: number): number | null {
  if (!Number.isFinite(input)) return null;
  return Math.min(TEMPO_MAX, Math.max(TEMPO_MIN, Math.round(input)));
}

/**
 * The clicks to schedule now: every beat from `next` up to `until` (seconds on the audio clock),
 * and where the beat after them falls. The audio clock keeps time; the timer only looks ahead.
 */
export function beatsDue(
  next: number,
  bpm: number,
  until: number,
): { times: number[]; next: number } {
  const step = 60 / bpm;
  const times: number[] = [];
  let at = next;
  while (at < until) {
    times.push(at);
    at += step;
  }
  return { times, next: at };
}

/** How far ahead clicks are scheduled, and how often the scheduler wakes, in seconds. */
const AHEAD = 0.1;
const WAKE = 0.025;
const TONE_LEVEL = 0.2;
const CLICK_LEVEL = 0.4;
const STORED = "hekate.metronome.tempo";

type SinkContext = AudioContext & { setSinkId?: (id: string) => Promise<void> };

/** An output a browser lets a page choose (Chrome and Edge do; others play through the default). */
export interface AudioOutput {
  id: string;
  label: string;
}

function storedTempo(): number {
  try {
    return tempoOf(Number(localStorage.getItem(STORED) ?? Number.NaN)) ?? TEMPO_DEFAULT;
  } catch {
    return TEMPO_DEFAULT;
  }
}

/**
 * The take log's tuning tone and metronome (#51), played on this device only: each person in the
 * room hears their own, through the output they choose where the browser allows it.
 */
export function useReferenceAudio() {
  const context = useRef<SinkContext | null>(null);
  const [tone, setTone] = useState<Tone | null>(null);
  const [metronome, setMetronome] = useState(false);
  const [tempo, setTempoState] = useState(storedTempo);
  const [outputs, setOutputs] = useState<AudioOutput[]>([]);
  const [output, setOutputState] = useState("");
  const chosen = useRef(output);

  // Made on first use, after a press, so the browser lets it sound.
  const audio = useCallback((): SinkContext => {
    if (!context.current) {
      context.current = new AudioContext() as SinkContext;
      if (chosen.current) void context.current.setSinkId?.(chosen.current).catch(() => undefined);
    }
    void context.current.resume();
    return context.current;
  }, []);

  const setTempo = (bpm: number) => {
    setTempoState(bpm);
    try {
      localStorage.setItem(STORED, String(bpm));
    } catch {
      // Remembering the tempo is a convenience; without storage it starts at the default.
    }
  };

  const setOutput = (id: string) => {
    setOutputState(id);
    chosen.current = id;
    void context.current?.setSinkId?.(id).catch(() => undefined);
  };

  useEffect(() => {
    if (tone == null) return;
    const ctx = audio();
    const now = ctx.currentTime;
    const oscillator = ctx.createOscillator();
    const level = ctx.createGain();
    oscillator.frequency.value = tone;
    // A short fade either side, so the tone starts and stops without a click.
    level.gain.setValueAtTime(0, now);
    level.gain.linearRampToValueAtTime(TONE_LEVEL, now + 0.05);
    oscillator.connect(level).connect(ctx.destination);
    oscillator.start(now);
    return () => {
      const end = ctx.currentTime;
      level.gain.cancelScheduledValues(end);
      level.gain.setValueAtTime(level.gain.value, end);
      level.gain.linearRampToValueAtTime(0, end + 0.05);
      oscillator.stop(end + 0.06);
    };
  }, [tone, audio]);

  useEffect(() => {
    if (!metronome) return;
    const ctx = audio();
    let next = ctx.currentTime + 0.05;
    const click = (at: number) => {
      const oscillator = ctx.createOscillator();
      const level = ctx.createGain();
      oscillator.frequency.value = 1000;
      level.gain.setValueAtTime(CLICK_LEVEL, at);
      level.gain.exponentialRampToValueAtTime(0.001, at + 0.03);
      oscillator.connect(level).connect(ctx.destination);
      oscillator.start(at);
      oscillator.stop(at + 0.04);
    };
    const wake = () => {
      const due = beatsDue(next, tempo, ctx.currentTime + AHEAD);
      for (const at of due.times) click(at);
      next = due.next;
    };
    wake();
    const timer = setInterval(wake, WAKE * 1000);
    return () => clearInterval(timer);
  }, [metronome, tempo, audio]);

  useEffect(() => {
    const devices = navigator.mediaDevices;
    if (typeof AudioContext === "undefined" || !("setSinkId" in AudioContext.prototype)) return;
    if (!devices?.enumerateDevices) return;
    const list = () =>
      devices
        .enumerateDevices()
        .then((all) =>
          // Browsers name outputs only once a page may use a microphone; unnamed, there is no choice.
          setOutputs(
            all
              .filter((d) => d.kind === "audiooutput" && d.label && d.deviceId !== "default")
              .map((d) => ({ id: d.deviceId, label: d.label })),
          ),
        )
        .catch(() => setOutputs([]));
    void list();
    devices.addEventListener?.("devicechange", list);
    return () => devices.removeEventListener?.("devicechange", list);
  }, []);

  useEffect(
    () => () => {
      void context.current?.close();
      context.current = null;
    },
    [],
  );

  return {
    tone,
    setTone,
    metronome,
    setMetronome,
    tempo,
    setTempo,
    outputs,
    output,
    setOutput,
  };
}
