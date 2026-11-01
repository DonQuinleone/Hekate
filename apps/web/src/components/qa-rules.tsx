import {
  type BuiltInCheck,
  builtInChecks,
  type CustomRule,
  categoryOf,
  customRule,
  type DeliveryProfile,
  deliveryChecks,
  isDeliveryCheck,
  openQaCategories,
  operatorsFor,
  type QaCategory,
  type QaSettings,
  qaCategories,
  qaSettingsOf,
  type RuleMeasure,
  type RuleOperator,
  type RuleScope,
  type RuleSeverity,
  ruleCategory,
  ruleMeasureIds,
  ruleMeasures,
  ruleOperators,
  ruleScopes,
  ruleSeverities,
} from "@hekate/shared";
import { type FormEvent, useState } from "react";
import { cn } from "~/lib/cn";
import { type Project, useProjectCan, useUpdateProject } from "~/lib/queries";
import { formatDb } from "./delivery-profiles";
import { Icon } from "./icons";
import { checkNames } from "./qa";
import { Section, SwitchRow } from "./settings";
import { Button } from "./ui/button";
import { ToggleChip } from "./ui/chip";
import { Choice } from "./ui/choice";
import { Dialog, useConfirm } from "./ui/dialog";
import { Input, Select } from "./ui/input";
import { ActionMenu } from "./ui/menu";
import { Switch } from "./ui/toggle";

const categoryCopy: Record<QaCategory, { label: string; hint: string }> = {
  audio: { label: "Audio", hint: "Levels, format and content of stereo files" },
  immersive: { label: "Immersive audio", hint: "Atmos and surround deliverables" },
  video: { label: "Video", hint: "Picture, sync, and the audio in the container" },
  artwork: { label: "Artwork and documents", hint: "Covers, scores and notes" },
  naming: { label: "File names", hint: "What a name must carry" },
  metadata: { label: "Metadata", hint: "What the file says about itself" },
};

const checkHints: Record<BuiltInCheck, string> = {
  format: "Sample rate, bit depth and channel count against the delivery profile",
  layout: "How the channels are laid out (5.1, 7.1.4) against the profile",
  atmos: "ADM metadata for the bed and objects, where the profile asks for Atmos",
  lfe: "Content on the LFE channel above its 120 Hz crossover, or channels out of order",
  loudness: "Integrated loudness against the profile's target",
  "true-peak": "The highest true peak against the profile's ceiling",
  "dead-channel": "A channel with nothing on it while the others carry the music",
  imbalance: "Left and right more than 3 dB apart",
  clipping: "Samples held at full scale",
  "flat-tops": "Peaks flattened by a limiter or a clip",
  dropouts: "Sudden gaps of digital silence",
  clicks: "Short discontinuities in the waveform",
  "dc-offset": "A constant shift away from zero",
  silence: "Long stretches with nothing on them",
  phase: "Left and right cancelling each other",
  integrity: "Decodes cleanly, to the length the file declares",
  bandwidth: "A sharp cut-off in the high frequencies, or a hi-res file made from a lower rate",
  "black-frames": "A second or more of black, at either end or inside the picture",
  "frozen-frames": "Two seconds or more of a picture that does not move",
  "dropped-frames": "Gaps between frames longer than the frame rate allows",
  interlacing: "Field order, and a picture interlaced only in places",
  "broadcast-levels": "Luma outside EBU R103's range on more than 1% of a frame",
  letterbox: "Bars the picture never reaches into, top and bottom or at the sides",
  flashing: "More than three screen-wide flashes in a second (Ofcom)",
  timecode: "Runs on without a break, and the file's records of it agree",
  "picture-format": "Codec, size, frame rate, scan, colour and range, against the profile",
};

const severityLabel: Record<RuleSeverity, string> = {
  fail: "Issue",
  warn: "Warning",
  info: "Advisory",
};

/** What a rule of your own asks, in a line. */
const asked = (rule: CustomRule) =>
  `${ruleMeasures[rule.measure].label} ${ruleOperators[rule.operator]} ${rule.value}${
    ruleMeasures[rule.measure].unit ? ` ${ruleMeasures[rule.measure].unit}` : ""
  }`;

