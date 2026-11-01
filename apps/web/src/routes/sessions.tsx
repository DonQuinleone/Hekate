import {
  type EditDecisions,
  formatDuration,
  type SessionDetail,
  type SessionSummary,
} from "@hekate/shared";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Empty } from "~/components/empty";
import { Icon } from "~/components/icons";
import { PageHeader } from "~/components/page-header";
import { ProductionBody } from "~/components/production-nav";
import { SessionDialog } from "~/components/session-dialog";
import { TakeImportDialog } from "~/components/take-import";
import { Rating } from "~/components/takes";
import { Button } from "~/components/ui/button";
import { Count } from "~/components/ui/chip";
import { Dialog } from "~/components/ui/dialog";
import { ActionMenu } from "~/components/ui/menu";
import { Failed, Loading, Refused } from "~/components/ui/states";
import { cn } from "~/lib/cn";
import { formatDates } from "~/lib/locale";
import {
  editDecisionsQuery,
  projectQuery,
  projectSessionsQuery,
  sessionQuery,
  useProjectCan,
  useSessionMutations,
} from "~/lib/queries";
import {
  coverageLabel,
  falseStartsLabel,
  takesByTrack,
  timecodeSpan,
  usedInLabel,
} from "~/lib/take-page";
import { PageFailed } from "~/routes/problem";
import { ProjectFrame } from "~/routes/project";

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
  const {
    data: sessions,
    error,
    refetch,
  } = useQuery({
    ...projectSessionsQuery(projectId),
    enabled: can("view_takes"),
  });
  const canEdit = can("edit_takes");
  // Importing uploads the takes' files, which needs the project's upload permission too.
  const canImport = canEdit && can("upload");
  return (
    <ProjectFrame projectId={projectId} title="Sessions">
      {(project) => (
        <ProductionBody projectId={projectId} current="sessions" can={can}>
          {!can("view_takes") ? (
            <Refused
              title="Not among what your role shows"
              text="Sessions and takes are shown to the roles the project's access gives them."
            />
          ) : error ? (
            <Failed what="The sessions" error={error} retry={refetch} />
          ) : !sessions ? (
            <Loading />
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
            <div className="flex flex-col gap-3">
              {/* Inside a project the view's actions sit at the right of its content (#548). */}
              {canEdit && !project.archivedAt && (
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {canImport && (
                    <Button variant="secondary" size="md" onClick={() => setImporting(true)}>
                      <Icon name="upload" size={14} />
                      Import takes
                    </Button>
                  )}
                  <Button variant="primary" size="md" onClick={() => setMaking(true)}>
                    <Icon name="plus" size={14} />
                    New session
                  </Button>
                </div>
              )}
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
            </div>
          )}
          {making && <SessionDialog projectId={project.id} onClose={() => setMaking(false)} />}
          {importing && (
            <TakeImportDialog projectId={project.id} onClose={() => setImporting(false)} />
          )}
        </ProductionBody>
      )}
    </ProjectFrame>
  );
}

/**
 * One recording session (#21, #45): when and where, the tracks it recorded, and the takes made
 * in it, each with its track, rating, bars and notes. A take belongs to its track; this page
 * only gathers those made on the day.
 */
