import { SILENCE } from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { type ChannelMix, isPlain, mixLabel, plainMix } from "~/lib/channel-mix";
import { cn } from "~/lib/cn";
import { loudnessQuery, loudnessSeriesQuery } from "~/lib/queries";
import { formatLevel, METER_FLOOR, meterFraction, usePlayheadFrame } from "./loudness";
import { Button } from "./ui/button";
import { Switch } from "./ui/toggle";

const toggle =
  "tabular flex size-6 cursor-pointer items-center justify-center rounded-chip border bg-transparent p-0 text-[11px]";

/**
 * The button that opens a recording's channels (#74), beside the View button; it says what is
 * changed from the recording as it plays.
 */
export function ChannelsButton({
  names,
  mix,
  open,
  onToggle,
}: {
  names: readonly string[];
  mix: ChannelMix;
  open: boolean;
  onToggle: () => void;
}) {
  const heard = mixLabel(mix, names);
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-expanded={open}
      aria-controls="player-channels"
      aria-label={heard ? `Channels: ${heard.toLowerCase()}` : "Channels"}
      onClick={onToggle}
      className={cn(open && "bg-raised text-ink")}
    >
      Channels
      {heard && <span className="tabular text-signal">{heard}</span>}
    </Button>
  );
}

/**
 * A recording's channels to hear one by one (#74), as the prototype's audio layout menu
 * offers: solo or mute each, and a stereo downmix of anything wider. It opens in the player,
 * under its controls, as the View settings do.
 */
/**
 * Each channel's level at the playhead, as the prototype's channel rows show it: the RMS the
 * worker measured, read from the stored loudness series, so no audio is analysed here. None
 * where the series is missing, still being measured, or has another channel count.
 */
function useChannelLevels(
  source: { fileId: string; media: HTMLMediaElement | null } | undefined,
  channels: number,
): { levels: number[] | null; loading: boolean } {
  const { data: info, isError } = useQuery({
    ...loudnessQuery(source?.fileId ?? ""),
    enabled: Boolean(source),
  });
  const { data: series } = useQuery({
    ...loudnessSeriesQuery(source?.fileId ?? ""),
    enabled: Boolean(source && info?.series),
  });
  const frame = usePlayheadFrame(series, source?.media ?? null);
  // Still on its way: the rows keep the meters' room, so nothing moves when they arrive.
  const loading =
    Boolean(source) && !isError && (info === undefined || (Boolean(info.series) && !series));
  if (!series || series.channels !== channels) return { levels: null, loading };
  const levels = Array.from({ length: channels }, (_, c) =>
    frame === null ? SILENCE : (series.rms[frame * channels + c] ?? SILENCE),
  );
  return { levels, loading: false };
}

export function ChannelsPanel({
  names,
  mix,
  onMix,
  canDownmix,
  canBinaural = false,
  unavailable,
  levelsOf,
}: {
  /** Each channel's speaker: "L", "C", "LFE". */
  names: readonly string[];
  mix: ChannelMix;
  onMix: (mix: ChannelMix) => void;
  /** Whether a stereo downmix can be made: only where the layout names every channel. */
  canDownmix: boolean;
  /** Whether it can be heard binaurally: only where every channel has a known place. */
  canBinaural?: boolean;
  /** Why the channels cannot be heard apart in what is playing, if they cannot. */
  unavailable?: string;
  /** Where to read each channel's level at the playhead; none for those without the meters. */
  levelsOf?: { fileId: string; media: HTMLMediaElement | null };
}) {
  const { levels, loading } = useChannelLevels(levelsOf, names.length);
  return (
    <section
      id="player-channels"
      aria-label="Channels"
      className="flex flex-col gap-2 border-t border-hairline pt-3"
    >
      {unavailable ? (
        <p className="m-0 text-[13px] text-ink-3">{unavailable}</p>
      ) : (
        <div className="flex max-w-80 flex-col gap-2">
          <ul className="m-0 flex list-none flex-wrap gap-x-5 gap-y-1 p-0">
            {names.map((name, i) => (
              <li key={`${name}-${String(i)}`} className="flex items-center gap-2 text-[13px]">
                <span className="tabular w-10 text-ink-2">{name}</span>
                <button
                  type="button"
                  aria-pressed={mix.solo === i}
                  aria-label={`Solo ${name}`}
                  onClick={() => onMix({ ...mix, solo: mix.solo === i ? null : i })}
                  className={cn(
                    toggle,
                    mix.solo === i
                      ? "border-signal bg-signal text-ground"
                      : "border-line text-ink-3 hover:border-edge hover:text-ink",
                  )}
                >
                  S
                </button>
                <button
                  type="button"
                  aria-pressed={mix.muted.includes(i)}
                  aria-label={`Mute ${name}`}
                  onClick={() =>
                    onMix({
                      ...mix,
                      muted: mix.muted.includes(i)
                        ? mix.muted.filter((m) => m !== i)
                        : [...mix.muted, i],
                    })
                  }
                  className={cn(
                    toggle,
                    mix.muted.includes(i)
                      ? "border-ink-3 bg-raised text-ink"
                      : "border-line text-ink-3 hover:border-edge hover:text-ink",
                  )}
                >
                  M
                </button>
                {levels && (
                  <meter
                    className="sr-only"
                    min={METER_FLOOR}
                    max={0}
                    value={Math.max(METER_FLOOR, levels[i] ?? SILENCE)}
                    aria-label={`${name}: RMS ${formatLevel(levels[i] ?? SILENCE)} dBFS`}
                  />
                )}
                {(levels || loading) && (
                  <span
                    aria-hidden="true"
                    className="h-1 w-12 overflow-hidden rounded-full bg-raised"
                  >
                    <span
                      className={cn(
                        "block h-full transition-[width] duration-100",
                        mix.muted.includes(i) || (mix.solo !== null && mix.solo !== i)
                          ? "bg-ink-3/50"
                          : "bg-ink-2",
                      )}
                      style={{ width: `${meterFraction(levels?.[i] ?? SILENCE) * 100}%` }}
                    />
                  </span>
                )}
              </li>
            ))}
          </ul>
          {names.length > 2 && canDownmix && (
            <div className="flex items-center justify-between gap-3 text-[13px] text-ink">
              Hear the stereo downmix
              <Switch
                label="Hear the stereo downmix"
                checked={mix.downmix}
                onChange={(downmix) => onMix({ ...mix, downmix, binaural: false })}
              />
            </div>
          )}
          {names.length > 2 && canBinaural && (
            // Each speaker placed around the listener, for headphones (#74).
            <div className="flex items-center justify-between gap-3 text-[13px] text-ink">
              Hear it binaurally, on headphones
              <Switch
                label="Hear it binaurally, on headphones"
                checked={mix.binaural}
                onChange={(binaural) => onMix({ ...mix, binaural, downmix: false })}
              />
            </div>
          )}
          {!isPlain(mix) && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onMix(plainMix)}
              className="self-start"
            >
              Hear it as recorded
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
