import { Link, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Rating } from "~/components/comments/takes";
import { Icon } from "~/components/icons";
import { Count, Label } from "~/components/label";
import { Page } from "~/components/page";
import { PageTitle, usePageHeader } from "~/components/page-header";
import { PageViewer } from "~/components/pages";
import { usePlayback } from "~/components/player/playback";
import { Waveform } from "~/components/player/waveform";
import { SideNav, Split } from "~/components/settings";
import { Button } from "~/components/ui/button";
import { ChoiceCard } from "~/components/ui/choice";
import { Dialog } from "~/components/ui/dialog";
import { Input, Select } from "~/components/ui/input";
import { UploadDialog } from "~/components/ui/upload-dialog";
import {
  fileById,
  type Project,
  projectById,
  sessions,
  type Take,
  type Track,
  takeById,
  takes,
  trackById,
  tracks,
} from "~/data";
import { cn } from "~/lib/cn";
import { formatDuration, formatLongDate, plural } from "~/lib/format";
import { useViewer } from "~/viewer/context";
import { Empty, Refused, useScreenState } from "~/viewer/state-gate";
import { productionSections } from "./production.tsx";

/* ---------- Import ---------- */

/** A day's files as the recorder left them: what the zone picks here. */
const sessionFiles = [
  ["T27_Mix.wav", 61_200_000],
  ["T27_Tree.wav", 61_200_000],
  ["T27_Spot.wav", 61_200_000],
  ["T28_Mix.wav", 58_900_000],
  ["T28_Tree.wav", 58_900_000],
  ["T28_Spot.wav", 58_900_000],
  ["Room tone.wav", 9_800_000],
].map(([name, size]) => ({ key: String(name), name: String(name), size: Number(size) }));

/** The takes of a passage, as the zone picks them from a track: one file each. */
const trackFiles = [
  ["Maple Leaf Rag T27.wav", 61_200_000],
  ["Maple Leaf Rag T28.wav", 58_900_000],
].map(([name, size]) => ({ key: String(name), name: String(name), size: Number(size) }));

/**
 * Take import (#45): a day's files from the sessions page, or, from a track (#490), the same
 * dialog with the track settled: every file a take of it, the session and bars chosen once.
 */
