import {
  type CustomProfile,
  customProfileInput,
  customRef,
  type DeliveryProfile,
  deliveryProfileIds,
  deliveryProfiles,
  type LayoutName,
  layoutChannels,
  layoutLabel,
  layoutNames,
  type ProfileRef,
  profileFor,
} from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Button } from "~/components/ui/button";
import { Choice } from "~/components/ui/choice";
import { Dialog } from "~/components/ui/dialog";
import { Input, Select } from "~/components/ui/input";
import { meQuery, useCustomProfileMutations } from "~/lib/queries";

/** Whether the signed-in member runs the workspace: only they make its own profiles. */
export function useWorkspaceAdmin() {
  const { data: me } = useQuery(meQuery);
  const role = me?.organisations.find((o) => o.id === me.activeOrganisationId)?.role;
  return role === "owner" || role === "admin";
}

/** A level in decibels, with a true minus sign. */
export const formatDb = (value: number) => (value < 0 ? `−${Math.abs(value)}` : String(value));

interface LayoutChoice {
  value: string;
  label: string;
  channels: number | null;
  layout: LayoutName | null;
  atmos: boolean;
}

/** What a profile can ask of the channels: any, a layout (#74), or an ADM master. */
const layoutChoices: LayoutChoice[] = [
  { value: "", label: "Any layout", channels: null, layout: null, atmos: false },
  ...layoutNames.map((name) => ({
    value: name,
    label: layoutLabel(name),
    channels: layoutChannels(name),
    layout: name,
    atmos: false,
  })),
  { value: "atmos", label: "Dolby Atmos (ADM BWF)", channels: null, layout: null, atmos: true },
];

/**
 * The choice a profile makes: its layout, else Atmos, else any layout, else its number of
 * channels alone. A profile made before layouts were (#74) keeps asking for a count only,
 * never a layout it did not choose.
 */
export function layoutChoiceOf(
  p: Pick<DeliveryProfile, "channels" | "layout" | "atmos">,
): LayoutChoice {
  const known =
    layoutChoices.find((c) => p.layout && c.layout === p.layout && Boolean(p.atmos) === c.atmos) ??
    (p.atmos && !p.layout ? layoutChoices.find((c) => c.atmos) : undefined) ??
    (!p.layout && !p.atmos && p.channels === null ? layoutChoices[0] : undefined);
  if (known) return known;
  const label = p.channels
    ? `${p.channels} ${p.channels === 1 ? "channel" : "channels"}`
    : "Any layout";
  return {
    value: `channels:${p.channels ?? ""}`,
    label,
    channels: p.channels,
    layout: p.layout ?? null,
    atmos: Boolean(p.atmos),
  };
}

/** What a profile asks of the channels, as its summary says it: one or two by name. */
const layoutSummary = (p: DeliveryProfile) =>
  p.atmos
    ? "Dolby Atmos (ADM BWF)"
    : p.layout
      ? layoutLabel(p.layout)
      : p.channels === null
        ? "Any layout"
        : p.channels <= 2
          ? layoutLabel(`${p.channels}.0`)
          : `${p.channels} channels`;

/** What a delivery profile asks for, in one line. */
export function profileSummary(p: DeliveryProfile): string {
  const rates = p.sampleRates.rates.map((r) => `${r / 1000} kHz`).join(", ");
  return [
    p.loudness
      ? `${formatDb(p.loudness.target)} LUFS ±${p.loudness.tolerance}`
      : "No loudness target",
    `${formatDb(p.truePeakMax)} dBTP`,
    p.sampleRates.atLeast ? `${rates} or more` : rates,
    p.bitDepthMin ? `${p.bitDepthMin}-bit${p.bitDepthExact ? "" : " or more"}` : "Any depth",
    layoutSummary(p),
  ].join(" · ");
}

/** A profile's name, a workspace's own included; null for one since deleted. */
export const profileLabel = (
  ref: ProfileRef | null | undefined,
  customs: readonly CustomProfile[],
) => profileFor(ref, customs)?.label ?? null;

/** The built-in profiles, then the workspace's own, as options of a select. */
export function ProfileOptions({ customs }: { customs: readonly CustomProfile[] }) {
  return (
    <>
      {deliveryProfileIds.map((id) => (
        <option key={id} value={id}>
          {deliveryProfiles[id].label}
        </option>
      ))}
      {customs.length > 0 && (
        <optgroup label="This workspace">
          {customs.map((c) => (
            <option key={c.id} value={customRef(c.id)}>
              {c.label}
            </option>
          ))}
        </optgroup>
      )}
    </>
  );
}

/** Reads "44.1, 48" (kHz) as sample rates in hertz. */
const ratesFrom = (text: string) =>
  text
    .split(/[,\s]+/)
    .map((t) => Number.parseFloat(t.replace(/khz$/i, "")))
    .filter((n) => Number.isFinite(n) && n > 0)
    .map((khz) => Math.round(khz * 1000));

/**
 * A workspace's own profile, new or changed (#144): the numbers QA measures against.
 * Admins only; `onSaved` receives the profile, to choose it at once.
 */
