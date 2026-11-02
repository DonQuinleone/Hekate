import { formatAnchor, type TakeDetail } from "@hekate/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import { DocumentViewer } from "~/components/document-viewer";
import { Empty } from "~/components/empty";
import { Icon } from "~/components/icons";
import { PageHeader } from "~/components/page-header";
import { Player } from "~/components/player";
import { Rating } from "~/components/takes";
import { Button } from "~/components/ui/button";
import { Radio } from "~/components/ui/choice";
import { Dialog } from "~/components/ui/dialog";
import { Field } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { Failed, failureText, Loading } from "~/components/ui/states";
import { cn } from "~/lib/cn";
import { threadsOf } from "~/lib/comments";
import { formatDates } from "~/lib/locale";
import type { Loop } from "~/lib/loop";
import { initialFocus, type PageFocus } from "~/lib/pages";
import {
  commentsQuery,
  editDecisionsQuery,
  type FileDetail,
  fileQuery,
  playbackQuery,
  projectQuery,
  takeQuery,
  trackQuery,
  useCommentMutations,
  useProjectCan,
  useTakeMutations,
} from "~/lib/queries";
import { useShortcuts } from "~/lib/shortcuts";
import {
  coverageLabel,
  falseStartsLabel,
  takeLoop,
  threadMatches,
  timecodeSpan,
} from "~/lib/take-page";
import { primaryOf } from "~/lib/versions";
import { PageFailed } from "~/routes/problem";

