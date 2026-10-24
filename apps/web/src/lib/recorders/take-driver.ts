import {
  RECORDER_HEARTBEAT_MS,
  type RecorderStatus,
  type SessionDetail,
  type SessionRecorder,
  type StartTake,
  type TakeChange,
  takeActionFor,
  timecodeLabel,
  timecodeNow,
} from "@hekate/shared";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { uuidv7 } from "../uuidv7";
import { useRecorder } from "./provider";

type Row = SessionDetail["takeRows"][number];

/** Whether a recorder is connected and listening, whether or not it has said anything yet. */
export const listening = (status: RecorderStatus) =>
  status.state === "listening" || status.state === "silent";

/** Who drives takes from the recorder, as the take log shows it. */
export interface RecorderDrive {
  /** This browser reads a recorder and drives the session's takes from it. */
  drives: boolean;
  /** Someone else's browser does; null when no one else does. */
  others: SessionRecorder | null;
  /** Why this browser stopped driving: someone else took over. */
  lost: string | null;
  /** Something the recorder asked for that the log could not do, said once. */
  problem: string | null;
  /** The recorder's timecode now, for a take started or stopped by hand; null without one. */
  timecode: () => string | null;
}

/**
 * The take log driven by the recorder this browser reads (#51, decision 240). While one is
 * connected and this person may log takes, the session says so to the room (claimed, and said
 * again every ten seconds); the recorder's starts and stops start, roll and stop takes through
 * the log's outbox, as the keys do; and when someone else claims it, this browser lets go.
 */
export function useRecorderTakes({
  session,
  meId,
  canLog,
  live,
  start,
  change,
}: {
  session: SessionDetail | undefined;
  meId: string | null;
  canLog: boolean;
  /** The take rolling or armed, as the log shows it. */
  live: Row | null;
  /** Starts the next take as the log's Space does; says why not, where it cannot. */
  start: (input: Pick<StartTake, "lifecycle" | "timecodeIn" | "number" | "id">) => string | null;
  change: (take: Row, patch: TakeChange) => void;
}): RecorderDrive {
  const recorder = useRecorder();
  const connected = Boolean(recorder?.kind && recorder && listening(recorder.status));
  const sessionId = session?.id ?? null;
  const [lost, setLost] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  /** When this browser last claimed the recorder, by its own clock. */
  const claimedAt = useRef<number | null>(null);
  const kind = recorder?.kind ?? null;
  const claiming = connected && canLog && Boolean(sessionId) && Boolean(kind);

  // Claimed while connected, said again while it lasts, and let go after.
  useEffect(() => {
    if (!claiming || !sessionId || !kind) return;
    setLost(null);
    const claim = () => {
      claimedAt.current ??= Date.now();
      void api.sessions[":id"].recorder
        .$put({ param: { id: sessionId }, json: { kind } })
        .catch(() => undefined);
    };
    claim();
    const timer = setInterval(claim, RECORDER_HEARTBEAT_MS);
    return () => {
      clearInterval(timer);
      claimedAt.current = null;
      void api.sessions[":id"].recorder
        .$delete({ param: { id: sessionId } })
        .catch(() => undefined);
    };
  }, [claiming, sessionId, kind]);

  // Someone else claimed it after this browser did: theirs now, so this one lets go.
  const holder = session?.recorder ?? null;
  const takenOver =
    claiming &&
    holder !== null &&
    holder.by.id !== meId &&
    claimedAt.current !== null &&
    Date.parse(holder.seenAt) > claimedAt.current;
  useEffect(() => {
    if (!takenOver || !holder) return;
    recorder?.disconnect();
    setLost(`${holder.by.name}'s browser took over the recorder.`);
  }, [takenOver, holder, recorder]);

  const drives = claiming && !takenOver;
  // The newest of everything the handler needs, so a recorder's event never acts on an old log.
  const latest = useRef({
    drives,
    live,
    start,
    change,
    trigger: recorder?.options.trigger ?? "off",
  });
  latest.current = { drives, live, start, change, trigger: recorder?.options.trigger ?? "off" };
  // A take the recorder started or stopped, until the log shows it: two events close together
  // (record exit, then stop) never act twice on the same take.
  const acted = useRef<Row | null>(null);
  const shown = `${live?.id}:${live?.lifecycle}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: forgotten whenever the log moves on.
  useEffect(() => {
    acted.current = null;
  }, [shown]);

  const subscribe = recorder?.subscribe;
  useEffect(() => {
    if (!subscribe) return;
    return subscribe((event) => {
      const now = latest.current;
      if (!now.drives) return;
      const take = acted.current ?? now.live;
      const action = takeActionFor(event, now.trigger, take);
      if (!action) return;
      if (action.kind === "start") {
        const id = uuidv7();
        const refused = now.start({
          id,
          lifecycle: "recording",
          ...(action.timecodeIn ? { timecodeIn: action.timecodeIn } : {}),
          ...(action.number !== null ? { number: action.number } : {}),
        });
        if (refused) return setProblem(`The recorder started, but the take did not: ${refused}`);
        setProblem(null);
        // Enough of the take for a stop to act on before the log shows it.
        acted.current = {
          ...(now.live ?? ({} as Row)),
          id,
          lifecycle: "recording",
          timecodeOut: null,
        };
        return;
      }
      if (!take) return;
      if (action.kind === "roll") {
        now.change(take, { lifecycle: "recording", timecodeIn: action.timecodeIn });
        acted.current = { ...take, lifecycle: "recording" };
      } else {
        now.change(take, { lifecycle: "recorded", timecodeOut: action.timecodeOut });
        acted.current = { ...take, lifecycle: "recorded" };
      }
    });
  }, [subscribe]);

  const position = recorder?.position ?? null;
  return {
    drives,
    others: holder && holder.by.id !== meId ? holder : null,
    lost,
    problem,
    timecode: () =>
      connected && position ? timecodeLabel(timecodeNow(position, Date.now())) : null,
  };
}
