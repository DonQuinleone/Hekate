import {
  admHeading,
  admLine,
  type EmbeddedMetadata,
  type MetadataChanges,
  type MetadataCorrections,
  type MetadataField,
  type MetadataGroup,
  metadataFieldSpecs,
  metadataRows,
  metadataValueOf,
  metadataValueProblem,
  samplesOfTimecode,
  timecodeOf,
} from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { cn } from "~/lib/cn";
import { metadataQuery, useMetadataEdit } from "~/lib/metadata";
import { Button } from "./ui/button";
import { Field } from "./ui/field";
import { Input } from "./ui/input";

/** The fields behind each row the panel shows: Origination is a date and a time. */
const rowFields = (label: string): MetadataField[] =>
  label === "Origination"
    ? ["originationDate", "originationTime"]
    : (Object.keys(metadataFieldSpecs) as MetadataField[]).filter(
        (f) => metadataFieldSpecs[f].label === label,
      );

const groupNames: Record<MetadataGroup, string> = {
  bext: "Broadcast Wave",
  ixml: "iXML",
  tags: "Tags",
};

/**
 * A recording's embedded metadata on the QA view (#41), as the prototype's panel lists it, and
 * for those who may, its editor (decision 264): opened by Edit beside the heading where the
 * person has turned it on (Appearance, Metadata editor in QA).
 */
