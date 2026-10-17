import { channelNames, type FrequencyScale, frequencyScales } from "@hekate/shared";
import type { ReactNode } from "react";
import {
  type ColourMap,
  colourMapNames,
  colourMaps,
  defaultView,
  type SpectrogramView,
  scaleNames,
} from "~/lib/spectrogram";
import type { SpectrogramChannelChoice } from "./spectrogram";
import { Button } from "./ui/button";
import { Input, Select } from "./ui/input";

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

/** Every setting of the spectrogram view, beneath the player. */
/** The spectrogram's colours and frequency scale, shown in the View menu itself (#135). */
export function SpectrogramLook({
  view,
  onView,
}: {
  view: SpectrogramView;
  onView: (view: SpectrogramView) => void;
}) {
  return (
    <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
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
    </fieldset>
  );
}