export function TakeImportDialog({ onClose, track }: { onClose: () => void; track?: Track }) {
  const [step, setStep] = useState<0 | 1>(0);
  const [picked, setPicked] = useState(false);
  const state = useScreenState();
  const joplin = tracks.filter((x) => x.projectId === "proj-joplin");
  const tree = track
    ? [
        {
          session: "Day 2",
          note: "adds to this session",
          existing: true,
          takes: [
            { label: "T27 · 10:14:02:00 · 6:12 · 1 file", track: track.name, sure: 100 },
            { label: "T28 · 10:19:40:00 · 5:58 · 1 file", track: track.name, sure: 100 },
          ],
        },
      ]
    : [
        {
          session: "Day 3",
          note: "14 October 2026 · adds to this session",
          existing: true,
          takes: [
            { label: "T27 · 10:14:02:00 · 6:12 · 7 files", track: "Maple Leaf Rag", sure: 96 },
            { label: "T28 · 10:19:40:00 · 5:58 · 7 files", track: "Maple Leaf Rag", sure: 91 },
            { label: "Pine Apple Rag T29 · 10:26:11:00 · 2:40 · 7 files", track: null, sure: 0 },
          ],
        },
        {
          session: "Day 3, afternoon",
          note: "a new session",
          existing: false,
          takes: [
            { label: "T30 · 14:02:00:00 · 4:31 · 6 files", track: "Solace", sure: 88 },
            { label: "T31 · 14:09:25:00 · 4:47 · 7 files", track: "Solace", sure: 94 },
          ],
        },
      ];
  const verb = track ? "Add" : "Import";
  const title = track ? "Add takes" : "Import takes";
  const description = track
    ? `Drop the takes recorded for ${track.name}: one file each, or a take's microphones together with its mix. Take numbers are read from the files.`
    : "Drop every file of a session. Takes are grouped by take number and timecode, with their mix found among the microphones, and matched to tracks by name.";
  if (step === 0)
    return (
      <UploadDialog
        title={title}
        description={description}
        onClose={onClose}
        width="lg"
        inputLabel={track ? "Take files" : "Session files"}
        listLabel={track ? "Files of the takes" : "Files of the session"}
        prompt={track ? "Drop the takes here" : "Drop the session's files or folder here"}
        hint={`Or choose them. Only their headers are read until you ${verb.toLowerCase()}.`}
        multiple
        chosen={picked ? (track ? trackFiles : sessionFiles) : []}
        onPick={() => setPicked(true)}
        onRemove={() => setPicked(false)}
        alternatives={
          <Button variant="ghost" size="sm" onClick={() => setPicked(true)}>
            <Icon name="folder" size={14} />
            Choose a folder
          </Button>
        }
        fields={
          <>
            <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
              File-name pattern
              <Input defaultValue="T{take} {mic}" />
              <span className="text-[12px] text-ink-3">
                Read where the files carry no iXML: {"{take}"}, {"{mic}"}, {"{tc}"}, {"{scene}"},{" "}
                {"{session}"}, {"{track}"}, and * for anything.
              </span>
            </label>
            {track && (
              <div className="grid gap-4 @md/app:grid-cols-2">
                <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
                  Session
                  <Select defaultValue="sess-2">
                    <option value="proposed">As the files say</option>
                    <option value="none">No session</option>
                    {sessions
                      .filter((x) => x.projectId === track.projectId)
                      .map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.name}
                        </option>
                      ))}
                  </Select>
                  <span className="text-[12px] text-ink-3">
                    Leave as the files say to make a session from their recording date.
                  </span>
                </label>
                <fieldset className="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0 text-[13px] text-ink-2">
                  <legend className="mb-1.5 p-0">Bars</legend>
                  <span className="flex items-center gap-2">
                    <Input
                      aria-label="First bar"
                      placeholder="From"
                      className="w-24"
                      defaultValue="1"
                    />
                    <span className="text-ink-3">to</span>
                    <Input
                      aria-label="Last bar"
                      placeholder="To"
                      className="w-24"
                      defaultValue="16"
                    />
                  </span>
                  <span className="text-[12px] text-ink-3">
                    Where bars matter: the passage every take here covers.
                  </span>
                </fieldset>
              </div>
            )}
          </>
        }
        what={
          picked &&
          (track
            ? "2 files, 120 MB. Their headers are read here; nothing is uploaded until the takes are added."
            : "7 files, 370 MB. Their headers are read here; nothing is uploaded until the takes are imported.")
        }
        action="Propose the takes"
        onAction={() => setStep(1)}
      />
    );
  // What will be made is ticked, so the ticks and the button's count agree (#657).
  const placed = tree.flatMap((s) => s.takes).filter((t) => track || t.track).length;
  return (
    <Dialog
      title={title}
      description={`Check what Hekate proposes, then ${track ? "add" : "import"} the takes.`}
      onClose={onClose}
      width="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={onClose} disabled={state === "processing"}>
            {verb} {placed} takes
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {state === "processing" && (
          <div className="flex items-center gap-3 text-[13px] text-ink-2">
            <span className="breathe size-2 rounded-full border border-ink-2" /> Importing: 12 of 40
            takes
            <span className="ml-auto h-1 w-40 overflow-hidden rounded-full bg-raised">
              <span className="block h-full w-[30%] bg-ink-2" />
            </span>
          </div>
        )}
        <div className="flex min-h-9 items-center gap-2 text-[13px] text-ink-3">
          <label className="mr-auto flex items-center gap-2">
            <input type="checkbox" defaultChecked className="size-4" />
            {track ? "2 takes" : "5 takes in 2 sessions"}
          </label>
          {/* Undo beside the proposal's actions, once there is something to undo. */}
          <Button variant="ghost" size="sm">
            Undo
          </Button>
        </div>
        {tree.map((s) => (
          <div key={s.session} className="flex flex-col gap-1.5">
            <span className="flex items-center gap-3 text-[14px] text-ink">
              <Icon name="mic" size={14} className="text-ink-3" />
              {s.existing ? (
                s.session
              ) : (
                <label className="flex items-center gap-2 text-[13px] text-ink-2">
                  Session name
                  <Input placeholder={s.session} className="h-7 w-56 text-[13px]" />
                </label>
              )}
              <span className="text-[13px] text-ink-3">{s.note}</span>
            </span>
            <ul className="ml-5 flex flex-col divide-y divide-line rounded-panel border border-line bg-sunken">
              {s.takes.map((t) => (
                <li key={t.label} className="flex items-center gap-3 px-3 py-2 text-[13px]">
                  <input
                    type="checkbox"
                    defaultChecked={Boolean(track || t.track)}
                    disabled={!track && !t.track}
                    aria-label={`${verb} ${t.label}`}
                    className="size-4"
                  />
                  <Icon name="take" size={13} className="text-ink-3" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-ink">{t.label}</span>
                    {/* Its select says "Choose a track" once; the line does not repeat it. */}
                    {(track || t.track) && (
                      <span className="block text-ink-3">
                        {track ? "Bars 1 to 16" : `${t.track}, ${t.sure}% sure`}
                      </span>
                    )}
                  </span>
                  {!track && (
                    <>
                      <Select defaultValue="mix" className="h-7 w-36 text-[12px]" aria-label="Mix">
                        <option value="mix">Mix</option>
                        <option value="tree">Tree</option>
                        <option value="spot">Spot vln</option>
                      </Select>
                      <Select
                        defaultValue={joplin.find((x) => x.name === t.track)?.id ?? ""}
                        className="h-7 w-44 text-[12px]"
                        aria-label="Track"
                      >
                        <option value="">Choose a track</option>
                        {joplin.map((x) => (
                          <option key={x.id} value={x.id}>
                            {x.name}
                          </option>
                        ))}
                      </Select>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
        {!track && (
          <p className="text-[12px] text-ink-3">
            1 file is left out: "Room tone.wav" has no take number or timecode.
          </p>
        )}
        <p className="text-[12px] text-ink-3">
          Only each take's mix is added, kept under its track rather than among the project's files;
          microphone files are not uploaded yet.
        </p>
      </div>
    </Dialog>
  );
}

/* ---------- Sessions (project tab) ---------- */

export function SessionsView({ project }: { project: Project }) {
  const viewer = useViewer();
  const [importing, setImporting] = useState(false);
  const state = useScreenState();
  const list = sessions.filter((s) => s.projectId === project.id);
  const canUpload = viewer.can(project.id, "upload");
  if (state === "empty" || list.length === 0)
    return (
      <>
        <Empty
          title="No sessions yet"
          text="Import a day's recordings: every take, one file per microphone, matched to the tracks by their audio."
          action={
            canUpload ? (
              <Button variant="primary" onClick={() => setImporting(true)}>
                Import takes
              </Button>
            ) : undefined
          }
        />
        {importing && <TakeImportDialog onClose={() => setImporting(false)} />}
      </>
    );
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Label>
          Sessions<Count>{list.length}</Count>
        </Label>
        <span className="ml-auto flex gap-1">
          <Button variant="ghost" size="md" asChild>
            <Link
              to="/projects/$projectId/$view"
              params={{ projectId: project.id, view: "coverage" }}
            >
              Coverage
            </Link>
          </Button>
          {canUpload && (
            <Button variant="secondary" size="md" onClick={() => setImporting(true)}>
              <Icon name="upload" size={14} />
              Import takes
            </Button>
          )}
          {/* The view's one primary, at the right of its content (#548). */}
          {canUpload && (
            <Button variant="primary" size="md">
              <Icon name="plus" size={14} />
              New session
            </Button>
          )}
        </span>
      </div>
      <ul className="-mx-2 flex flex-col">
        {list.map((s) => {
          const its = s.takeIds.map(takeById).filter((t): t is Take => Boolean(t));
          return (
            <li key={s.id}>
              <Link
                to="/sessions/$sessionId"
                params={{ sessionId: s.id }}
                className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3.5 rounded-panel px-2 py-2.5 transition-colors hover:bg-raised/60 @3xl/app:grid-cols-[auto_minmax(0,1fr)_160px_120px_100px]"
              >
                <span className="flex size-9 items-center justify-center rounded-panel bg-raised text-ink-2">
                  <Icon name="mic" size={16} />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[14px] font-medium text-ink">{s.name}</span>
                  <span className="block truncate text-[13px] text-ink-3">
                    {formatLongDate(s.date)} · {s.venue}
                  </span>
                </span>
                <span className="hidden text-[13px] text-ink-3 @3xl/app:block">
                  {plural(its.length, "take")} · {its.filter((t) => t.starred).length} starred
                </span>
                <span className="hidden text-[13px] text-ink-3 @3xl/app:block">
                  {[...new Set(its.map((t) => t.trackId).filter(Boolean))].length} tracks
                </span>
                <span className="tabular text-[13px] text-ink-3">
                  {formatDuration(its.reduce((n, t) => n + t.duration, 0))}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
      {importing && <TakeImportDialog onClose={() => setImporting(false)} />}
    </div>
  );
}

/* ---------- Session ---------- */

export function SessionPage({ sessionId }: { sessionId: string }) {
  const viewer = useViewer();
  const session = sessions.find((s) => s.id === sessionId);
  const project = session ? projectById(session.projectId) : undefined;
  const allowed =
    session && project && viewer.canSee(project.id) && viewer.tools(project.id).has("takes");
  usePageHeader({
    crumbs: project
      ? [
          { label: project.name, to: `/projects/${project.id}` },
          { label: "Sessions", to: `/projects/${project.id}/sessions` },
        ]
      : [],
    title: session?.name ?? "Not found",
    // Its name is the page's heading (#648), said once.
    heading: "page",
    actions: allowed ? <Button variant="secondary">Export CSV</Button> : undefined,
  });
  if (!session || !project || !allowed) return <Refused />;
  const list = session.takeIds.map(takeById).filter((t): t is Take => Boolean(t));
  // The tracks it recorded, each with its takes (#652): a take is its track's.
  const groups = [...new Set(list.map((t) => t.trackId ?? ""))].map((id) => ({
    id,
    name: id ? (trackById(id)?.name ?? "A track") : "Not yet placed",
    takes: list.filter((t) => (t.trackId ?? "") === id),
  }));
  const timecode = (t: Take) => `${t.timecodeIn} – ${t.timecodeOut ?? "…"}`;
  return (
    // In Production's frame, Sessions current, as the list of sessions is (#648).
    <Page className="gap-5">
      <Split
        nav={
          <SideNav
            label="Production"
            phoneLabel="Production"
            fit
            sections={productionSections}
            current="sessions"
            link={(id) => ({
              to: "/projects/$projectId/$view",
              params: { projectId: project.id, view: "production" },
              search: { section: id },
            })}
          />
        }
      >
        <div className="flex min-w-0 flex-col gap-8">
          <div>
            <PageTitle>{session.name}</PageTitle>
            <p className="mt-1 text-[14px] text-ink-2">
              {formatLongDate(session.date)} · {session.venue} · {plural(list.length, "take")}
            </p>
          </div>
          {groups.map((g) => (
            <section key={g.id} aria-label={g.name} className="flex min-w-0 flex-col gap-2">
              <h2 className="m-0 flex items-center gap-2 text-[15px] font-medium text-ink">
                <Icon name="track" size={14} className="text-ink-3" />
                {g.name}
                <Count>{g.takes.length}</Count>
              </h2>
              <table className="hidden w-full border-collapse text-[13px] @3xl/app:table">
                <thead>
                  <tr className="text-left">
                    {[
                      "Take",
                      "Rating",
                      "Coverage",
                      "Notes",
                      "Timecode",
                      "Mics",
                      "Used in",
                      "Length",
                    ].map((h) => (
                      <th
                        key={h}
                        className={cn(
                          "whitespace-nowrap px-2 py-2 font-normal",
                          h === "Length" && "text-right",
                        )}
                      >
                        <Label>{h}</Label>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {g.takes.map((t) => (
                    <tr
                      key={t.id}
                      className="border-t border-line transition-colors hover:bg-raised/40"
                    >
                      <td className="px-2 py-2">
                        <SessionTakeName take={t} />
                      </td>
                      <td className="px-2 py-2">
                        <Rating value={t.rating} />
                      </td>
                      <td className="tabular whitespace-nowrap px-2 py-2 text-ink-2">
                        {t.coverage ? (
                          `p. ${t.coverage.page} · bars ${t.coverage.barFrom}–${t.coverage.barTo}`
                        ) : (
                          <span className="text-ink-3">none</span>
                        )}
                      </td>
                      <td className="w-full max-w-0 truncate px-2 py-2 text-ink-2">{t.notes}</td>
                      {/* Both timecodes in full (#571), as the take log writes them. */}
                      <td className="tabular whitespace-nowrap px-2 py-2 text-ink-3">
                        {timecode(t)}
                      </td>
                      <td className="tabular whitespace-nowrap px-2 py-2 text-ink-3">
                        {t.files.length - 1} + mix
                      </td>
                      <td className="tabular whitespace-nowrap px-2 py-2 text-ink-3">
                        {t.usedIn
                          ?.map((u) => `V${u.versionNumber} bars ${u.barFrom}–${u.barTo}`)
                          .join(", ")}
                      </td>
                      <td className="tabular px-2 py-2 text-right text-ink-3">
                        {formatDuration(t.duration)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {/* On a phone, two lines a take, so nothing is out of reach. */}
              <ul className="m-0 flex list-none flex-col p-0 @3xl/app:hidden">
                {g.takes.map((t) => (
                  <li
                    key={t.id}
                    className="flex flex-col gap-0.5 border-t border-line py-2 text-[13px]"
                  >
                    <span className="flex min-w-0 items-center gap-3">
                      <SessionTakeName take={t} />
                      <Rating value={t.rating} />
                      <span className="min-w-0 flex-1 truncate text-ink-2">{t.notes}</span>
                      <span className="tabular shrink-0 text-ink-3">
                        {formatDuration(t.duration)}
                      </span>
                    </span>
                    <span className="tabular pl-[22px] text-[12px] text-ink-3">
                      {[
                        t.coverage
                          ? `p. ${t.coverage.page} · bars ${t.coverage.barFrom}–${t.coverage.barTo}`
                          : null,
                        timecode(t),
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </Split>
    </Page>
  );
}

/** "T3", with room kept for the star whether or not it has one, so the numbers line up. */
function SessionTakeName({ take: t }: { take: Take }) {
  return (
    <Link
      to="/takes/$takeId"
      params={{ takeId: t.id }}
      className="tabular flex items-center gap-1.5 whitespace-nowrap font-medium text-ink hover:text-signal"
    >
      <span className="flex w-3 shrink-0 justify-center">
        {t.starred && <Icon name="star" size={12} className="text-signal" fill="currentColor" />}
      </span>
      T{t.number}
      {t.lifecycle === "aborted" && (
        <span className="text-[12px] font-normal text-ink-3">aborted</span>
      )}
      {t.falseStarts > 0 && (
        <span className="text-[12px] font-normal text-ink-3">
          {t.falseStarts} false {t.falseStarts === 1 ? "start" : "starts"}
        </span>
      )}
    </Link>
  );
}

/* ---------- Take ---------- */

export function TakePage({ takeId }: { takeId: string }) {
  const viewer = useViewer();
  const navigate = useNavigate();
  const take = takeById(takeId);
  const session = take ? sessions.find((s) => s.id === take.sessionId) : undefined;
  const project = session ? projectById(session.projectId) : undefined;
  const track = take?.trackId ? trackById(take.trackId) : undefined;
  const allowed =
    take && project && viewer.canSee(project.id) && viewer.tools(project.id).has("takes");
  const playback = usePlayback(take?.duration ?? 1, 0);
  const [muted, setMuted] = useState<Set<number>>(new Set());
  const [solo, setSolo] = useState<number | null>(null);
  const [page, setPage] = useState(take?.coverage?.page ?? 1);
  const [sharing, setSharing] = useState(false);
  const siblings = useMemo(
    () =>
      take && session
        ? session.takeIds
            .map(takeById)
            .filter((t): t is Take => Boolean(t) && t?.trackId === take.trackId)
        : [],
    [take, session],
  );
  usePageHeader({
    // A take is its track's, never its session's (#568): the session is said beside it.
    crumbs:
      project && track
        ? [
            { label: project.name, to: `/projects/${project.id}` },
            { label: track.name, to: `/tracks/${track.id}?view=versions` },
            { label: "Takes", to: `/tracks/${track.id}?view=takes` },
          ]
        : project
          ? [{ label: project.name, to: `/projects/${project.id}` }]
          : [],
    title: take ? `Take ${take.number}` : "Not found",
    actions: allowed ? (
      <Button variant="secondary" onClick={() => setSharing(true)}>
        <Icon name="comment" size={14} />
        Attach to a comment
      </Button>
    ) : undefined,
  });
  if (!take || !project || !session || !allowed) return <Refused />;
  const score = track?.scoreFileId ? fileById(track.scoreFileId) : undefined;
  const lanes = take.files.length;
  return (
    <div className="fade-in flex h-full min-h-0 flex-col @3xl/app:flex-row">
      <div className="scroll-quiet flex min-w-0 flex-1 flex-col gap-4 overflow-auto p-4 @3xl/app:p-6">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-ink-3">
          <Rating value={take.rating} />
          {take.starred && (
            <span className="flex items-center gap-1 text-signal">
              <Icon name="star" size={12} fill="currentColor" />
              starred
            </span>
          )}
          <Link
            to="/sessions/$sessionId"
            params={{ sessionId: session.id }}
            className="text-ink-2 hover:text-ink"
          >
            {session.name}
          </Link>
          {take.coverage && (
            <span className="tabular">
              p. {take.coverage.page} · bars {take.coverage.barFrom}–{take.coverage.barTo}
            </span>
          )}
          <span className="tabular">
            {take.timecodeIn} – {take.timecodeOut}
          </span>
          {take.usedIn && take.usedIn.length > 0 && (
            // Where an edit uses it: a quiet fact, not a status (#703).
            <span>in V{take.usedIn[0]?.versionNumber}</span>
          )}
          <nav
            aria-label={`Takes of ${track?.name ?? "the track"} recorded in ${session.name}`}
            className="ml-auto flex gap-1"
          >
            {siblings.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => navigate({ to: "/takes/$takeId", params: { takeId: t.id } })}
                className={cn(
                  "tabular h-7 rounded-control px-2 text-[12px] transition-colors",
                  t.id === take.id ? "bg-raised text-ink shadow-1" : "text-ink-3 hover:text-ink",
                )}
              >
                T{t.number}
              </button>
            ))}
          </nav>
        </div>
        <div className="flex gap-2">
          <div className="flex w-28 shrink-0 flex-col justify-around py-1">
            {take.files.map((f, i) => (
              <div key={f.name} className="flex items-center gap-1 text-[12px]">
                <button
                  type="button"
                  aria-pressed={solo === i}
                  onClick={() => setSolo(solo === i ? null : i)}
                  className={cn(
                    "size-5 rounded-chip border text-[10px]",
                    solo === i
                      ? "border-signal bg-signal text-ground"
                      : "border-line text-ink-3 hover:text-ink",
                  )}
                >
                  S
                </button>
                <button
                  type="button"
                  aria-pressed={muted.has(i)}
                  onClick={() =>
                    setMuted((m) => {
                      const n = new Set(m);
                      if (n.has(i)) n.delete(i);
                      else n.add(i);
                      return n;
                    })
                  }
                  className={cn(
                    "size-5 rounded-chip border text-[10px]",
                    muted.has(i)
                      ? "border-ink-3 bg-raised text-ink"
                      : "border-line text-ink-3 hover:text-ink",
                  )}
                >
                  M
                </button>
                <span className="truncate text-ink-3">{f.channel}</span>
              </div>
            ))}
          </div>
          <div className="min-w-0 flex-1">
            <Waveform
              seed={take.seed}
              duration={take.duration}
              channels={lanes}
              playback={playback}
              split
              markers={[]}
              height={Math.max(220, lanes * 40)}
              muted={muted}
              solo={solo}
            />
          </div>
        </div>
        <div className="flex items-center gap-3 text-[13px] text-ink-3">
          <button
            type="button"
            onClick={playback.toggle}
            className="flex size-10 items-center justify-center rounded-full bg-ink text-ground shadow-2"
          >
            <Icon
              name={playback.playing ? "pause" : "play"}
              size={14}
              fill="currentColor"
              strokeWidth={0}
            />
          </button>
          <span className="tabular text-[15px] text-ink">
            {formatDuration(playback.time)}{" "}
            <span className="text-ink-3">/ {formatDuration(take.duration)}</span>
          </span>
          <button
            type="button"
            onClick={() => {
              playback.setLoop({ start: 0, end: take.duration });
              playback.setLooping(!playback.looping);
            }}
            className={cn(
              "flex h-8 items-center gap-1.5 rounded-full px-3",
              playback.looping ? "bg-signal/15 text-signal" : "hover:bg-raised hover:text-ink",
            )}
          >
            <Icon name="loop" />
            Loop
          </button>
          {/* The number keys that switch takes are in the shortcut map, not on the page (#572). */}
          <span>Solo and mute the microphones; the summed mix is the last lane.</span>
        </div>
        <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
          Notes
          <Input defaultValue={take.notes} />
        </label>
      </div>
      {score && take.coverage && (
        <aside className="flex w-full shrink-0 flex-col border-t border-line @3xl/app:w-[380px] @3xl/app:border-t-0 @3xl/app:border-l">
          <div className="flex h-11 items-center gap-2 px-4 text-[13px]">
            <span className="font-medium text-ink">Its place in the score</span>
            <span className="text-ink-3">
              bars {take.coverage.barFrom}–{take.coverage.barTo}
            </span>
          </div>
          <div className="min-h-0 flex-1 px-4 pb-4">
            <PageViewer
              file={score}
              page={page}
              onPage={setPage}
              markers={[]}
              selected={null}
              onSelect={() => {}}
              canDraw={false}
              compact
            />
          </div>
        </aside>
      )}
      {sharing && (
        // Each thread by where it points, its version, variant and author (#655).
        <Dialog
          title="Attach this take to a comment"
          description="The reviewers on that thread hear exactly this take, and nothing else from the sessions; on a thread about a bar, at that bar, looped."
          onClose={() => setSharing(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setSharing(false)}>
                Cancel
              </Button>
              <Button variant="primary" onClick={() => setSharing(false)}>
                Attach to this thread
              </Button>
            </>
          }
        >
          <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
            <legend className="sr-only">Thread</legend>
            {[
              {
                id: "c-3",
                body: "Can we tighten the edit into bar 17?",
                anchor: "Bar 17 · 0:31.400",
                who: "Mira Solberg",
              },
              {
                id: "c-2",
                body: "Lovely rubato into the trio",
                anchor: "Bars 9–12 · 0:14.200",
                who: "Tomas Varga",
              },
            ].map((c, i) => (
              <ChoiceCard
                key={c.id}
                name="thread"
                defaultChecked={i === 0}
                title={c.body}
                hint={
                  <span className="tabular flex flex-wrap items-center gap-2 text-[12px] text-ink-3">
                    <span className="rounded-chip border border-line px-1.5">{c.anchor}</span>
                    V2 · Dry · {c.who}
                  </span>
                }
              />
            ))}
          </fieldset>
        </Dialog>
      )}
    </div>
  );
}

/* ---------- Coverage and edit decisions ---------- */

export function CoverageView({ project }: { project: Project }) {
  const [trackId, setTrackId] = useState(
    tracks.find((t) => t.projectId === project.id && takes.some((x) => x.trackId === t.id))?.id ??
      "",
  );
  const [mode, setMode] = useState<"coverage" | "edl">("coverage");
  const state = useScreenState();
  const its = takes.filter((t) => t.trackId === trackId && t.coverage);
  const track = trackById(trackId);
  const bars = 100;
  const latest = track?.versions.at(-1);
  const used = its.flatMap((t) => (t.usedIn ?? []).map((u) => ({ take: t, ...u })));
  const covered = new Array(bars).fill(false);
  for (const t of its)
    for (let b = (t.coverage?.barFrom ?? 1) - 1; b < (t.coverage?.barTo ?? 0); b++)
      covered[b] = true;
  const gaps = covered.map((c, i) => (c ? null : i + 1)).filter((x): x is number => x !== null);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={trackId} onChange={(e) => setTrackId(e.target.value)} className="w-56">
          {tracks
            .filter((t) => t.projectId === project.id)
            .map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
        </Select>
        <div
          role="radiogroup"
          className="flex rounded-control border border-line bg-ground/60 p-0.5"
        >
          {(["coverage", "edl"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              onClick={() => setMode(m)}
              className={cn(
                "h-7 rounded-[4px] px-2.5 text-[13px]",
                mode === m ? "bg-overlay text-ink shadow-2" : "text-ink-3 hover:text-ink",
              )}
            >
              {m === "coverage" ? "Take coverage" : "Edit decisions"}
            </button>
          ))}
        </div>
        <span className="ml-auto text-[13px] text-ink-3">
          {mode === "coverage"
            ? gaps.length > 0
              ? `${gaps.length} bars uncovered`
              : "Every bar is covered"
            : latest?.editDecisionList
              ? `From the EDL of V${latest.number}`
              : "No EDL imported: hand-overs cannot be checked"}
        </span>
      </div>
      {state === "empty" || its.length === 0 ? (
        <Empty
          title="No coverage entered"
          text="Takes get a page and a bar range from the take log, or by hand on the take."
        />
      ) : (
        <div className="scroll-quiet overflow-x-auto rounded-panel-lg border border-line bg-sunken p-3">
          <svg
            width={Math.max(800, bars * 9 + 120)}
            height={(mode === "coverage" ? its.length : used.length + 1) * 22 + 40}
            role="img"
            aria-label={mode === "coverage" ? "Take coverage" : "Edit decisions"}
          >
            {Array.from({ length: bars / 10 + 1 }, (_, i) => (
              <g key={String(i)}>
                <line
                  x1={120 + i * 90}
                  x2={120 + i * 90}
                  y1={0}
                  y2={1000}
                  stroke="var(--hk-line)"
                />
                <text
                  x={120 + i * 90}
                  y={12}
                  fill="var(--hk-ink-3)"
                  fontSize={10}
                  fontFamily="var(--hk-font-sans)"
                >
                  bar {i * 10 + 1}
                </text>
              </g>
            ))}
            {mode === "coverage"
              ? its.map((t, i) => (
                  <g key={t.id} transform={`translate(0, ${24 + i * 22})`}>
                    <text
                      x={0}
                      y={13}
                      fill="var(--hk-ink-2)"
                      fontSize={12}
                      fontFamily="var(--hk-font-sans)"
                    >
                      T{t.number} · {"●".repeat(t.rating)}
                    </text>
                    <rect
                      x={120 + ((t.coverage?.barFrom ?? 1) - 1) * 9}
                      y={2}
                      width={((t.coverage?.barTo ?? 1) - (t.coverage?.barFrom ?? 1) + 1) * 9}
                      height={14}
                      rx={3}
                      fill={t.usedIn?.length ? "var(--hk-ink)" : "var(--hk-ink-3)"}
                      opacity={t.usedIn?.length ? 0.9 : 0.5}
                    />
                  </g>
                ))
              : used.map((u, i) => (
                  <g key={`${u.take.id}-${String(i)}`} transform={`translate(0, ${24 + i * 22})`}>
                    <text
                      x={0}
                      y={13}
                      fill="var(--hk-ink-2)"
                      fontSize={12}
                      fontFamily="var(--hk-font-sans)"
                    >
                      T{u.take.number}
                    </text>
                    <rect
                      x={120 + (u.barFrom - 1) * 9}
                      y={2}
                      width={(u.barTo - u.barFrom + 1) * 9}
                      height={14}
                      rx={3}
                      fill="var(--hk-signal)"
                      opacity={0.85}
                    />
                    {state === "failed" && i === 1 && (
                      <text
                        x={120 + (u.barTo + 1) * 9}
                        y={13}
                        fill="var(--hk-signal)"
                        fontSize={11}
                        fontFamily="var(--hk-font-sans)"
                      >
                        hand-over does not match the take
                      </text>
                    )}
                  </g>
                ))}
            {mode === "coverage" &&
              gaps.length > 0 &&
              gaps.map((g) => (
                <rect
                  key={g}
                  x={120 + (g - 1) * 9}
                  y={20}
                  width={9}
                  height={its.length * 22 + 4}
                  fill="var(--hk-signal)"
                  opacity={0.08}
                />
              ))}
          </svg>
        </div>
      )}
      {mode === "edl" && used.length > 0 && (
        // Each edit in the version's order: the take it comes from and its bars, and what the
        // list names that is no take of this track.
        <ol
          aria-label="Edit decisions"
          className="flex flex-col rounded-panel-lg border border-line text-[13px]"
        >
          {[...used]
            .sort((a, b) => a.barFrom - b.barFrom)
            .map((u, i) => (
              <li
                key={`${u.take.id}-${String(i)}`}
                className="flex gap-4 border-b border-line px-4 py-2 last:border-b-0"
              >
                <span className="tabular w-10 font-medium text-ink">T{u.take.number}</span>
                <span className="text-ink-3">
                  bars {u.barFrom} to {u.barTo}
                </span>
              </li>
            ))}
          <li className="flex gap-4 px-4 py-2">
            <span className="w-10" />
            <span className="text-ink-3">Pick-up, bar 17.wav · not a take of this track</span>
          </li>
        </ol>
      )}
      {mode === "coverage" && gaps.length > 0 && (
        <p className="text-[13px] text-ink-3">
          Proposed: T{its[0]?.number} covers bars {gaps[0]}–{gaps.at(-1)} by its audio.{" "}
          <button type="button" className="text-ink-2 hover:text-ink">
            Accept
          </button>
        </p>
      )}
    </div>
  );
}
