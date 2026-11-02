import type { SessionSummary, TakeNumbering } from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/choice";
import { DateField, TimeField } from "~/components/ui/date-field";
import { Dialog } from "~/components/ui/dialog";
import { Field } from "~/components/ui/field";
import { Input, Select } from "~/components/ui/input";
import { projectTracksQuery, useSessionMutations } from "~/lib/queries";
import { slotMoment, slotTime } from "~/lib/take-log";

/**
 * Making a session, or changing one: its name, day, place and the tracks it recorded. The one
 * form for a session wherever one is made (#652): Sessions, and the calendar's New entry.
 */
export function SessionDialog({
  projectId,
  session,
  initial,
  stay = false,
  onClose,
}: {
  projectId: string;
  session?: SessionSummary;
  /** What a new session starts with: the name and day typed where it was asked for. */
  initial?: { name?: string; recordedOn?: string };
  /** Stay where it was made (the calendar), rather than open the new session. */
  stay?: boolean;
  onClose: () => void;
}) {
  const { data: tracks = [] } = useQuery(projectTracksQuery(projectId));
  const { create, change } = useSessionMutations(projectId);
  const navigate = useNavigate();
  const [name, setName] = useState(session?.name ?? initial?.name ?? "");
  const [recordedOn, setRecordedOn] = useState(session?.recordedOn ?? initial?.recordedOn ?? "");
  const [venue, setVenue] = useState(session?.venue ?? "");
  const [numbering, setNumbering] = useState<TakeNumbering>(session?.numbering ?? "per-track");
  const [slotFrom, setSlotFrom] = useState(slotTime(session?.slotStart ?? null));
  const [slotTo, setSlotTo] = useState(slotTime(session?.slotEnd ?? null));
  const [chosen, setChosen] = useState<Set<string>>(
    new Set(session?.tracks.map((t) => t.id) ?? []),
  );
  const saving = create.isPending || change.isPending;
  const failure = create.error ?? change.error;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const input = {
      name: name.trim(),
      recordedOn: recordedOn || null,
      venue: venue.trim() || null,
      trackIds: [...chosen],
      numbering,
      slotStart: slotMoment(recordedOn || null, slotFrom),
      slotEnd: slotMoment(recordedOn || null, slotTo),
    };
    if (session) change.mutate({ id: session.id, ...input }, { onSuccess: onClose });
    else
      create.mutate(input, {
        onSuccess: (made) =>
          stay
            ? onClose()
            : void navigate({ to: "/sessions/$sessionId", params: { sessionId: made.id } }),
      });
  };
  const toggle = (id: string) =>
    setChosen((was) => {
      const next = new Set(was);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <Dialog
      title={session ? "Session" : "New session"}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="session"
            disabled={saving || name.trim() === ""}
          >
            {session ? "Save" : "Create session"}
          </Button>
        </>
      }
    >
      <form id="session" onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Name">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Day 2"
            maxLength={120}
            required
          />
        </Field>
        <div className="grid gap-4 @md/app:grid-cols-2">
          <Field label="Day">
            <DateField value={recordedOn} onChange={setRecordedOn} />
          </Field>
          <Field label="Where">
            <Input
              value={venue}
              onChange={(e) => setVenue(e.target.value)}
              placeholder="Endless Hall, studio 2"
              maxLength={200}
            />
          </Field>
        </div>
        <div className="grid gap-4 @md/app:grid-cols-3">
          <Field label="Slot from">
            <TimeField value={slotFrom} onChange={setSlotFrom} />
          </Field>
          <Field label="To">
            <TimeField value={slotTo} onChange={setSlotTo} />
          </Field>
          <Field label="Takes numbered">
            <Select
              value={numbering}
              onChange={(e) => setNumbering(e.target.value as TakeNumbering)}
            >
              <option value="per-track">Per track</option>
              <option value="continuous">On through the project</option>
              <option value="recorder">By the recorder</option>
            </Select>
          </Field>
        </div>
        {tracks.length > 0 && (
          <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
            <legend className="mb-1.5 p-0 text-[13px] text-ink-2">The tracks it recorded</legend>
            {tracks.map((t) => (
              <label key={t.id} className="flex items-center gap-2.5 text-[14px] text-ink">
                <Checkbox checked={chosen.has(t.id)} onChange={() => toggle(t.id)} />
                {t.name}
              </label>
            ))}
          </fieldset>
        )}
        {failure && (
          <p role="alert" className="m-0 text-[13px] text-signal">
            {failure.message}
          </p>
        )}
      </form>
    </Dialog>
  );
}
