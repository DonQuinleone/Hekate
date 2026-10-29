import {
  channelNames,
  type FrequencyScale,
  frequencyScales,
  isDefaultAnalysis,
  SPECTRUM_GAIN_MAX,
  type SpectrogramAnalysis,
  spectrogramFftSizes,
  spectrogramOverlaps,
  spectrogramWindows,
} from "@hekate/shared";
import type { ReactNode } from "react";
import {
  type ColourMap,
  colourMapNames,
  colourMaps,
  defaultView,
  type SpectrogramView,
  scaleNames,
  windowNames,
} from "~/lib/spectrogram";
import type { SpectrogramChannelChoice } from "./spectrogram";
import { Button } from "./ui/button";
import { Input, Select } from "./ui/input";
import { Slider } from "./ui/slider";

/** A gain as the slider says it: "+6 dB", "0 dB", "−6 dB". */
export const gainLabel = (gain: number) =>
  `${gain > 0 ? "+" : gain < 0 ? "−" : ""}${Math.abs(Math.round(gain))} dB`;

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is the child.
    <label className="flex min-w-0 flex-col gap-1">
      <span className="label text-[10px]">{label}</span>
      {children}
    </label>
  );
}

/** A number input that applies its value on change, ignoring blanks and partial typing. */
function NumberField({
  label,
  value,
  onChange,
  step,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  step: number;
}) {
  return (
    <Field label={label}>
      <Input
        size="sm"
        type="number"
        className="tabular w-24"
        value={value}
        step={step}
        onChange={(event) => {
          const next = event.target.valueAsNumber;
          if (Number.isFinite(next)) onChange(next);
        }}
        onKeyDown={(event) => event.stopPropagation()}
      />
    </Field>
  );
}

/**
 * The spectrogram's colours, frequency scale and its own brightness (#495), shown in the
 * View menu itself (#135), beside the waveform's look.
 */
export function SpectrogramLook({
  view,
  onView,
}: {
  view: SpectrogramView;
  onView: (view: SpectrogramView) => void;
}) {
  return (
    <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
      <label className="flex w-full items-center gap-3 text-[12px] text-ink-3">
        <span className="w-16 shrink-0">Brightness</span>
        <Slider
          min={-SPECTRUM_GAIN_MAX}
          max={SPECTRUM_GAIN_MAX}
          step={1}
          value={view.gain}
          aria-label="Spectrogram brightness"
          aria-valuetext={gainLabel(view.gain)}
          onChange={(event) => onView({ ...view, gain: Number(event.target.value) })}
          className="min-w-0 flex-1"
        />
        <span className="tabular w-12 shrink-0 text-right">{gainLabel(view.gain)}</span>
      </label>
      <Field label="Colours">
        <Select
          size="sm"
          className="w-auto"
          value={view.colourMap}
          onChange={(event) => onView({ ...view, colourMap: event.target.value as ColourMap })}
        >
          {colourMaps.map((map) => (
            <option key={map} value={map}>
              {colourMapNames[map]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Scale">
        <Select
          size="sm"
          className="w-auto"
          value={view.scale}
          onChange={(event) => onView({ ...view, scale: event.target.value as FrequencyScale })}
        >
          {frequencyScales.map((scale) => (
            <option key={scale} value={scale}>
              {scaleNames[scale]}
            </option>
          ))}
        </Select>
      </Field>
    </div>
  );
}

export function SpectrogramSettings({
  view,
  onView,
  channel,
  onChannel,
  channels,
  layout,
  sampleRate,
}: {
  view: SpectrogramView;
  onView: (view: SpectrogramView) => void;
  channel: SpectrogramChannelChoice;
  onChannel: (channel: SpectrogramChannelChoice) => void;
  channels: number;
  layout?: string;
  sampleRate: number;
}) {
  const names = channelNames(channels, layout);
  const set = <K extends keyof SpectrogramView>(key: K, value: SpectrogramView[K]) =>
    onView({ ...view, [key]: value });
  return (
    <fieldset className="m-0 flex flex-wrap items-end gap-x-4 gap-y-3 border-0 border-t border-hairline p-0 pt-3">
      <legend className="sr-only">Spectrogram settings</legend>
      <Field label="Channel">
        <Select
          size="sm"
          className="w-auto"
          value={channel}
          onChange={(event) => onChannel(event.target.value)}
        >
          {channels > 1 && <option value="each">Each</option>}
          {channels > 1 && <option value="all">All, combined</option>}
          {names.map((name, i) => (
            <option key={name} value={String(i)}>
              {name}
            </option>
          ))}
          {channels > 1 && <option value="mid">Mid</option>}
          {channels > 1 && <option value="side">Side</option>}
        </Select>
      </Field>
      <NumberField label="Floor dB" value={view.floor} step={6} onChange={(v) => set("floor", v)} />
      <NumberField
        label="Ceiling dB"
        value={view.ceiling}
        step={6}
        onChange={(v) => set("ceiling", v)}
      />
      <NumberField label="Low Hz" value={view.low} step={10} onChange={(v) => set("low", v)} />
      <NumberField
        label="High Hz"
        value={Math.min(view.high, sampleRate / 2)}
        step={1000}
        onChange={(v) => set("high", v)}
      />
      <Button size="sm" variant="ghost" onClick={() => onView(defaultView)}>
        Reset
      </Button>
      <Analysis analysis={view.analysis} onAnalysis={(analysis) => onView({ ...view, analysis })} />
    </fieldset>
  );
}

const fftNames: Record<SpectrogramAnalysis["fftSize"], string> = {
  auto: "Auto",
  "1024": "1,024",
  "4096": "4,096",
  "16384": "16,384",
};

/**
 * How the spectrogram is analysed (#34): its window, FFT size and overlap. Anything but the
 * default is drawn on the server the first time, and kept with the view and its presets.
 */
function Analysis({
  analysis,
  onAnalysis,
}: {
  analysis: SpectrogramAnalysis;
  onAnalysis: (analysis: SpectrogramAnalysis) => void;
}) {
  const set = <K extends keyof SpectrogramAnalysis>(key: K, value: SpectrogramAnalysis[K]) =>
    onAnalysis({ ...analysis, [key]: value });
  return (
    <div className="flex w-full flex-wrap items-end gap-x-4 gap-y-3">
      <Field label="Window">
        <Select
          size="sm"
          className="w-auto"
          value={analysis.window}
          onChange={(event) => set("window", event.target.value as SpectrogramAnalysis["window"])}
        >
          {spectrogramWindows.map((w) => (
            <option key={w} value={w}>
              {windowNames[w]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="FFT size">
        <Select
          size="sm"
          className="w-auto"
          value={analysis.fftSize}
          onChange={(event) => set("fftSize", event.target.value as SpectrogramAnalysis["fftSize"])}
        >
          {spectrogramFftSizes.map((size) => (
            <option key={size} value={size}>
              {fftNames[size]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Overlap">
        <Select
          size="sm"
          className="w-auto"
          value={analysis.overlap}
          onChange={(event) => set("overlap", event.target.value as SpectrogramAnalysis["overlap"])}
        >
          {spectrogramOverlaps.map((o) => (
            <option key={o} value={o}>
              {o}%
            </option>
          ))}
        </Select>
      </Field>
      <p className="m-0 max-w-sm text-[12px] text-ink-3">
        {isDefaultAnalysis(analysis)
          ? "As every file is analysed. A smaller FFT is sharper in time, a larger one in pitch."
          : "Drawn on the server the first time, then kept with your view and its presets."}
      </p>
    </div>
  );
}