export function SessionPage({ sessionId }: { sessionId: string }) {
  const { data: session, error, refetch } = useQuery(sessionQuery(sessionId));
  const { data: project } = useQuery({
    ...projectQuery(session?.projectId ?? ""),
    enabled: Boolean(session),
  });
  const can = useProjectCan(session?.projectId);
  const { remove } = useSessionMutations(session?.projectId ?? "");
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Where each track's latest edit decision list uses its takes (#56), for "Used in".
  const trackIds = [...new Set(session?.takeRows.map((t) => t.track.id) ?? [])];
  const lists = useQueries({
    queries: trackIds.map((id) => ({ ...editDecisionsQuery(id), retry: false })),
  });
  const decisions = new Map(trackIds.map((id, i) => [id, lists[i]?.data ?? null]));
  if (error) return <PageFailed what="This session" error={error} retry={refetch} />;
  if (!session || !project) return <Loading />;
  const canEdit = can("edit_takes") && !project.archivedAt;
  const rows = session.takeRows;
  const groups = takesByTrack(session.tracks, rows);
  return (
    <>
      <PageHeader
        crumbs={[
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
        // Its name is the page's heading (#648), said once.
        title={session.name}
        heading="page"
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
      {/* In Production's frame, Sessions current, as the list of sessions is (#648). */}
      <ProductionBody projectId={project.id} current="sessions" can={can}>
        <div className="flex min-w-0 flex-col gap-8">
          <div>
            <h1 className="title m-0">{session.name}</h1>
            <p className="m-0 mt-1 text-[14px] text-ink-2">
              {[whenAndWhere(session), count(rows.length, "take")].filter(Boolean).join(" · ")}
            </p>
          </div>
          {groups.length === 0 ? (
            <Empty
              title="No tracks for this session"
              text="Give the session the tracks it recorded, with Edit; their takes from the day are listed under each."
            />
          ) : (
            // The tracks it recorded, and their takes (#652): a take is its track's.
            groups.map((g) => (
              <section
                key={g.track.id}
                aria-labelledby={`track-${g.track.id}`}
                className="flex min-w-0 flex-col gap-2"
              >
                <h2 id={`track-${g.track.id}`} className="m-0 text-[15px] font-medium">
                  <Link
                    to="/tracks/$trackId"
                    params={{ trackId: g.track.id }}
                    search={{ view: "takes" }}
                    className="inline-flex items-center gap-2 text-ink no-underline hover:text-ink-2"
                  >
                    <Icon name="track" size={14} className="text-ink-3" />
                    {g.track.name}
                  </Link>
                  {g.takes.length > 0 && <Count>{g.takes.length}</Count>}
                </h2>
                {g.takes.length === 0 ? (
                  <p className="m-0 text-[13px] text-ink-3">
                    No takes of it from this session yet.
                  </p>
                ) : (
                  <SessionTakes takes={g.takes} decisions={decisions.get(g.track.id) ?? null} />
                )}
              </section>
            ))
          )}
        </div>
      </ProductionBody>
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
              <Button variant="secondary" onClick={() => setDeleting(false)}>
                Cancel
              </Button>
              <Button
                variant="danger"
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

type SessionTake = SessionDetail["takeRows"][number];

/**
 * One track's takes from a session (#652): a table with every column headed on a wide screen,
 * and on a phone two lines a take (its number, rating, notes and length; then its bars,
 * timecode and where an edit uses it), so nothing is out of reach.
 */
function SessionTakes({
  takes,
  decisions,
}: {
  takes: SessionTake[];
  decisions: EditDecisions | null;
}) {
  return (
    <>
      <table className="hidden w-full border-collapse text-[13px] @3xl/app:table">
        <thead>
          <tr className="text-left text-[12px] text-ink-3">
            {["Take", "Rating", "Coverage", "Notes", "Timecode", "Mics", "Used in", "Length"].map(
              (h) => (
                <th
                  key={h}
                  className={cn(
                    "whitespace-nowrap px-2 py-2 font-normal",
                    h === "Length" && "text-right",
                  )}
                >
                  {h}
                </th>
              ),
            )}
          </tr>
        </thead>
        <tbody>
          {takes.map((t) => {
            const coverage = coverageLabel(t);
            return (
              <tr key={t.id} className="border-t border-line transition-colors hover:bg-raised/40">
                <td className="px-2 py-2">
                  <TakeName take={t} />
                </td>
                <td className="px-2 py-2">
                  <Rating value={t.rating} />
                </td>
                <td className="tabular whitespace-nowrap px-2 py-2 text-ink-2">
                  {coverage ?? <span className="text-ink-3">none</span>}
                </td>
                <td
                  className="w-full max-w-0 truncate px-2 py-2 text-ink-2"
                  title={t.notes ?? undefined}
                >
                  {t.notes || t.label}
                </td>
                <td className="tabular whitespace-nowrap px-2 py-2 text-ink-3">
                  {timecodeSpan(t.timecodeIn, t.timecodeOut)}
                </td>
                {/* A take is its summed mix for now; its microphones follow (decision 246). */}
                <td className="px-2 py-2 text-ink-3">{t.file ? "mix" : ""}</td>
                <td className="tabular whitespace-nowrap px-2 py-2 text-ink-3">
                  {usedInLabel(decisions, t.id)}
                </td>
                <td className="tabular whitespace-nowrap px-2 py-2 text-right text-ink-3">
                  {t.file?.duration != null ? formatDuration(t.file.duration) : ""}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <ul className="m-0 flex list-none flex-col p-0 @3xl/app:hidden">
        {takes.map((t) => {
          const facts = [
            coverageLabel(t),
            timecodeSpan(t.timecodeIn, t.timecodeOut),
            usedInLabel(decisions, t.id),
          ].filter(Boolean);
          return (
            <li key={t.id} className="flex flex-col gap-0.5 border-t border-line py-2 text-[13px]">
              <span className="flex min-w-0 items-center gap-3">
                <TakeName take={t} />
                <Rating value={t.rating} />
                <span className="min-w-0 flex-1 truncate text-ink-2">{t.notes || t.label}</span>
                <span className="tabular shrink-0 text-ink-3">
                  {t.file?.duration != null ? formatDuration(t.file.duration) : ""}
                </span>
              </span>
              {facts.length > 0 && (
                <span className="tabular pl-[22px] text-[12px] text-ink-3">
                  {facts.join(" · ")}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** "T3", with room kept for the star whether or not it has one, so the numbers line up. */
function TakeName({ take: t }: { take: SessionTake }) {
  const falseStarts = falseStartsLabel(t.falseStarts);
  return (
    <Link
      to="/takes/$takeId"
      params={{ takeId: t.id }}
      className="tabular inline-flex items-center gap-1.5 whitespace-nowrap font-medium text-ink no-underline hover:text-ink-2"
    >
      <span className="flex w-3 shrink-0 justify-center">
        {t.starred && (
          <Icon
            name="star"
            size={12}
            fill="currentColor"
            aria-label="Starred"
            className="text-ink-2"
          />
        )}
      </span>
      T{t.number}
      {t.lifecycle === "aborted" && (
        <span className="text-[12px] font-normal text-ink-3">aborted</span>
      )}
      {falseStarts && <span className="text-[12px] font-normal text-ink-3">{falseStarts}</span>}
    </Link>
  );
}
