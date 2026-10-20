import { formatDuration, type SessionSummary, type TakeNumbering } from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { Empty } from "~/components/empty";
import { Icon } from "~/components/icons";
import { PageHeader } from "~/components/page-header";
import { ProductionNav } from "~/components/production-nav";
import { TakeImportDialog } from "~/components/take-import";
import { Rating } from "~/components/takes";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/choice";
import { Dialog } from "~/components/ui/dialog";
import { Field } from "~/components/ui/field";
import { Input, Select } from "~/components/ui/input";
import { ActionMenu } from "~/components/ui/menu";
import { formatDates } from "~/lib/locale";
import {
  projectQuery,
  projectSessionsQuery,
  projectTracksQuery,
  sessionQuery,
  useProjectCan,
  useSessionMutations,
} from "~/lib/queries";
import { slotMoment, slotTime } from "~/lib/take-log";
import { ProjectFrame } from "~/routes/project";

const body =
  "fade-in mx-auto flex w-full max-w-[1360px] flex-col gap-6 px-5 py-6 @3xl/app:px-10 @3xl/app:py-8";

const dayFormat = formatDates({ day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

/** "14 October 2026", from the day a session was recorded: a date has no time zone, so UTC. */
const dayOf = (iso: string) => dayFormat.format(new Date(`${iso}T12:00:00Z`));

/** "14 October 2026 · Endless Hall", as far as the session says. */
const whenAndWhere = (s: Pick<SessionSummary, "recordedOn" | "venue">) =>
  [s.recordedOn ? dayOf(s.recordedOn) : null, s.venue].filter(Boolean).join(" · ");

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * A project's recording sessions (#21, #45), in its Production area as the prototype has them:
 * each day or sitting with where it was, the tracks it recorded and its takes counted.
 */
export function SessionsPage({ projectId }: { projectId: string }) {
  const can = useProjectCan(projectId);
  const [making, setMaking] = useState(false);
  const [importing, setImporting] = useState(false);
  const { data: sessions, error } = useQuery({
    ...projectSessionsQuery(projectId),
    enabled: can("view_takes"),
  });
  const canEdit = can("edit_takes");
  // Importing uploads the takes' files, which needs the project's upload permission too.
  const canImport = canEdit && can("upload");
  return (
    <ProjectFrame
      projectId={projectId}
      title="Sessions"
      actions={
        canEdit && sessions && sessions.length > 0 ? (
          <>
            <Button variant="secondary" size="sm" onClick={() => setMaking(true)}>
              <Icon name="plus" size={14} />
              New session
            </Button>
            {canImport && (
              <Button variant="secondary" size="sm" onClick={() => setImporting(true)}>
                <Icon name="upload" size={14} />
                Import takes
              </Button>
            )}
          </>
        ) : undefined
      }
    >
      {(project) => (
        <div className={body}>
          <ProductionNav projectId={projectId} current="sessions" can={can} />
          {!can("view_takes") ? (
            <Empty
              title="Not among what your role shows"
              text="Sessions and takes are shown to the roles the project's access gives them."
            />
          ) : error ? (
            <p className="m-0 text-signal">{error.message}</p>
          ) : !sessions ? (
            <p className="m-0 text-ink-3">Loading</p>
          ) : sessions.length === 0 ? (
            <Empty
              title="No sessions yet"
              text="A session is a day or a sitting: where it was, the tracks it recorded, and the takes made in it. Import a day's recordings to make them, or make one by hand."
              action={
                canEdit && !project.archivedAt ? (
                  <span className="flex flex-wrap justify-center gap-2">
                    {canImport && (
                      <Button variant="primary" onClick={() => setImporting(true)}>
                        Import takes
                      </Button>
                    )}
                    <Button
                      variant={canImport ? "secondary" : "primary"}
                      onClick={() => setMaking(true)}
                    >
                      New session
                    </Button>
                  </span>
                ) : undefined
              }
            />
          ) : (
            <ul aria-label="Sessions" className="-mx-2 m-0 flex list-none flex-col p-0">
              {sessions.map((s) => (
                <li key={s.id}>
                  <Link
                    to="/sessions/$sessionId"
                    params={{ sessionId: s.id }}
                    className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3.5 rounded-panel px-2 py-2.5 no-underline transition-colors hover:bg-raised/60 @3xl/app:grid-cols-[auto_minmax(0,1fr)_160px_120px_100px]"
                  >
                    <span className="flex size-9 items-center justify-center rounded-panel bg-raised text-ink-2">
                      <Icon name="mic" size={16} />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-[14px] font-medium text-ink">
                        {s.name}
                      </span>
                      <span className="block truncate text-[13px] text-ink-3">
                        {whenAndWhere(s) || "No day or place given"}
                      </span>
                    </span>
                    <span className="hidden text-[13px] text-ink-3 @3xl/app:block">
                      {s.takes === 0
                        ? "No takes yet"
                        : `${count(s.takes, "take")}${s.starred > 0 ? ` · ${s.starred} starred` : ""}`}
                    </span>
                    <span className="hidden text-[13px] text-ink-3 @3xl/app:block">
                      {s.tracks.length === 0 ? "No tracks" : count(s.tracks.length, "track")}
                    </span>
                    <span className="tabular text-right text-[13px] text-ink-3">
                      {s.takes > 0 ? formatDuration(s.duration) : ""}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {making && <SessionDialog projectId={project.id} onClose={() => setMaking(false)} />}
          {importing && (
            <TakeImportDialog projectId={project.id} onClose={() => setImporting(false)} />
          )}
        </div>
      )}
    </ProjectFrame>
  );
}

/** Making a session, or changing one: its name, day, place and the tracks it recorded. */
function SessionDialog({
  projectId,
  session,
  onClose,
}: {
  projectId: string;
  session?: SessionSummary;
  onClose: () => void;
}) {
  const { data: tracks = [] } = useQuery(projectTracksQuery(projectId));
  const { create, change } = useSessionMutations(projectId);
  const navigate = useNavigate();
  const [name, setName] = useState(session?.name ?? "");
  const [recordedOn, setRecordedOn] = useState(session?.recordedOn ?? "");
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
          void navigate({ to: "/sessions/$sessionId", params: { sessionId: made.id } }),
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
            {session ? "Save" : "Make the session"}
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
            <Input type="date" value={recordedOn} onChange={(e) => setRecordedOn(e.target.value)} />
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
            <Input type="time" value={slotFrom} onChange={(e) => setSlotFrom(e.target.value)} />
          </Field>
          <Field label="To">
            <Input type="time" value={slotTo} onChange={(e) => setSlotTo(e.target.value)} />
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

/**
 * One recording session (#21, #45): when and where, the tracks it recorded, and the takes made
 * in it, each with its track, rating, bars and notes. A take belongs to its track; this page
 * only gathers those made on the day.
 */
export function SessionPage({ sessionId }: { sessionId: string }) {
  const { data: session, error } = useQuery(sessionQuery(sessionId));
  const { data: project } = useQuery({
    ...projectQuery(session?.projectId ?? ""),
    enabled: Boolean(session),
  });
  const can = useProjectCan(session?.projectId);
  const { remove } = useSessionMutations(session?.projectId ?? "");
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  if (error) return <p className="p-8 text-signal">{error.message}</p>;
  if (!session || !project) return <p className="p-8 text-ink-3">Loading</p>;
  const canEdit = can("edit_takes") && !project.archivedAt;
  const rows = session.takeRows;
  return (
    <>
      <PageHeader
        crumbs={[
          { key: "projects", link: <Link to="/projects">Projects</Link> },
          {
            key: "project",
            link: (
              <Link to="/projects/$projectId" params={{ projectId: project.id }}>
                {project.name}
              </Link>
            ),
          },
          {
            key: "sessions",
            link: (
              <Link to="/projects/$projectId/sessions" params={{ projectId: project.id }}>
                Sessions
              </Link>
            ),
          },
        ]}
        title={session.name}
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                void navigate({ to: "/sessions/$sessionId/log", params: { sessionId: session.id } })
              }
            >
              <Icon name="take" size={14} />
              Take log
            </Button>
            {canEdit && (
              <>
                <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
                  Edit
                </Button>
                <ActionMenu
                  always
                  label="session"
                  actions={[
                    { label: "Delete session…", danger: true, onSelect: () => setDeleting(true) },
                  ]}
                />
              </>
            )}
          </>
        }
      />
      <div className={body}>
        <p className="m-0 text-[14px] text-ink-2">
          {[whenAndWhere(session), count(rows.length, "take")].filter(Boolean).join(" · ")}
        </p>
        <section aria-label="Tracks recorded" className="flex flex-wrap items-center gap-2">
          {session.tracks.length === 0 ? (
            <span className="text-[13px] text-ink-3">No tracks given for this session.</span>
          ) : (
            session.tracks.map((t) => (
              <Link
                key={t.id}
                to="/tracks/$trackId"
                params={{ trackId: t.id }}
                search={{ view: "takes" }}
                className="flex h-7 items-center gap-1.5 rounded-chip border border-line bg-raised/40 px-2.5 text-[13px] text-ink-2 no-underline hover:border-edge hover:text-ink"
              >
                <Icon name="track" size={12} className="text-ink-3" />
                {t.name}
              </Link>
            ))
          )}
        </section>
        {rows.length === 0 ? (
          <Empty
            title="No takes from this session yet"
            text="A take says which session it was recorded in, set where it is edited among the track's takes."
          />
        ) : (
          // A wide table scrolls on its own on a phone; the page does not.
          <div className="-mx-5 overflow-x-auto px-5 @3xl/app:mx-0 @3xl/app:px-0">
            <table className="w-full min-w-[720px] border-collapse text-[13px]">
              <thead>
                <tr className="text-left text-[12px] text-ink-3">
                  {["Take", "Rating", "Track", "Bars", "Notes", ""].map((h) => (
                    <th key={h || "length"} className="px-2 py-2 font-normal">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id} className="border-t border-line">
                    <td className="px-2 py-2">
                      <Link
                        to="/tracks/$trackId"
                        params={{ trackId: t.track.id }}
                        search={{ view: "takes" }}
                        className="tabular inline-flex items-center gap-1.5 font-medium text-ink no-underline hover:text-ink-2"
                      >
                        {t.starred && (
                          <Icon
                            name="star"
                            size={12}
                            fill="currentColor"
                            aria-label="Starred"
                            className="text-ink-2"
                          />
                        )}
                        T{t.number}
                      </Link>
                    </td>
                    <td className="px-2 py-2">
                      <Rating value={t.rating} />
                    </td>
                    <td className="px-2 py-2 text-ink-2">{t.track.name}</td>
                    <td className="tabular px-2 py-2 text-ink-2">
                      {t.barFrom === null ? (
                        <span className="text-ink-3">none</span>
                      ) : (
                        `${t.page ? `p. ${t.page} · ` : ""}bars ${t.barFrom}–${t.barTo ?? t.barFrom}`
                      )}
                    </td>
                    <td className="max-w-[320px] truncate px-2 py-2 text-ink-2">
                      {t.notes || t.label}
                    </td>
                    <td className="tabular px-2 py-2 text-right text-ink-3">
                      {t.file?.duration != null ? formatDuration(t.file.duration) : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {editing && (
        <SessionDialog projectId={project.id} session={session} onClose={() => setEditing(false)} />
      )}
      {deleting && (
        <Dialog
          title="Delete this session?"
          description="Its takes stay with their tracks; they no longer say which session they were recorded in."
          onClose={() => setDeleting(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setDeleting(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={remove.isPending}
                onClick={() =>
                  remove.mutate(session.id, {
                    onSuccess: () =>
                      void navigate({
                        to: "/projects/$projectId/sessions",
                        params: { projectId: project.id },
                      }),
                  })
                }
              >
                Delete session
              </Button>
            </>
          }
        >
          {remove.error && (
            <p role="alert" className="m-0 text-[13px] text-signal">
              {remove.error.message}
            </p>
          )}
        </Dialog>
      )}
    </>
  );
}
