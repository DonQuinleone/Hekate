import {
  alphabetical,
  type RepertoireOrder,
  type Venue,
  type Work,
  type WorkInput,
} from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useState } from "react";
import { Empty } from "~/components/empty";
import { Icon } from "~/components/icons";
import { ProductionNav } from "~/components/production-nav";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import { Field } from "~/components/ui/field";
import { Input, Textarea } from "~/components/ui/input";
import { ActionMenu, Dropdown } from "~/components/ui/menu";
import { repertoireQuery, useProjectCan, useRepertoire } from "~/lib/queries";
import { ProjectFrame } from "./project";

type Section = "repertoire" | "venues";

/** Production's frame for the repertoire and the venues: the tabs, and the role's refusal. */
function Frame({
  projectId,
  current,
  title,
  children,
}: {
  projectId: string;
  current: Section;
  title: string;
  children: (data: {
    canEdit: boolean;
    repertoire: NonNullable<ReturnType<typeof useRepertoireData>["data"]>;
  }) => ReactNode;
}) {
  const can = useProjectCan(projectId);
  const { data, error } = useRepertoireData(projectId, can("view_production"));
  return (
    <ProjectFrame projectId={projectId} title={title}>
      {(project) => (
        <div className="fade-in mx-auto flex w-full max-w-[1100px] flex-col gap-5 px-5 py-6 @3xl/app:px-10">
          <ProductionNav projectId={projectId} current={current} can={can} />
          {!can("view_production") ? (
            <Empty
              title="Not among what your role shows"
              text="The repertoire and venues are shown to the roles the project's access gives the production tools."
            />
          ) : error ? (
            <p className="m-0 text-signal">{error.message}</p>
          ) : !data ? (
            <p className="m-0 text-ink-3">Loading</p>
          ) : (
            children({
              canEdit: can("edit_production") && !project.archivedAt,
              repertoire: data,
            })
          )}
        </div>
      )}
    </ProjectFrame>
  );
}

const useRepertoireData = (projectId: string, enabled: boolean) =>
  useQuery({ ...repertoireQuery(projectId), enabled });

/**
 * The repertoire (#48), in Production as the prototype has it: the project's works, each with
 * its tracks in order and numbered as the score prints them.
 */
export function RepertoirePage({ projectId }: { projectId: string }) {
  return (
    <Frame projectId={projectId} current="repertoire" title="Repertoire">
      {({ canEdit, repertoire }) => (
        <Works
          projectId={projectId}
          works={repertoire.works}
          tracks={repertoire.tracks}
          canEdit={canEdit}
        />
      )}
    </Frame>
  );
}