export function ProfileEditor({
  profile,
  onClose,
  onSaved,
}: {
  profile?: CustomProfile;
  onClose: () => void;
  onSaved?: (profile: CustomProfile) => void;
}) {
  const { create, update } = useCustomProfileMutations();
  const [label, setLabel] = useState(profile?.label ?? "");
  const [hasLoudness, setHasLoudness] = useState(profile ? profile.loudness !== null : true);
  const [target, setTarget] = useState(String(profile?.loudness?.target ?? -16));
  const [tolerance, setTolerance] = useState(String(profile?.loudness?.tolerance ?? 1));
  const [truePeak, setTruePeak] = useState(String(profile?.truePeakMax ?? -1));
  const [rates, setRates] = useState(
    (profile?.sampleRates.rates ?? [48_000]).map((r) => r / 1000).join(", "),
  );
  const [atLeast, setAtLeast] = useState(profile?.sampleRates.atLeast ?? true);
  const [bitDepth, setBitDepth] = useState(String(profile?.bitDepthMin ?? 24));
  const initial = layoutChoiceOf(profile ?? { channels: null });
  const choices = layoutChoices.some((c) => c.value === initial.value)
    ? layoutChoices
    : [...layoutChoices, initial];
  const [layout, setLayout] = useState(initial.value);
  const [invalid, setInvalid] = useState<string | null>(null);
  const saving = profile ? update : create;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    // Typed minus signs read as numbers too.
    const number = (text: string) => Number.parseFloat(text.replace("−", "-"));
    const chosen = choices.find((c) => c.value === layout) ?? initial;
    const parsed = customProfileInput.safeParse({
      label,
      loudness: hasLoudness ? { target: number(target), tolerance: number(tolerance) } : null,
      truePeakMax: number(truePeak),
      sampleRates: { rates: ratesFrom(rates), atLeast },
      bitDepthMin: bitDepth ? Number(bitDepth) : null,
      channels: chosen.channels,
      layout: chosen.layout,
      atmos: chosen.atmos,
    });
    if (!parsed.success) {
      setInvalid(parsed.error.issues[0]?.message ?? "Check the numbers");
      return;
    }
    setInvalid(null);
    const done = {
      onSuccess: (saved: CustomProfile) => {
        onSaved?.(saved);
        onClose();
      },
    };
    if (profile) update.mutate({ id: profile.id, ...parsed.data }, done);
    else create.mutate(parsed.data, done);
  };

  const field = "flex flex-col gap-1.5 text-[13px] text-ink-2";
  return (
    <Dialog
      title={profile ? `Change ${profile.label}` : "Custom delivery profile"}
      description="What the checks measure against. Every project in the workspace can choose it."
      onClose={onClose}
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="grid gap-4 @md/app:grid-cols-2">
          <label className={field}>
            Name
            <Input
              value={label}
              required
              maxLength={60}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="For example Vinyl cut"
            />
          </label>
          <div className={field}>
            <Choice
              checked={hasLoudness}
              onChange={(e) => setHasLoudness(e.target.checked)}
              className="text-[13px] text-ink-2"
            >
              Loudness target
            </Choice>
            <span className="flex items-center gap-2">
              <Input
                value={target}
                disabled={!hasLoudness}
                aria-label="Loudness target, LUFS"
                inputMode="decimal"
                onChange={(e) => setTarget(e.target.value)}
                className="w-20"
              />
              <span className="text-ink-3">LUFS, ±</span>
              <Input
                value={tolerance}
                disabled={!hasLoudness}
                aria-label="Tolerance, LU"
                inputMode="decimal"
                onChange={(e) => setTolerance(e.target.value)}
                className="w-16"
              />
            </span>
          </div>
          <label className={field}>
            True peak ceiling
            <span className="flex items-center gap-2">
              <Input
                value={truePeak}
                inputMode="decimal"
                onChange={(e) => setTruePeak(e.target.value)}
                className="w-20"
              />
              <span className="text-ink-3">dBTP</span>
            </span>
          </label>
          <div className={field}>
            <label htmlFor="profile-rates">Sample rates, kHz</label>
            <Input
              id="profile-rates"
              value={rates}
              onChange={(e) => setRates(e.target.value)}
              placeholder="44.1, 48"
            />
            <Choice
              checked={atLeast}
              onChange={(e) => setAtLeast(e.target.checked)}
              className="text-[13px] text-ink-2"
            >
              Or higher than the first
            </Choice>
          </div>
          <label className={field}>
            Bit depth
            <Select value={bitDepth} onChange={(e) => setBitDepth(e.target.value)}>
              <option value="">Any depth</option>
              <option value="16">16-bit or more</option>
              <option value="24">24-bit or more</option>
              <option value="32">32-bit</option>
            </Select>
          </label>
          <label className={field}>
            Layout
            <Select value={layout} onChange={(e) => setLayout(e.target.value)}>
              {choices.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </Select>
          </label>
        </div>
        {(invalid ?? saving.error?.message) && (
          <p className="text-[13px] text-signal">{invalid ?? saving.error?.message}</p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="md" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" size="md" disabled={saving.isPending}>
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