const dayFormat = formatDates({ day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** A session's day, in the workspace's format: a date has no time zone, so UTC. */
const dayOf = (iso: string) => dayFormat.format(new Date(`${iso}T12:00:00Z`));

/**
 * One take on its own page (#21, #45), as the prototype's: what is known of it in a line,
 * the takes of the same track from its session to switch between (by number key too), its
 * recording to hear and loop, its notes, and its place in the score beside it.
 *
 * A take is one file for now, its summed mix (decision 246): that is the one lane, heard
 * through the protected player like any recording. Its microphones' lanes, each to solo and
 * mute, join it once takes hold a file per microphone.
 */
export function TakePage({ takeId }: { takeId: string }) {
  const { data: take, error, refetch } = useQuery(takeQuery(takeId));
  const projectId = take?.track.projectId;
  const { data: project } = useQuery({
    ...projectQuery(projectId ?? ""),
    enabled: Boolean(projectId),
  });
  const can = useProjectCan(projectId);
  const navigate = useNavigate();
  // Which version's edit decision list uses it (#56).
  const { data: decisions } = useQuery({
    ...editDecisionsQuery(take?.track.id ?? ""),
    enabled: Boolean(take),
  });
  const [sharing, setSharing] = useState(false);
  const siblings = take?.siblings ?? [];
  // The number keys switch between the session's takes of the track, as the prototype's do.
  useShortcuts(
    "take",
    "Take",
    siblings.slice(0, 9).map((t, i) => ({
      keys: [String(i + 1)],
      label: `Take ${t.number}`,
      run: () => void navigate({ to: "/takes/$takeId", params: { takeId: t.id } }),
    })),
    siblings.length > 1,
  );
  if (error) return <PageFailed what="This take" error={error} retry={refetch} />;
  if (!take || !project) return <Loading />;
  const used = decisions?.uses.some((u) => u.takeId === take.id)
    ? `V${decisions.version.number}`
    : null;
  const coverage = coverageLabel(take);
  const timecode = timecodeSpan(take.timecodeIn, take.timecodeOut);
  const falseStarts = falseStartsLabel(take.falseStarts);
  return (
    <>
      <PageHeader
        // A take is its track's, never its session's (#568): the session is said beside it.
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
            key: "track",
            link: (
              <Link
                to="/tracks/$trackId"
                params={{ trackId: take.track.id }}
                search={{ view: "versions" }}
              >
                {take.track.name}
              </Link>
            ),
          },
          {
            key: "takes",
            link: (
              <Link
                to="/tracks/$trackId"
                params={{ trackId: take.track.id }}
                search={{ view: "takes" }}
              >
                Takes
              </Link>
            ),
          },
        ]}
        title={`Take ${take.number}`}
        actions={
          // Shared on a thread by those who triage its comments (#133).
          can("triage") && !project.archivedAt ? (
            <Button variant="secondary" size="sm" onClick={() => setSharing(true)}>
              <Icon name="comment" size={14} />
              Attach to a comment
            </Button>
          ) : undefined
        }
      />
      <div className="fade-in flex min-h-0 flex-1 flex-col @3xl/app:flex-row">
        <div className="flex min-w-0 flex-1 flex-col gap-4 px-5 py-6 @3xl/app:px-6">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-ink-3">
            <Rating value={take.rating} />
            {take.starred && (
              <span className="flex items-center gap-1 text-signal">
                <Icon name="star" size={12} fill="currentColor" />
                starred
              </span>
            )}
            {take.session && (
              <Link
                to="/sessions/$sessionId"
                params={{ sessionId: take.session.id }}
                className="text-ink-2 no-underline hover:text-ink"
              >
                {[
                  take.session.name,
                  take.session.recordedOn ? dayOf(take.session.recordedOn) : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </Link>
            )}
            {coverage && <span className="tabular">{coverage}</span>}
            {timecode && <span className="tabular">{timecode}</span>}
            {take.lifecycle === "aborted" && <span>aborted</span>}
            {falseStarts && <span>{falseStarts}</span>}
            {/* Where an edit uses it, said quietly: it is a fact, not a status (#703). */}
            {used && <span>in {used}</span>}
            {siblings.length > 1 && (
              <nav
                aria-label={`Takes of ${take.track.name}${take.session ? ` recorded in ${take.session.name}` : ""}`}
                className="ml-auto flex flex-wrap gap-1"
              >
                {siblings.map((t) => (
                  <Link
                    key={t.id}
                    to="/takes/$takeId"
                    params={{ takeId: t.id }}
                    aria-current={t.id === take.id ? "page" : undefined}
                    className={cn(
                      "tabular flex h-7 items-center rounded-control px-2 text-[12px] no-underline transition-colors",
                      t.id === take.id
                        ? "bg-raised text-ink shadow-1"
                        : "text-ink-3 hover:bg-raised/60 hover:text-ink",
                    )}
                  >
                    T{t.number}
                  </Link>
                ))}
              </nav>
            )}
          </div>
          {/* Each take starts afresh: its own stream, playhead and loop. */}
          <Recording key={take.id} take={take} />
          <Notes
            key={`notes-${take.id}`}
            take={take}
            canEdit={can("edit_takes") && !project.archivedAt}
          />
        </div>
        {take.track.scoreFileId && take.barFrom !== null && (
          <ScoreAside key={`score-${take.id}`} scoreFileId={take.track.scoreFileId} take={take} />
        )}
      </div>
      {sharing && <AttachDialog take={take} onClose={() => setSharing(false)} />}
    </>
  );
}

function Waiting({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-40 items-center justify-center rounded-panel-lg border border-line px-4 py-10 text-center text-[14px] text-ink-3">
      {children}
    </div>
  );
}

/**
 * The take's recording: its summed mix, the one lane for now, through the protected player
 * (encrypted segments, a session-bound key). The player's own Loop is the one Loop (#572): it
 * starts as the take, from its in point to its out point, and a drag makes another.
 */
function Recording({ take }: { take: TakeDetail }) {
  const client = useQueryClient();
  const fileId = take.file?.id ?? "";
  const { data: file, error: fileError } = useQuery({
    ...fileQuery(fileId),
    enabled: Boolean(take.file),
  });
  const ready = file?.streamStatus === "ready" && (file.kind === "audio" || file.kind === "video");
  const { data: playback, error } = useQuery({ ...playbackQuery(fileId), enabled: ready });
  const [_media, _setMedia] = useState<HTMLMediaElement | null>(null);
  const [loop, setLoop] = useState<Loop | null | undefined>(undefined);
  if (!take.file)
    return (
      <Empty
        title="No recording yet"
        text="This take was logged without a file. Importing the session's files gives it its mix."
      />
    );
  if (fileError) return <Waiting>{failureText(fileError)}</Waiting>;
  if (!file) return <Loading size="panel" label="Loading the player" />;
  if (file.kind !== "audio" && file.kind !== "video")
    return <Waiting>This take's file is not a recording.</Waiting>;
  if (file.streamStatus === "failed")
    return (
      <Waiting>
        This file could not be prepared for playback. Upload it again, or ask whoever runs the
        instance.
      </Waiting>
    );
  if (file.mediaInfo === null) return <Waiting>Measuring the file.</Waiting>;
  if (file.streamStatus !== "ready") return <Waiting>Preparing for playback.</Waiting>;
  if (error) return <Waiting>{failureText(error)}</Waiting>;
  if (!playback) return <Loading size="panel" label="Loading the player" />;
  // Until another is made, the loop is the take's own in and out points.
  const shown = loop === undefined ? takeLoop(take, file.mediaInfo.duration ?? null) : loop;
  return (
    <div className="flex min-h-[260px] flex-col overflow-hidden rounded-panel-lg border border-line bg-raised/25 shadow-1">
      <Player
        strip={{ lead: <MixLead file={file} /> }}
        fileId={file.id}
        kind={file.kind}
        playback={playback}
        info={file.mediaInfo}
        loop={shown}
        onLoop={setLoop}
        tools={file.tools ?? null}
        mark={file.watermark}
        normalisation={file.normalisation}
        onExpired={() => client.resetQueries({ queryKey: playbackQuery(file.id).queryKey })}
      />
    </div>
  );
}

/** The lane's name above the player: the summed mix, and its file. */
function MixLead({ file }: { file: FileDetail }) {
  return (
    <span className="flex min-w-0 items-center gap-2 text-[13px]">
      <span className="font-medium text-ink">Mix</span>
      <Link
        to="/files/$fileId"
        params={{ fileId: file.id }}
        className="min-w-0 truncate text-ink-3 no-underline hover:text-ink"
      >
        {file.name}
      </Link>
    </span>
  );
}

/** The producer's notes on the take: written in place by those who edit takes. */
function Notes({ take, canEdit }: { take: TakeDetail; canEdit: boolean }) {
  const { change } = useTakeMutations(take.track.id);
  const [notes, setNotes] = useState(take.notes ?? "");
  // What the server holds now, once someone else's change arrives.
  useEffect(() => setNotes(take.notes ?? ""), [take.notes]);
  const save = () => {
    const next = notes.trim() || null;
    if (next === (take.notes ?? null)) return;
    change.mutate({ id: take.id, notes: next, base: { notes: take.notes } });
  };
  if (!canEdit)
    return (
      <div className="flex flex-col gap-1.5 text-[13px]">
        <span className="text-ink-2">Notes</span>
        <p className="m-0 text-[14px] text-ink">
          {take.notes || <span className="text-ink-3">No notes on this take.</span>}
        </p>
      </div>
    );
  return (
    <Field label="Notes" error={change.error?.message}>
      <Input
        value={notes}
        maxLength={4000}
        onChange={(e) => setNotes(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        placeholder="Steady tempo, a touch of noise at the end"
      />
    </Field>
  );
}

/** The score at the take's bars, beside it: the pages as the server draws them, at its page. */
function ScoreAside({ scoreFileId, take }: { scoreFileId: string; take: TakeDetail }) {
  const { data: score } = useQuery(fileQuery(scoreFileId));
  const [focus, setFocus] = useState<PageFocus>({ ...initialFocus, page: take.page ?? 1 });
  // Someone the score is not shown to sees nothing of it.
  if (!score) return null;
  const bars = coverageLabel({ page: null, barFrom: take.barFrom, barTo: take.barTo });
  return (
    <aside
      aria-label="Its place in the score"
      className="flex w-full shrink-0 flex-col border-t border-line @3xl/app:w-[380px] @3xl/app:border-t-0 @3xl/app:border-l"
    >
      <div className="flex h-11 items-center gap-2 px-4 text-[13px]">
        <span className="font-medium text-ink">Its place in the score</span>
        {bars && <span className="text-ink-3">{bars}</span>}
      </div>
      <div className="flex min-h-[360px] flex-1 flex-col px-4 pb-4">
        {score.streamStatus === "ready" ? (
          <DocumentViewer
            fileId={score.id}
            name={score.name}
            focus={focus}
            onFocus={(next) => setFocus((f) => ({ ...f, ...next }))}
            fill
          />
        ) : (
          <p className="m-0 text-[13px] text-ink-3">
            {score.streamStatus === "failed" ? "The pages could not be drawn" : "Drawing the pages"}
          </p>
        )}
      </div>
    </aside>
  );
}

/**
 * Attaching the take to a thread of the track's latest version (#133): everyone who sees the
 * thread hears exactly this take, at the thread's bar where it is about one. The threads are
 * listed as the Attach take picker lists takes (#655): each by where it points, its version and
 * variant, and who wrote it, with a search.
 */
function AttachDialog({ take, onClose }: { take: TakeDetail; onClose: () => void }) {
  const {
    data: track,
    error: trackError,
    refetch: refetchTrack,
  } = useQuery(trackQuery(take.track.id));
  const latest = track?.versions.at(-1);
  const primary = latest ? primaryOf(latest) : undefined;
  const fileId = primary?.fileId ?? "";
  const {
    data: comments,
    error: commentsError,
    refetch: refetchComments,
  } = useQuery({
    ...commentsQuery(fileId),
    enabled: Boolean(primary),
  });
  const { shareTakes } = useCommentMutations(fileId);
  const open = comments ? threadsOf(comments).open : [];
  const [chosen, setChosen] = useState("");
  const [search, setSearch] = useState("");
  const anchorOf = (c: (typeof open)[number]["comment"]) =>
    // As a thread's own line writes it: "Bars 9–12", "0:21.400 – 0:23.000".
    c.anchor ? formatAnchor(c.anchor).replace(/(^|\s)0(\d:)/g, "$1$2") : null;
  const shown = open.filter((t) =>
    threadMatches(
      { body: t.comment.body, authorName: t.comment.authorName, anchor: anchorOf(t.comment) },
      search,
    ),
  );
  const thread = open.some((t) => t.comment.id === chosen) ? chosen : "";
  const error = trackError ?? commentsError;
  const where = latest && primary ? `V${latest.number} · ${primary.name}` : "";
  const body = error ? (
    <Failed
      what="The threads"
      error={error}
      retry={() => (trackError ? refetchTrack() : refetchComments())}
      size="panel"
      className="px-0"
    />
  ) : !track || (primary && !comments) ? (
    <Loading size="panel" className="px-0" />
  ) : !latest || !primary ? (
    <p className="m-0 text-[13px] text-ink-2">
      {take.track.name} has no version yet: a take is attached to a comment on one.
    </p>
  ) : open.length === 0 ? (
    <p className="m-0 text-[13px] text-ink-2">
      No open comments on V{latest.number} yet. Write one on the version, then attach this take to
      it.
    </p>
  ) : (
    <form
      id="attach-take"
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (thread)
          shareTakes.mutate({ commentId: thread, takeIds: [take.id] }, { onSuccess: onClose });
      }}
    >
      {open.length > 4 && (
        <Input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search the threads"
          aria-label="Search the threads"
        />
      )}
      <fieldset className="m-0 border-0 p-0">
        <legend className="sr-only">Thread</legend>
        {shown.length === 0 ? (
          <p className="m-0 text-[13px] text-ink-3">No thread matches.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col rounded-panel border border-line p-0">
            {shown.map((t) => {
              const anchor = anchorOf(t.comment);
              return (
                <li key={t.comment.id} className="border-b border-line last:border-b-0">
                  <label className="flex cursor-pointer items-start gap-3 px-3 py-2 hover:bg-raised/40">
                    <Radio
                      name="thread"
                      checked={thread === t.comment.id}
                      onChange={() => setChosen(t.comment.id)}
                      className="mt-0.5"
                    />
                    <span className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="line-clamp-2 text-[13px] text-ink">{t.comment.body}</span>
                      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-ink-3">
                        {anchor && (
                          <span className="tabular rounded-chip border border-line px-1.5 text-ink-2">
                            {anchor}
                          </span>
                        )}
                        <span className="min-w-0 truncate">
                          {[where, t.comment.authorName].filter(Boolean).join(" · ")}
                        </span>
                      </span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </fieldset>
      {shareTakes.error && (
        <p role="alert" className="m-0 text-[13px] text-signal">
          {shareTakes.error.message}
        </p>
      )}
    </form>
  );
  return (
    <Dialog
      title="Attach this take to a comment"
      description="The reviewers on that thread hear exactly this take, and nothing else from the sessions; on a thread about a bar, at that bar, looped."
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {open.length > 0 ? (
            <Button
              variant="primary"
              type="submit"
              form="attach-take"
              disabled={!thread || shareTakes.isPending}
            >
              Attach to this thread
            </Button>
          ) : (
            primary &&
            latest &&
            comments && (
              <Button variant="primary" asChild>
                <Link to="/files/$fileId" params={{ fileId }}>
                  Open V{latest.number}
                </Link>
              </Button>
            )
          )}
        </>
      }
    >
      {body}
    </Dialog>
  );
}
