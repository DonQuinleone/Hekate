import type {
  SessionChange,
  SessionDetail,
  SessionTodoChange,
  StartTake,
  TakeChange,
} from "@hekate/shared";

/**
 * The take log's outbox (#51): what the log has written and the server has not yet confirmed.
 * Every write goes here first, so the log carries on while the connection is down and sends
 * them, in order, when it returns. The log shows the server's session with these laid over it.
 */
export type PendingWrite =
  | {
      seq?: number;
      kind: "start";
      sessionId: string;
      takeId: string;
      /** The number the log showed, until the server numbers it. */
      number: number;
      body: StartTake & { id: string; at: string };
    }
  | {
      seq?: number;
      kind: "change";
      sessionId: string;
      takeId: string;
      body: TakeChange & { at: string };
    }
  /** The session's notes or the producer's quick reference: the last written stands. */
  | {
      seq?: number;
      kind: "notes";
      sessionId: string;
      body: Pick<SessionChange, "notes" | "reference">;
    }
  /** The room's to-do list, an item at a time; a new one named here, so it is made once. */
  | { seq?: number; kind: "todo-add"; sessionId: string; todoId: string; body: { text: string } }
  | {
      seq?: number;
      kind: "todo-change";
      sessionId: string;
      todoId: string;
      body: SessionTodoChange;
    }
  | { seq?: number; kind: "todo-remove"; sessionId: string; todoId: string };

type Row = SessionDetail["takeRows"][number];

/** A take as the server would make it from a start, until it does. */
function startedRow(session: SessionDetail, write: Extract<PendingWrite, { kind: "start" }>): Row {
  const track = session.tracks.find((t) => t.id === write.body.trackId);
  const rolling = write.body.lifecycle !== "armed";
  return {
    id: write.takeId,
    number: write.number,
    label: null,
    notes: null,
    rating: 0,
    starred: false,
    page: null,
    pageTo: null,
    barFrom: null,
    barTo: null,
    inPoint: null,
    outPoint: null,
    sessionId: session.id,
    lifecycle: rolling ? "recording" : "armed",
    falseStarts: 0,
    timecodeIn: write.body.timecodeIn ?? null,
    timecodeOut: null,
    wallIn: rolling ? write.body.at : null,
    wallOut: null,
    file: null,
    createdAt: write.body.at,
    track: { id: write.body.trackId, name: track?.name ?? "" },
  };
}

/** A change laid over a take, timing its roll and stop as the server would. */
function changedRow(row: Row, body: TakeChange & { at: string }): Row {
  const { base: _base, at, ...change } = body as TakeChange & { at: string };
  const next = { ...row, ...change } as Row;
  if (change.lifecycle === "recording" && !row.wallIn && change.wallIn === undefined)
    next.wallIn = at;
  if (
    (change.lifecycle === "recorded" || change.lifecycle === "aborted") &&
    !row.wallOut &&
    change.wallOut === undefined
  )
    next.wallOut = at;
  return next;
}

/** The session as the log should show it: the server's, with what is still to be sent on top. */
export function withPending(
  session: SessionDetail,
  writes: readonly PendingWrite[],
): SessionDetail {
  const mine = writes.filter((w) => w.sessionId === session.id);
  if (mine.length === 0) return session;
  let rows = [...session.takeRows];
  const nextNumbers = { ...session.nextNumbers };
  let { notes, reference, todos } = session;
  for (const write of mine) {
    if (write.kind === "notes") {
      if (write.body.notes !== undefined) notes = write.body.notes;
      if (write.body.reference !== undefined) reference = write.body.reference;
    } else if (write.kind === "todo-add") {
      if (!todos.some((t) => t.id === write.todoId))
        todos = [...todos, { id: write.todoId, text: write.body.text, done: false }];
    } else if (write.kind === "todo-change") {
      todos = todos.map((t) => (t.id === write.todoId ? { ...t, ...write.body } : t));
    } else if (write.kind === "todo-remove") {
      todos = todos.filter((t) => t.id !== write.todoId);
    } else if (write.kind === "start") {
      if (rows.some((r) => r.id === write.takeId)) continue;
      rows.push(startedRow(session, write));
      // The next number moves on, for the track or, numbered continuously, for every track.
      const bump = (trackId: string) => {
        nextNumbers[trackId] = Math.max(nextNumbers[trackId] ?? 1, write.number + 1);
      };
      if (session.numbering === "continuous") for (const id of Object.keys(nextNumbers)) bump(id);
      else bump(write.body.trackId);
    } else {
      rows = rows.map((r) => (r.id === write.takeId ? changedRow(r, write.body) : r));
    }
  }
  return { ...session, takeRows: rows, nextNumbers, notes, reference, todos };
}

/**
 * A change that rolls or stops a take, with the moment it did, so a change sent late keeps the
 * room's time rather than taking the server's when it arrives.
 */
export function rolledAt(row: Row, change: TakeChange, at: string): TakeChange {
  if (change.lifecycle === "recording" && !row.wallIn && change.wallIn === undefined)
    return { ...change, wallIn: at };
  if (
    (change.lifecycle === "recorded" || change.lifecycle === "aborted") &&
    !row.wallOut &&
    change.wallOut === undefined
  )
    return { ...change, wallOut: at };
  return change;
}

/**
 * What the writer last saw of the fields a change sets, sent with it so the server can tell
 * when it replaces someone else's change.
 */
export function baseOf(row: Row | undefined, change: TakeChange): Record<string, unknown> {
  if (!row) return {};
  const base: Record<string, unknown> = {};
  for (const key of Object.keys(change)) {
    if (key === "base" || key === "at") continue;
    base[key] = (row as unknown as Record<string, unknown>)[key] ?? null;
  }
  return base;
}

/**
 * What to do with a write the server answered: keep it for later, or let it go. Signed out
 * (401) it waits, so signing in again sends it; refused for what it is (a take that moved on,
 * a page out of order), it goes, and the log says why.
 */
export function outcomeOf(status: number | "offline"): "sent" | "retry" | "refused" {
  if (
    status === "offline" ||
    status === 0 ||
    status === 401 ||
    status === 408 ||
    status === 429 ||
    status >= 500
  )
    return "retry";
  return status >= 400 ? "refused" : "sent";
}
