import {
  type BuiltInCheck,
  builtInChecks,
  type CustomRule,
  categoryOf,
  customRule,
  deliveryChecks,
  isDeliveryCheck,
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
import { Icon } from "./icons";
import { checkNames } from "./qa";
import { Section } from "./settings";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
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
  format: "Sample rate, bit depth and layout against the delivery profile",
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

/** One rule in a category: how hard it bites and, where it may, whether it runs. Dense on purpose. */
function RuleRow({
  name,
  hint,
  tag,
  severity,
  on,
  fixed,
  builtIn = false,
  disabled,
  onSeverity,
  onSwitch,
  menu,
}: {
  name: string;
  hint?: string;
  tag?: string;
  /** Null leaves it as the check reports it (a built-in check only). */
  severity: RuleSeverity | null;
  on: boolean;
  /** Always on: only its severity moves. */
  fixed?: boolean;
  /** A built-in check, which may keep the severity it reports itself. */
  builtIn?: boolean;
  disabled: boolean;
  onSeverity: (severity: RuleSeverity | null) => void;
  onSwitch: (on: boolean) => void;
  menu?: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-2">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-[13px]">
          <span className={cn("truncate", on ? "text-ink" : "text-ink-3")}>{name}</span>
          {tag && (
            <span className="hidden shrink-0 truncate rounded-chip border border-line px-1.5 text-[11px] text-ink-3 @3xl/app:inline">
              {tag}
            </span>
          )}
        </div>
        {hint && <div className="truncate text-[12px] text-ink-3">{hint}</div>}
      </div>
      <div className="flex items-center gap-3">
        <Select
          size="sm"
          value={severity ?? ""}
          aria-label={`Severity of ${name}`}
          className="w-32"
          disabled={disabled || !on}
          onChange={(e) => onSeverity((e.target.value || null) as RuleSeverity | null)}
        >
          {builtIn && <option value="">As measured</option>}
          {ruleSeverities.map((sv) => (
            <option key={sv} value={sv}>
              {severityLabel[sv]}
            </option>
          ))}
        </Select>
        {fixed ? (
          <span className="w-9 text-right text-[12px] text-ink-3">always</span>
        ) : (
          <Switch label={name} checked={on} disabled={disabled} onChange={onSwitch} />
        )}
        {menu ?? <span className="hidden w-8 @3xl/app:block" />}
      </div>
    </div>
  );
}

/**
 * The project's QA rules (#144), by category: the built-in checks (signal checks always on,
 * the delivery checks as one switch and each on its own), and rules of the project's own.
 * Read against stored measurements, so a change shows in every report at once.
 */
export function QaRules({ project }: { project: Project }) {
  const can = useProjectCan(project.id);
  const edit = can("edit_workflows");
  const update = useUpdateProject(project.id);
  const settings = qaSettingsOf(project.qaSettings);
  const [editing, setEditing] = useState<CustomRule | "new" | null>(null);
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

  return (
    <>
      <Section
        title="Checks"
        intro="Errors are always on: choose how hard each bites. Delivery checks and your own rules sit in the same categories and switch off individually."
        action={
          <span className="flex items-center gap-3">
            <span className="flex items-center gap-2 text-[13px] text-ink-2">
              <span className="hidden @3xl/app:inline">Delivery checks</span>
              <Switch
                label="Delivery checks"
                checked={settings.delivery}
                disabled={busy}
                onChange={(delivery) => save({ ...settings, delivery })}
              />
            </span>
            {edit && (
              <Button variant="secondary" size="md" onClick={() => setEditing("new")}>
                <Icon name="plus" size={14} />
                Rule
              </Button>
            )}
          </span>
        }
      >
        {qaCategories.map((category) => {
          const checks = builtInChecks.filter(
            (c) => categoryOf(c) === category && (settings.delivery || !isDeliveryCheck(c)),
          );
          const custom = settings.rules.filter((r) => ruleCategory(r) === category);
          const count = checks.length + custom.length;
          if (count === 0) return null;
          return (
            <div key={category} className="flex flex-col divide-y divide-line/60">
              <div className="flex items-baseline gap-2 bg-raised/30 px-4 py-1.5">
                <span className="text-[13px] font-medium text-ink">
                  {categoryCopy[category].label}
                </span>
                <span className="hidden truncate text-[12px] text-ink-3 @3xl/app:inline">
                  {categoryCopy[category].hint}
                </span>
                <span className="tabular ml-auto text-[12px] text-ink-3">{count}</span>
              </div>
              {checks.map((check) => {
                const own = checkOf(check);
                const delivery = isDeliveryCheck(check);
                return (
                  <RuleRow
                    key={check}
                    name={checkNames[check]}
                    hint={checkHints[check]}
                    tag={delivery ? "delivery" : undefined}
                    severity={own?.severity ?? null}
                    on={delivery ? (own?.on ?? true) : true}
                    fixed={!delivery}
                    builtIn
                    disabled={busy}
                    onSeverity={(severity) => setCheck(check, { severity })}
                    onSwitch={(on) => setCheck(check, { on })}
                  />
                );
              })}
              {custom.map((rule) => (
                <RuleRow
                  key={rule.id}
                  name={rule.name}
                  hint={`${asked(rule)} · ${ruleScopes[rule.appliesTo]}`}
                  tag="yours"
                  severity={rule.severity}
                  on={rule.on}
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
                            label: "Delete",
                            danger: true,
                            onSelect: () =>
                              save({
                                ...settings,
                                rules: settings.rules.filter((r) => r.id !== rule.id),
                              }),
                          },
                        ]}
                      />
                    ) : undefined
                  }
                />
              ))}
            </div>
          );
        })}
      </Section>
      {update.error && <p className="-mt-6 text-[13px] text-signal">{update.error.message}</p>}
      <p className="-mt-6 text-[13px] text-ink-3">
        {settings.delivery
          ? "Delivery checks follow what distributors and aggregators refuse or query at delivery, against the delivery profile."
          : `${deliveryChecks.length} delivery checks are off: switch them on when this project delivers through a distributor.`}{" "}
        Video and artwork rules arrive with their checks.
      </p>
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