export function EmbeddedMetadataPanel({
  fileId,
  metadata,
  sampleRate,
  editor,
}: {
  fileId: string;
  metadata: EmbeddedMetadata;
  sampleRate?: number;
  /** Whether the person's preferences and role offer the editor at all. */
  editor: boolean;
}) {
  const { data: editing } = useQuery({ ...metadataQuery(fileId), enabled: editor });
  const save = useMetadataEdit(fileId);
  const [open, setOpen] = useState(false);
  const corrections = editor ? (editing?.corrections ?? {}) : {};
  const corrected = (label: string) => rowFields(label).some((f) => f in corrections);
  const canEdit = editor && Boolean(editing?.editable) && (editing?.fields.length ?? 0) > 0;
  return (
    <section aria-label="Embedded metadata" className="flex flex-col gap-3 pt-2">
      <div className="flex items-center justify-between gap-3">
        <h2 className="m-0 text-[15px] font-medium">Embedded metadata</h2>
        {canEdit && !open && (
          <Button variant="quiet" size="sm" onClick={() => setOpen(true)}>
            Edit
          </Button>
        )}
      </div>
      {open && editing ? (
        <MetadataForm
          fields={editing.fields}
          metadata={metadata}
          corrections={editing.corrections}
          sampleRate={sampleRate}
          saving={save.isPending}
          error={save.error?.message ?? null}
          onCancel={() => {
            save.reset();
            setOpen(false);
          }}
          onSave={(changes) => {
            if (Object.keys(changes).length === 0) return setOpen(false);
            save.mutate(changes, { onSuccess: () => setOpen(false) });
          }}
        />
      ) : (
        <dl className="m-0 flex flex-col border-t border-hairline">
          {metadataRows(metadata, sampleRate).map(([term, value]) => (
            <div
              key={term}
              className="grid grid-cols-[minmax(0,140px)_1fr] gap-x-6 border-b border-hairline py-2.5"
            >
              <dt className="label">{term}</dt>
              <dd className="tabular m-0 flex min-w-0 items-baseline gap-2 text-[13px] text-ink-2">
                <span className="truncate" title={value}>
                  {value}
                </span>
                {corrected(term) && (
                  <span className="shrink-0 text-[12px] text-ink-3">Corrected</span>
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {!open && Object.keys(corrections).length > 0 && (
        <p className="m-0 text-[12px] text-ink-3">
          Corrected in Hekate. The stored original is unchanged; its downloads carry the
          corrections.
        </p>
      )}
      {metadata.adm && (
        <div className="flex flex-col gap-1 pt-1">
          <h3 className="label m-0">{admHeading(metadata.adm)}</h3>
          <p className="m-0 text-[13px] text-ink-2">{admLine(metadata.adm)}</p>
        </div>
      )}
    </section>
  );
}

/** A field's value as the form shows it: a time reference as timecode. */
function shown(
  field: MetadataField,
  value: string | undefined,
  sampleRate?: number,
  rate?: string,
) {
  if (value === undefined) return "";
  if (field === "timeReference" && sampleRate) return timecodeOf(Number(value), sampleRate, rate);
  return value;
}

/**
 * The editor: each field the file's format can hold, grouped as the file keeps them, each
 * corrected one saying what the file itself says, with a way back to it. Saving sends only
 * what changed; Escape leaves without saving.
 */
export function MetadataForm({
  fields,
  metadata,
  corrections,
  sampleRate,
  saving,
  error,
  onSave,
  onCancel,
}: {
  fields: MetadataField[];
  metadata: EmbeddedMetadata;
  corrections: MetadataCorrections;
  sampleRate?: number;
  saving: boolean;
  error: string | null;
  onSave: (changes: MetadataChanges["changes"]) => void;
  onCancel: () => void;
}) {
  const rate = metadata.ixml?.timecodeRate;
  const initial = Object.fromEntries(
    fields.map((f) => [f, shown(f, metadataValueOf(metadata, f), sampleRate, rate)]),
  ) as Record<MetadataField, string>;
  const [draft, setDraft] = useState(initial);
  const [problems, setProblems] = useState<Partial<Record<MetadataField, string>>>({});
  /** Fields put back as the file has them: sent as such, not as a value typed again. */
  const [restored, setRestored] = useState<ReadonlySet<MetadataField>>(new Set());

  /** What a field's typed value is sent as: a timecode as samples since midnight. */
  const sent = (field: MetadataField, typed: string): string | null => {
    const value = typed.trim();
    if (field !== "timeReference" || value === "" || !sampleRate) return value;
    const samples = samplesOfTimecode(value, sampleRate, rate);
    return samples === null ? null : String(samples);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const found: Partial<Record<MetadataField, string>> = {};
    const changes: MetadataChanges["changes"] = {};
    for (const field of fields) {
      if (draft[field].trim() === initial[field].trim()) continue;
      if (restored.has(field)) {
        changes[field] = null;
        continue;
      }
      const value = sent(field, draft[field]);
      const problem =
        value === null
          ? rate
            ? "Timecode as 10:00:00:00"
            : "Timecode as 10:00:00"
          : metadataValueProblem(field, value);
      if (problem) found[field] = problem;
      else if (value !== null) changes[field] = value;
    }
    setProblems(found);
    if (Object.keys(found).length === 0) onSave(changes);
  };

  const groups = (["bext", "ixml", "tags"] as const)
    .map((group) => ({
      group,
      fields: fields.filter((f) => metadataFieldSpecs[f].group === group),
    }))
    .filter((g) => g.fields.length > 0);

  return (
    <form
      aria-label="Edit embedded metadata"
      className="@container flex flex-col gap-5 border-t border-hairline pt-4"
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      {groups.map(({ group, fields: these }) => (
        <fieldset key={group} className="m-0 flex flex-col gap-3 border-0 p-0">
          {groups.length > 1 && <legend className="label mb-1 p-0">{groupNames[group]}</legend>}
          <div className="grid gap-3 @lg:grid-cols-2">
            {these.map((field) => {
              const correction = corrections[field];
              const fromFile = correction
                ? shown(field, correction.read ?? undefined, sampleRate, rate)
                : null;
              return (
                <div
                  key={field}
                  className={cn(
                    "flex min-w-0 flex-col gap-1",
                    field === "description" && "@lg:col-span-2",
                  )}
                >
                  <Field
                    label={metadataFieldSpecs[field].label}
                    error={problems[field]}
                    hint={
                      field === "timeReference" && !correction
                        ? "Timecode where the recording starts"
                        : undefined
                    }
                  >
                    <Input
                      value={draft[field]}
                      aria-invalid={problems[field] ? true : undefined}
                      maxLength={field === "timeReference" ? 14 : metadataFieldSpecs[field].max}
                      onChange={(event) => {
                        const value = event.target.value;
                        setDraft((d) => ({ ...d, [field]: value }));
                        setRestored((r) => {
                          const next = new Set(r);
                          next.delete(field);
                          return next;
                        });
                      }}
                    />
                  </Field>
                  {correction && (
                    <div className="flex min-w-0 items-center justify-between gap-2 text-[12px] text-ink-3">
                      <span className="truncate">In the file: {fromFile || "nothing"}</span>
                      <Button
                        variant="quiet"
                        size="sm"
                        aria-label={`Restore ${metadataFieldSpecs[field].label} as the file has it`}
                        onClick={() => {
                          setDraft((d) => ({ ...d, [field]: fromFile ?? "" }));
                          setRestored((r) => new Set(r).add(field));
                        }}
                      >
                        Restore
                      </Button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </fieldset>
      ))}
      {error && (
        <p role="alert" className="m-0 text-[13px] text-signal">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button type="submit" variant="primary" size="sm" disabled={saving}>
          {saving ? "Saving" : "Save"}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <span className="text-[12px] text-ink-3">
          Kept by Hekate and written into downloads; the stored original is never changed.
        </span>
      </div>
    </form>
  );
}