/**
 * One rule in a category (#584): its name and what it checks, whole at every width; how hard it
 * bites; whether a new version must pass it before it lands, where that can be known as it
 * arrives; and whether it runs. On a phone the controls take a second line.
 */
function RuleRow({
  name,
  hint,
  severity,
  on,
  fixed,
  builtIn = false,
  upload,
  disabled,
  onSeverity,
  onSwitch,
  onUpload,
  menu,
}: {
  name: string;
  hint?: string;
  /** Null leaves it as the check reports it (a built-in check only). */
  severity: RuleSeverity | null;
  on: boolean;
  /** Always on: only its severity moves. */
  fixed?: boolean;
  /** A built-in check, which may keep the severity it reports itself. */
  builtIn?: boolean;
  /** Whether it holds a new version back; left out where it is measured only once a file lands. */
  upload?: boolean;
  disabled: boolean;
  onSeverity: (severity: RuleSeverity | null) => void;
  onSwitch: (on: boolean) => void;
  onUpload?: (upload: boolean) => void;
  menu?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 px-4 py-2.5 @3xl/app:flex-row @3xl/app:items-center @3xl/app:gap-3">
      <div className="min-w-0 flex-1">
        <div className={cn("text-[13px]", on ? "text-ink" : "text-ink-3")}>{name}</div>
        {hint && <div className="text-[12px] text-ink-3">{hint}</div>}
      </div>
      <div className="flex items-center gap-3">
        <Select
          size="sm"
          value={severity ?? ""}
          aria-label={`Severity of ${name}`}
          className="w-40 shrink-0"
          disabled={disabled || !on}
          onChange={(e) => onSeverity((e.target.value || null) as RuleSeverity | null)}
        >
          {builtIn && <option value="">Default (as found)</option>}
          {ruleSeverities.map((sv) => (
            <option key={sv} value={sv}>
              {severityLabel[sv]}
            </option>
          ))}
        </Select>
        {upload !== undefined && onUpload ? (
          <ToggleChip
            pressed={upload && on}
            aria-label={`${name}: checked on upload`}
            title="Checked as a new version arrives: one that fails is held back, saying why."
            disabled={disabled || !on}
            onClick={() => onUpload(!upload)}
            className="w-[6.5rem] shrink-0 justify-center"
          >
            On upload
          </ToggleChip>
        ) : (
          <span aria-hidden="true" className="hidden w-[6.5rem] shrink-0 @3xl/app:block" />
        )}
        <span className="ml-auto flex items-center gap-3 @3xl/app:ml-0">
          {fixed ? (
            <span title="Always runs: a plain error is never switched off.">
              <Switch label={`${name} always runs`} checked disabled onChange={() => {}} />
            </span>
          ) : (
            <Switch label={name} checked={on} disabled={disabled} onChange={onSwitch} />
          )}
          {menu ?? <span aria-hidden="true" className="hidden w-8 @3xl/app:block" />}
        </span>
      </div>
    </div>
  );
}

/** A group's own heading inside a category: the delivery checks, or your rules (#584). */
function Subheading({ children }: { children: React.ReactNode }) {
  return <div className="px-4 pt-2.5 pb-0.5 text-[12px] text-ink-3">{children}</div>;
}

/**
 * The project's QA rules (#144, #584), by category: the built-in checks (signal checks always on,
 * the delivery checks as one switch and each on its own, under their own heading), and rules of
 * the project's own. Read against stored measurements, so a change shows in every report at
 * once. Categories the profile does not use are folded. Below, what a new version must pass
 * before it lands (#672): the rules marked On upload, the true-peak check among them, and an
 * edit decision list.
 */
