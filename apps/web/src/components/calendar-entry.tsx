import {
  type CalendarEntry,
  type CalendarEntryInput,
  type CalendarEntryKind,
  calendarEntryKindLabels,
  calendarEntryKinds,
  capital,
} from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { PeoplePicker, type Person } from "~/components/people-picker";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import { Field } from "~/components/ui/field";
import { Input, Select } from "~/components/ui/input";
import { Segmented } from "~/components/ui/segmented";
import {
  projectMembersQuery,
  projectReviewsQuery,
  projectTracksQuery,
  useCalendarEntries,
  useItemWords,
  useProjectCan,
} from "~/lib/queries";

/** What an entry is about, as one choice: nothing, a track or a review. */
const aboutOf = (entry: Pick<CalendarEntry, "trackId" | "reviewId"> | undefined) =>
  entry?.trackId ? `track:${entry.trackId}` : entry?.reviewId ? `review:${entry.reviewId}` : "";

/**
 * A calendar entry (#505): a session, a delivery, a meeting or anything else dated, with its
 * title, day or range of days, what it is about and who is expected. New from the calendar's
 * button or a double-click on a day; opened again from the entry itself, where it can also be
 * removed. A session entry books a recording session under Production as it is made.
 */
export function EntryDialog({
  projectId,
  entry,
  day,
  onClose,
}: {
  projectId: string;
  /** The entry to change; none for a new one. */
  entry?: CalendarEntry;
  /** The day a new entry starts on, where one was chosen. */
  day?: string;
  onClose: () => void;
}) {
  const can = useProjectCan(projectId);
  const { words } = useItemWords(projectId);
  const { create, change, remove } = useCalendarEntries(projectId);
  const { data: members = [] } = useQuery(projectMembersQuery(projectId));
  const { data: tracks = [] } = useQuery(projectTracksQuery(projectId));
  const { data: reviews = [] } = useQuery(projectReviewsQuery(projectId));
  const [title, setTitle] = useState(entry?.title ?? "");
  const [kind, setKind] = useState<CalendarEntryKind>(entry?.kind ?? "meeting");
  const [startsOn, setStartsOn] = useState(entry?.startsOn ?? day ?? "");
  const [endsOn, setEndsOn] = useState(entry?.endsOn ?? "");
  const [about, setAbout] = useState(aboutOf(entry));
  const people: Person[] = members.map((m) => ({
    key: `member:${m.userId}`,
    name: m.name,
    hint: m.email,
    kind: "member",
  }));
  const [chosen, setChosen] = useState<Person[]>(() =>
    (entry?.attendees ?? []).map((a) => ({ key: `member:${a.id}`, name: a.name, kind: "member" })),
  );
  // Booking a session takes the sessions' own permission as well as the schedule's.
  const kinds = calendarEntryKinds.filter((k) => k !== "session" || can("edit_takes"));
  const pending = create.isPending || change.isPending || remove.isPending;
  const failure = create.error ?? change.error ?? remove.error;
  const backwards = Boolean(endsOn) && Boolean(startsOn) && endsOn < startsOn;
  const ready = title.trim().length > 0 && startsOn.length > 0 && !backwards;
  const save = () => {
    const input: CalendarEntryInput = {
      kind,
      title: title.trim(),
      startsOn,
      endsOn: endsOn && endsOn > startsOn ? endsOn : null,
      trackId: about.startsWith("track:") ? about.slice(6) : null,
      reviewId: about.startsWith("review:") ? about.slice(7) : null,
      attendees: chosen
        .filter((p) => p.kind === "member")
        .map((p) => p.key.slice("member:".length)),
    };
    if (entry) change.mutate({ id: entry.id, ...input }, { onSuccess: onClose });
    else create.mutate(input, { onSuccess: onClose });
  };
  return (
    <Dialog
      title={entry ? "Entry" : "New entry"}
      description={
        entry
          ? undefined
          : "A session, a delivery, a listening meeting: anything with a day that is not a review, a task or a deadline."
      }
      onClose={onClose}
      width="md"
      footer={
        <>
          {entry && (
            <Button
              variant="ghost"
              className="mr-auto text-signal hover:text-signal"
              disabled={pending}
              onClick={() => remove.mutate(entry.id, { onSuccess: onClose })}
            >
              Remove
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!ready || pending} onClick={save}>
            {entry ? "Save" : "Add entry"}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready && !pending) save();
        }}
      >
        <Field label="Title">
          <Input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Listening meeting with the label"
            maxLength={200}
          />
        </Field>
        <div className="flex flex-col gap-1.5 text-[13px] text-ink-2">
          <span>Kind</span>
          <Segmented
            label="Kind"
            className="self-start"
            value={kind}
            options={kinds.map((k) => ({ value: k, label: calendarEntryKindLabels[k] }))}
            onChange={setKind}
          />
          {kind === "session" && (
            <span className="text-[12px] text-ink-3">
              {entry?.sessionId
                ? "Its recording session under Production follows the title and the day."
                : "Books a recording session under Production, on the day it starts."}
            </span>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Starts">
            <Input type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />
          </Field>
          <Field
            label="Ends"
            hint="Leave empty for one day"
            error={backwards ? "On or after the day it starts" : undefined}
          >
            <Input
              type="date"
              value={endsOn}
              min={startsOn || undefined}
              onChange={(e) => setEndsOn(e.target.value)}
            />
          </Field>
        </div>
        <Field label="About" hint={`A ${words.track} or a review it concerns, if any`}>
          <Select value={about} onChange={(e) => setAbout(e.target.value)}>
            <option value="">Nothing in particular</option>
            {tracks.length > 0 && (
              <optgroup label={capital(words.tracks)}>
                {tracks.map((t) => (
                  <option key={t.id} value={`track:${t.id}`}>
                    {t.name}
                  </option>
                ))}
              </optgroup>
            )}
            {reviews.length > 0 && (
              <optgroup label="Reviews">
                {reviews.map((r) => (
                  <option key={r.id} value={`review:${r.id}`}>
                    {r.title}
                  </option>
                ))}
              </optgroup>
            )}
          </Select>
        </Field>
        <div className="flex flex-col gap-1.5 text-[13px] text-ink-2">
          <span>Attendees</span>
          <PeoplePicker
            label="Attendees"
            people={people}
            chosen={chosen}
            onChange={setChosen}
            placeholder="Members expected"
          />
        </div>
        {failure && (
          <p role="alert" className="m-0 text-[13px] text-signal">
            {failure.message}
          </p>
        )}
      </form>
    </Dialog>
  );
}
