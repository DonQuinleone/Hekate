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
  /** When the server took this browser's claim, by the server's clock; null before it has. */
  const [claimedAt, setClaimedAt] = useState<number | null>(null);
  /** The server said someone else's browser drives it now, when this one renewed its claim. */
  const [refused, setRefused] = useState(false);
  /** This connection's claim, its own even beside another tab of the same person's. */
  const [claim, setClaim] = useState<string | null>(null);
  const kind = recorder?.kind ?? null;
  const claiming = connected && canLog && Boolean(sessionId) && Boolean(kind);

  // Claimed on connecting (taking over from anyone else), renewed while it lasts, only while it
  // is still this browser's, and let go after.
  useEffect(() => {
    if (!claiming || !sessionId || !kind) return;
    setLost(null);
    setRefused(false);
    let live = true;
    const param = { id: sessionId };
    const mine = uuidv7();
    setClaim(mine);
    void api.sessions[":id"].recorder
      .$put({ param, json: { kind, claim: mine } })
      .then(async (res) => {
        if (!res.ok || !live) return;
        const body = (await res.json()) as { recorder: SessionRecorder | null };
        if (live && body.recorder) setClaimedAt(Date.parse(body.recorder.seenAt));
      })
      .catch(() => undefined);
    const timer = setInterval(() => {
      void api.sessions[":id"].recorder
        .$put({ param, json: { kind, claim: mine, renew: true } })
        .then((res) => {
          if (live && res.status === 409) setRefused(true);
        })
        .catch(() => undefined);
    }, RECORDER_HEARTBEAT_MS);
    return () => {
      live = false;
      clearInterval(timer);
      setClaimedAt(null);
      setClaim(null);
      void api.sessions[":id"].recorder
        .$delete({ param, query: { claim: mine } })
        .catch(() => undefined);
    };
  }, [claiming, sessionId, kind]);

  // Someone else claimed it after the server took this browser's claim (both by the server's
  // clock), or the server refused to renew it: theirs now, so this browser lets go.
  const holder = session?.recorder ?? null;
  const takenOver =
    claiming &&
    (refused ||
      (holder !== null &&
        holder.claim !== claim &&
        claimedAt !== null &&
        Date.parse(holder.seenAt) > claimedAt));
  useEffect(() => {
    if (!takenOver) return;
    recorder?.disconnect();
    setLost(
      holder && holder.by.id === meId
        ? "Your other browser or tab took over the recorder."
        : holder
          ? `${holder.by.name}'s browser took over the recorder.`
          : "Someone else's browser took over the recorder.",
    );
  }, [takenOver, holder, recorder, meId]);

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
    // Whoever drives from another connection, this person's own other tab among them.
    others: holder && holder.claim !== claim ? holder : null,
    lost,
    problem,
    timecode: () =>
      connected && position ? timecodeLabel(timecodeNow(position, Date.now())) : null,
  };
}