export function QaRules({
  project,
  profile,
}: {
  project: Project;
  /** The delivery profile a new version's true peak is held to; null where each file suggests one. */
  profile: DeliveryProfile | null;
}) {
  const can = useProjectCan(project.id);
  const [confirm, confirmation] = useConfirm();
  const edit = can("edit_workflows");
  const update = useUpdateProject(project.id);
  const settings = qaSettingsOf(project.qaSettings);
  const [editing, setEditing] = useState<CustomRule | "new" | null>(null);
  const opened = openQaCategories(project.profile, project.fileKinds);
  const [flipped, setFlipped] = useState<ReadonlySet<QaCategory>>(new Set());
  const isOpen = (c: QaCategory) => (flipped.has(c) ? !opened.has(c) : opened.has(c));
  const flip = (c: QaCategory) =>
    setFlipped((was) => {
      const next = new Set(was);
      if (!next.delete(c)) next.add(c);
      return next;
    });
  // Each save sends the whole settings, so the controls wait for one to land before the next.
  const save = (next: QaSettings) => update.mutate({ qaSettings: next });
  const busy = !edit || update.isPending;
  const checkOf = (check: BuiltInCheck) => settings.checks[check];
  const setCheck = (
    check: BuiltInCheck,
    change: Partial<{ on: boolean; severity: RuleSeverity | null }>,
  ) =>
    save({
      ...settings,
      checks: {
        ...settings.checks,
        [check]: {
          on: change.on ?? checkOf(check)?.on ?? true,
          severity:
            "severity" in change ? (change.severity ?? null) : (checkOf(check)?.severity ?? null),
        },
      },
    });
  const setRule = (rule: CustomRule) =>
    save({
      ...settings,
      rules: settings.rules.some((r) => r.id === rule.id)
        ? settings.rules.map((r) => (r.id === rule.id ? rule : r))
        : [...settings.rules, rule],
    });
  const checkRow = (check: BuiltInCheck) => {
    const own = checkOf(check);
    const delivery = isDeliveryCheck(check);
    // The true peak is the one built-in check known as a version arrives (#672).
    const upload = check === "true-peak";
    return (
      <RuleRow
        key={check}
        name={checkNames[check]}
        hint={
          upload && profile
            ? `${checkHints[check]}: ${formatDb(profile.truePeakMax)} dBTP for ${profile.label}`
            : checkHints[check]
        }
        severity={own?.severity ?? null}
        on={delivery ? (own?.on ?? true) : true}
        fixed={!delivery}
        builtIn
        upload={upload ? (project.checkTruePeak ?? false) : undefined}
        onUpload={upload ? (checkTruePeak) => update.mutate({ checkTruePeak }) : undefined}
        disabled={busy}
        onSeverity={(severity) => setCheck(check, { severity })}
        onSwitch={(on) => setCheck(check, { on })}
      />
    );
  };

  return (
    <>
      <Section
        title="Rules"
        intro="Plain errors always run: choose how hard each bites. Delivery checks and your own rules switch off one by one."
        action={
          edit ? (
            <Button variant="secondary" size="md" onClick={() => setEditing("new")}>
              <Icon name="plus" size={14} />
              New rule
            </Button>
          ) : undefined
        }
      >
        <SwitchRow
          name="Delivery checks"
          hint={
            settings.delivery
              ? "What distributors and aggregators refuse or query at delivery, against the delivery profile."
              : `${deliveryChecks.length} checks against the delivery profile are off: switch them on when this project delivers through a distributor.`
          }
          checked={settings.delivery}
          disabled={busy}
          onChange={(delivery) => save({ ...settings, delivery })}
        />
        {qaCategories.map((category) => {
          const inCategory = builtInChecks.filter((c) => categoryOf(c) === category);
          const signal = inCategory.filter((c) => !isDeliveryCheck(c));
          const delivery = settings.delivery ? inCategory.filter(isDeliveryCheck) : [];
          const custom = settings.rules.filter((r) => ruleCategory(r) === category);
          const count = signal.length + delivery.length + custom.length;
          if (count === 0) return null;
          const open = isOpen(category);
          const panel = `qa-${category}`;
          return (
            <div key={category} className="flex flex-col">
              <button
                type="button"
                aria-expanded={open}
                aria-controls={panel}
                onClick={() => flip(category)}
                className="flex items-baseline gap-2 bg-raised/30 px-4 py-1.5 text-left transition-colors hover:bg-raised/60"
              >
                <Icon
                  name="chevronRight"
                  size={12}
                  className={cn(
                    "shrink-0 self-center text-ink-3 transition-transform",
                    open && "rotate-90",
                  )}
                />
                <span className="text-[13px] font-medium text-ink">
                  {categoryCopy[category].label}
                </span>
                <span className="hidden min-w-0 text-[12px] text-ink-3 @3xl/app:inline">
                  {categoryCopy[category].hint}
                </span>
                <span className="tabular ml-auto text-[12px] text-ink-3">{count}</span>
              </button>
              {open && (
                <div id={panel} className="flex flex-col divide-y divide-line/60">
                  {signal.map(checkRow)}
                  {delivery.length > 0 && (
                    <div className="flex flex-col divide-y divide-line/60">
                      <Subheading>Delivery</Subheading>
                      {delivery.map(checkRow)}
                    </div>
                  )}
                  {custom.length > 0 && (
                    <div className="flex flex-col divide-y divide-line/60">
                      <Subheading>Your rules</Subheading>
                      {custom.map((rule) => (
                        <RuleRow
                          key={rule.id}
                          name={rule.name}
                          hint={`${asked(rule)} · ${ruleScopes[rule.appliesTo]}`}
                          severity={rule.severity}
                          on={rule.on}
                          upload={rule.onUpload ?? false}
                          onUpload={(onUpload) => setRule({ ...rule, onUpload })}
                          disabled={busy}
                          onSeverity={(severity) => severity && setRule({ ...rule, severity })}
                          onSwitch={(on) => setRule({ ...rule, on })}
                          menu={
                            edit ? (
                              <ActionMenu
                                always
                                label={rule.name}
                                actions={[
                                  { label: "Edit…", onSelect: () => setEditing(rule) },
                                  "divider",
                                  {
                                    label: "Delete…",
                                    danger: true,
                                    onSelect: () =>
                                      confirm({
                                        title: `Delete the rule ${rule.name}?`,
                                        description:
                                          "Files are no longer checked against it. Reports already made keep what it found.",
                                        action: "Delete rule",
                                        onConfirm: () =>
                                          update.mutateAsync({
                                            qaSettings: {
                                              ...settings,
                                              rules: settings.rules.filter((r) => r.id !== rule.id),
                                            },
                                          }),
                                      }),
                                  },
                                ]}
                              />
                            ) : undefined
                          }
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </Section>
      {update.error && <p className="-mt-6 text-[13px] text-signal">{update.error.message}</p>}
      {/* What a new version must pass before it lands (moved here from Workflow, #672). */}
      <Section
        title="Checks on a new version"
        intro="A version whose files fail a rule marked On upload is refused, saying why; whoever edits the workflow can let it through, on the record. The other rules are measured once a file has landed."
      >
        <SwitchRow
          name="An edit decision list with every version"
          hint="The EDL the version was made from, uploaded beside it: it must hold edits, and end within the version."
          checked={project.requireEdl ?? false}
          disabled={busy}
          onChange={(requireEdl) => update.mutate({ requireEdl })}
        />
      </Section>
      {editing && (
        <RuleDialog
          rule={editing === "new" ? undefined : editing}
          pending={update.isPending}
          onSave={(rule) => {
            setRule(rule);
            setEditing(null);
          }}
          onClose={() => setEditing(null)}
        />
      )}
      {confirmation}
    </>
  );
}

const placeholders: Record<RuleMeasure, string> = {
  sampleRate: "96",
  bitDepth: "24",
  channels: "2",
  duration: "600",
  integrated: "−16 to −14",
  truePeak: "−1",
  range: "20",
  codec: "flac, pcm_s24le",
  fileName: "*_master.wav",
  isrc: "????????????",
  title: "?*",
  artist: "?*",
  originator: "?*",
};

/** A rule of the project's own, new or changed. */
function RuleDialog({
  rule,
  pending,
  onSave,
  onClose,
}: {
  rule?: CustomRule;
  pending: boolean;
  onSave: (rule: CustomRule) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(rule?.name ?? "");
  const [measure, setMeasure] = useState<RuleMeasure>(rule?.measure ?? "sampleRate");
  const [operator, setOperator] = useState<RuleOperator>(rule?.operator ?? "atLeast");
  const [value, setValue] = useState(rule?.value ?? "");
  const [appliesTo, setAppliesTo] = useState<RuleScope>(rule?.appliesTo ?? "audio");
  const [severity, setSeverity] = useState<RuleSeverity>(rule?.severity ?? "warn");
  const [onUpload, setOnUpload] = useState(rule?.onUpload ?? false);
  const [invalid, setInvalid] = useState<string | null>(null);
  const operators = operatorsFor(measure);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = customRule.safeParse({
      id: rule?.id ?? crypto.randomUUID(),
      name,
      measure,
      operator,
      value,
      appliesTo,
      severity,
      on: rule?.on ?? true,
      onUpload,
    });
    if (!parsed.success) {
      setInvalid(parsed.error.issues[0]?.message ?? "Check the rule");
      return;
    }
    onSave(parsed.data);
  };

  const field = "flex flex-col gap-1.5 text-[13px] text-ink-2";
  return (
    <Dialog
      title={rule ? `Change ${rule.name}` : "New rule"}
      description="Measured on every recording the rule applies to; the finding carries your name for it."
      onClose={onClose}
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <label className={field}>
          Name
          <Input
            value={name}
            required
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            placeholder="Masters at 96 kHz"
          />
        </label>
        <div className="grid gap-3 @md/app:grid-cols-[minmax(0,1fr)_140px_minmax(0,1fr)]">
          <label className={field}>
            Measure
            <Select
              value={measure}
              onChange={(e) => {
                const next = e.target.value as RuleMeasure;
                setMeasure(next);
                if (!operatorsFor(next).includes(operator))
                  setOperator(operatorsFor(next)[0] ?? "is");
              }}
            >
              {ruleMeasureIds.map((m) => (
                <option key={m} value={m}>
                  {ruleMeasures[m].label}
                </option>
              ))}
            </Select>
          </label>
          <label className={field}>
            Comparison
            <Select value={operator} onChange={(e) => setOperator(e.target.value as RuleOperator)}>
              {operators.map((o) => (
                <option key={o} value={o}>
                  {ruleOperators[o]}
                </option>
              ))}
            </Select>
          </label>
          <label className={field}>
            {ruleMeasures[measure].unit ? `Value, ${ruleMeasures[measure].unit}` : "Value"}
            <Input
              value={value}
              required
              maxLength={100}
              onChange={(e) => setValue(e.target.value)}
              placeholder={placeholders[measure]}
            />
          </label>
        </div>
        <div className="grid gap-3 @md/app:grid-cols-2">
          <label className={field}>
            Applies to
            <Select value={appliesTo} onChange={(e) => setAppliesTo(e.target.value as RuleScope)}>
              {(Object.keys(ruleScopes) as RuleScope[]).map((s) => (
                <option key={s} value={s}>
                  {ruleScopes[s]}
                </option>
              ))}
            </Select>
          </label>
          <label className={field}>
            When it fails
            <Select value={severity} onChange={(e) => setSeverity(e.target.value as RuleSeverity)}>
              <option value="fail">An issue</option>
              <option value="warn">A warning</option>
              <option value="info">An advisory</option>
            </Select>
          </label>
        </div>
        <Choice
          checked={onUpload}
          onChange={(e) => setOnUpload(e.target.checked)}
          hint="A new version whose files fail it is refused, saying why, unless someone who edits the workflow lets it through."
        >
          Check it on upload
        </Choice>
        <p className="text-[12px] text-ink-3">
          A list is separated by commas; a range reads −16 to −14; a pattern takes * for anything
          and ? for one character, so ?* asks for a field to be filled in.
        </p>
        {invalid && <p className="text-[13px] text-signal">{invalid}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="md" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" size="md" disabled={pending}>
            {rule ? "Save" : "Add rule"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