function Works({
  projectId,
  works,
  tracks,
  canEdit,
}: {
  projectId: string;
  works: Work[];
  tracks: { id: string; name: string }[];
  canEdit: boolean;
}) {
  const { changeWork, removeWork } = useRepertoire(projectId);
  const [order, setOrder] = useState<RepertoireOrder>("schedule");
  const [editing, setEditing] = useState<"new" | Work | null>(null);
  const shown = order === "alphabetical" ? alphabetical(works) : works;
  const asInput = (w: Work): WorkInput => ({
    title: w.title,
    composer: w.composer,
    forces: w.forces,
    abbreviation: w.abbreviation,
    notes: w.notes,
    tracks: w.tracks.map(({ trackId, number }) => ({ trackId, number })),
  });
  return (
    <>
      {works.length === 0 ? (
        <Empty
          title="No works yet"
          text="A work holds its tracks in order, numbered as the score prints them."
          action={
            canEdit ? (
              <Button variant="primary" onClick={() => setEditing("new")}>
                Add a work
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-2">
            <span className="label">Works · {works.length}</span>
            <span className="ml-auto flex items-center gap-1">
              <Dropdown
                value={order === "alphabetical" ? "Alphabetical" : "Schedule order"}
                align="right"
                label="Order"
                actions={[
                  {
                    label: "Schedule order",
                    checked: order === "schedule",
                    onSelect: () => setOrder("schedule"),
                  },
                  {
                    label: "Alphabetical",
                    checked: order === "alphabetical",
                    onSelect: () => setOrder("alphabetical"),
                  },
                ]}
              />
              {canEdit && (
                <Button variant="secondary" size="md" onClick={() => setEditing("new")}>
                  <Icon name="plus" size={14} />
                  Work
                </Button>
              )}
            </span>
          </div>
          {shown.map((w) => (
            <section
              key={w.id}
              aria-label={w.title}
              className="rounded-panel-lg border border-line bg-raised/25 shadow-1"
            >
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line px-4 py-3">
                <h2 className="m-0 text-[16px] font-medium text-ink">{w.title}</h2>
                <span className="text-[13px] text-ink-3">
                  {[w.composer, w.forces, w.abbreviation].filter(Boolean).join(" · ")}
                </span>
                {canEdit && (
                  <span className="ml-auto">
                    <ActionMenu
                      always
                      label={w.title}
                      actions={[
                        { label: "Edit", onSelect: () => setEditing(w) },
                        "divider",
                        { label: "Delete", danger: true, onSelect: () => removeWork.mutate(w.id) },
                      ]}
                    />
                  </span>
                )}
              </div>
              {w.notes && <p className="m-0 px-4 pt-3 text-[13px] text-ink-2">{w.notes}</p>}
              {w.tracks.length === 0 ? (
                <p className="m-0 px-4 py-3 text-[13px] text-ink-3">
                  No tracks yet.{canEdit ? " Edit the work to add them in order." : ""}
                </p>
              ) : (
                <ol className="m-0 flex list-none flex-col divide-y divide-line px-2 py-2">
                  {w.tracks.map((t, i) => (
                    <li
                      key={t.trackId}
                      className="grid grid-cols-[40px_minmax(0,1fr)] items-center gap-3 px-2 py-1.5 text-[14px]"
                    >
                      {canEdit ? (
                        // Numbered as the score prints it, typed in place.
                        <Input
                          key={`${t.trackId}-${t.number}`}
                          defaultValue={t.number}
                          aria-label={`Number of ${t.name}`}
                          maxLength={12}
                          className="h-7 w-10 px-0 text-center text-[13px]"
                          onBlur={(e) => {
                            const number = e.target.value.trim();
                            if (number === t.number) return;
                            const input = asInput(w);
                            changeWork.mutate({
                              id: w.id,
                              ...input,
                              tracks: input.tracks?.map((x, j) => (j === i ? { ...x, number } : x)),
                            });
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") e.currentTarget.blur();
                          }}
                        />
                      ) : (
                        <span className="tabular text-center text-[13px] text-ink-3">
                          {t.number}
                        </span>
                      )}
                      <Link
                        to="/tracks/$trackId"
                        params={{ trackId: t.trackId }}
                        className="truncate text-ink no-underline hover:text-signal"
                      >
                        {t.name}
                      </Link>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          ))}
        </div>
      )}
      {editing && (
        <WorkDialog
          projectId={projectId}
          work={editing === "new" ? undefined : editing}
          tracks={tracks}
          taken={
            new Set(
              works
                .filter((w) => editing === "new" || w.id !== editing.id)
                .flatMap((w) => w.tracks.map((t) => t.trackId)),
            )
          }
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

/** A work's details and its tracks in order: added from the project's tracks not in another work. */
function WorkDialog({
  projectId,
  work,
  tracks,
  taken,
  onClose,
}: {
  projectId: string;
  work?: Work;
  tracks: { id: string; name: string }[];
  taken: Set<string>;
  onClose: () => void;
}) {
  const { addWork, changeWork } = useRepertoire(projectId);
  const [title, setTitle] = useState(work?.title ?? "");
  const [composer, setComposer] = useState(work?.composer ?? "");
  const [forces, setForces] = useState(work?.forces ?? "");
  const [abbreviation, setAbbreviation] = useState(work?.abbreviation ?? "");
  const [notes, setNotes] = useState(work?.notes ?? "");
  const [chosen, setChosen] = useState(
    work?.tracks.map(({ trackId, number }) => ({ trackId, number })) ?? [],
  );
  const saving = work ? changeWork : addWork;
  const nameOf = (id: string) => tracks.find((t) => t.id === id)?.name ?? "A track";
  const free = tracks.filter((t) => !taken.has(t.id) && !chosen.some((c) => c.trackId === t.id));
  const move = (i: number, by: number) =>
    setChosen((all) => {
      const next = [...all];
      const [it] = next.splice(i, 1);
      if (it) next.splice(i + by, 0, it);
      return next;
    });
  const save = (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    const input = { title, composer, forces, abbreviation, notes, tracks: chosen };
    if (work) changeWork.mutate({ id: work.id, ...input }, { onSuccess: onClose });
    else addWork.mutate(input, { onSuccess: onClose });
  };
  return (
    <Dialog
      title={work ? `Edit ${work.title}` : "Add a work"}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="work"
            disabled={!title.trim() || saving.isPending}
          >
            {work ? "Save" : "Add"}
          </Button>
        </>
      }
    >
      <form id="work" onSubmit={save} className="grid grid-cols-1 gap-3 @xl/app:grid-cols-2">
        <Field label="Title" error={saving.error?.message}>
          <Input
            autoFocus
            value={title}
            maxLength={160}
            placeholder="Rags"
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>
        <Field label="Composer">
          <Input
            value={composer}
            maxLength={120}
            placeholder="Scott Joplin"
            onChange={(e) => setComposer(e.target.value)}
          />
        </Field>
        <Field label="Forces">
          <Input
            value={forces}
            maxLength={160}
            placeholder="Piano trio"
            onChange={(e) => setForces(e.target.value)}
          />
        </Field>
        <Field label="Abbreviation" hint="As the schedule shows it">
          <Input
            value={abbreviation}
            maxLength={16}
            placeholder="RAGS"
            onChange={(e) => setAbbreviation(e.target.value)}
          />
        </Field>
        <Field label="Notes" className="@xl/app:col-span-2">
          <Textarea
            value={notes}
            rows={2}
            maxLength={2000}
            onChange={(e) => setNotes(e.target.value)}
          />
        </Field>
        <div className="flex flex-col gap-2 @xl/app:col-span-2">
          <span className="label">Tracks, in order</span>
          {chosen.length === 0 && (
            <p className="m-0 text-[13px] text-ink-3">
              None yet. A single-track work is just one track.
            </p>
          )}
          <ol className="m-0 flex list-none flex-col gap-1.5 p-0">
            {chosen.map((c, i) => (
              <li key={c.trackId} className="flex items-center gap-2">
                <Input
                  aria-label={`Number of ${nameOf(c.trackId)}`}
                  value={c.number}
                  maxLength={12}
                  placeholder={String(i + 1)}
                  className="w-14 text-center"
                  onChange={(e) =>
                    setChosen((all) =>
                      all.map((x, j) => (j === i ? { ...x, number: e.target.value } : x)),
                    )
                  }
                />
                <span className="min-w-0 flex-1 truncate text-[14px] text-ink">
                  {nameOf(c.trackId)}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={i === 0}
                  aria-label={`Move ${nameOf(c.trackId)} up`}
                  onClick={() => move(i, -1)}
                >
                  Up
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={i === chosen.length - 1}
                  aria-label={`Move ${nameOf(c.trackId)} down`}
                  onClick={() => move(i, 1)}
                >
                  Down
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Take ${nameOf(c.trackId)} out`}
                  onClick={() => setChosen((all) => all.filter((_, j) => j !== i))}
                >
                  <Icon name="close" size={12} />
                </Button>
              </li>
            ))}
          </ol>
          {free.length > 0 && (
            <div>
              <Dropdown
                value="Add a track"
                size="sm"
                actions={free.map((t) => ({
                  label: t.name,
                  onSelect: () =>
                    setChosen((all) => [...all, { trackId: t.id, number: String(all.length + 1) }]),
                }))}
              />
            </div>
          )}
        </div>
      </form>
    </Dialog>
  );
}

/** The venues (#48), in Production as the prototype has them: a name, an address and notes. */
export function VenuesPage({ projectId }: { projectId: string }) {
  return (
    <Frame projectId={projectId} current="venues" title="Venues">
      {({ canEdit, repertoire }) => (
        <Venues projectId={projectId} venues={repertoire.venues} canEdit={canEdit} />
      )}
    </Frame>
  );
}

function Venues({
  projectId,
  venues,
  canEdit,
}: {
  projectId: string;
  venues: Venue[];
  canEdit: boolean;
}) {
  const { removeVenue } = useRepertoire(projectId);
  const [editing, setEditing] = useState<"new" | Venue | null>(null);
  return (
    <>
      {venues.length === 0 ? (
        <Empty
          title="No venues yet"
          text="A venue has an address and notes for the get-in."
          action={
            canEdit ? (
              <Button variant="primary" onClick={() => setEditing("new")}>
                Add a venue
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <span className="label">Venues · {venues.length}</span>
            {canEdit && (
              <Button
                variant="secondary"
                size="md"
                className="ml-auto"
                onClick={() => setEditing("new")}
              >
                <Icon name="plus" size={14} />
                Venue
              </Button>
            )}
          </div>
          <ul className="-mx-2 m-0 flex list-none flex-col p-0">
            {venues.map((v) => (
              <li
                key={v.id}
                className="group flex items-start gap-3 rounded-panel px-2 py-2.5 transition-colors hover:bg-raised/60"
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-panel bg-raised text-ink-2">
                  <Icon name="pin" size={16} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] font-medium text-ink">{v.name}</span>
                  {v.address && (
                    <span className="block text-[13px] text-ink-3">
                      {v.address.split("\n").filter(Boolean).join(", ")}
                    </span>
                  )}
                  {v.notes && <span className="block text-[13px] text-ink-2">{v.notes}</span>}
                </span>
                {canEdit && (
                  <ActionMenu
                    label={v.name}
                    actions={[
                      { label: "Edit", onSelect: () => setEditing(v) },
                      "divider",
                      { label: "Delete", danger: true, onSelect: () => removeVenue.mutate(v.id) },
                    ]}
                  />
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {editing && (
        <VenueDialog
          projectId={projectId}
          venue={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

function VenueDialog({
  projectId,
  venue,
  onClose,
}: {
  projectId: string;
  venue?: Venue;
  onClose: () => void;
}) {
  const { addVenue, changeVenue } = useRepertoire(projectId);
  const [name, setName] = useState(venue?.name ?? "");
  const [address, setAddress] = useState(venue?.address ?? "");
  const [notes, setNotes] = useState(venue?.notes ?? "");
  const saving = venue ? changeVenue : addVenue;
  const save = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    const input = { name, address, notes };
    if (venue) changeVenue.mutate({ id: venue.id, ...input }, { onSuccess: onClose });
    else addVenue.mutate(input, { onSuccess: onClose });
  };
  return (
    <Dialog
      title={venue ? `Edit ${venue.name}` : "Add a venue"}
      onClose={onClose}
      width="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="venue"
            disabled={!name.trim() || saving.isPending}
          >
            {venue ? "Save" : "Add"}
          </Button>
        </>
      }
    >
      <form id="venue" onSubmit={save} className="flex flex-col gap-3">
        <Field label="Name" error={saving.error?.message}>
          <Input
            autoFocus
            value={name}
            maxLength={120}
            placeholder="Endless Hall"
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Address" hint="A line each, as on an envelope">
          <Textarea
            value={address}
            rows={3}
            maxLength={600}
            placeholder={"Mill Lane\nBristol"}
            onChange={(e) => setAddress(e.target.value)}
          />
        </Field>
        <Field label="Notes">
          <Textarea
            value={notes}
            rows={2}
            maxLength={2000}
            placeholder="Get-in by the north door"
            onChange={(e) => setNotes(e.target.value)}
          />
        </Field>
      </form>
    </Dialog>
  );
}
