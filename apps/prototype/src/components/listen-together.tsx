import { useNavigate } from "@tanstack/react-router";
import { useSyncExternalStore } from "react";
import { Avatar } from "~/components/avatar";
import { Icon } from "~/components/icons";
import { usePageHeader } from "~/components/page-header";
import { Button } from "~/components/ui/button";
import { usePopover } from "~/components/ui/menu";
import { personById } from "~/data";
import { cn } from "~/lib/cn";
import { useViewer } from "~/viewer/context";

/**
 * Listening together (#200): one person leads, and everyone who joins hears what they play, as
 * they play it: play, pause, seeking and which file. Each listener's player still plays through
 * their own protected stream, with their own permissions; what the room carries is only where
 * the leader is. Modelled on a shared screen's "follow" (as in Figma's spotlight): one control
 * in the page header, a strip only when something needs doing, and a pill elsewhere in the app
 * while a room is open.
 */

export type ListeningMode =
  | { kind: "idle" }
  | { kind: "leading"; listeners: string[] }
  | { kind: "following"; leaderId: string; fileId: string; blocked: boolean };

/** The room already live in Joplin Rags, led by Tomas Varga, for the prototype to join. */
export const liveRoom = {
  id: "room-maple",
  leaderId: "p-tomas",
  fileId: "file-maple-v2-dry",
  label: "Maple Leaf Rag · V2 Dry",
  listeners: ["p-ines"],
};

// The room spans pages (the leader may open another version), so it lives outside any one.
let mode: ListeningMode = { kind: "idle" };
const subscribers = new Set<() => void>();
const setMode = (next: ListeningMode) => {
  mode = next;
  for (const fn of subscribers) fn();
};
export function useListening(): [ListeningMode, (next: ListeningMode) => void] {
  const current = useSyncExternalStore(
    (fn) => {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    () => mode,
  );
  return [current, setMode];
}

const namesOf = (ids: string[]) => ids.map((id) => personById(id).name).join(", ");

/** The header's control: what the room is, and the way into one, out of one, or to end it. */
export function ListenTogether({ fileId }: { fileId: string }) {
  const viewer = useViewer();
  const navigate = useNavigate();
  const [listening, setListening] = useListening();
  const [open, setOpen, box] = usePopover();
  const leaderFirst = personById(
    listening.kind === "following" ? listening.leaderId : liveRoom.leaderId,
  ).name.split(" ")[0];
  const label =
    listening.kind === "leading"
      ? `Leading · ${listening.listeners.length}`
      : listening.kind === "following"
        ? `Following ${leaderFirst}`
        : "Listen together";
  // Someone else's room is offered only to those who are not already its leader.
  const others = viewer.personId !== liveRoom.leaderId;
  return (
    <div ref={box} className="relative">
      <Button
        variant="ghost"
        size="md"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={listening.kind === "idle" ? "Lead or join a listening room" : label}
        onClick={() => setOpen(!open)}
        className={cn(open && "bg-raised text-ink", listening.kind !== "idle" && "text-ink")}
      >
        {listening.kind === "idle" ? (
          <Icon name="headphones" size={14} />
        ) : (
          <span aria-hidden="true" className="size-1.5 rounded-full bg-signal" />
        )}
        <span className="hidden @5xl/app:inline">{label}</span>
      </Button>
      {open && (
        <div
          role="dialog"
          aria-label="Listen together"
          data-e2e-overlap
          className="rise-in absolute top-full right-0 z-40 mt-1.5 flex w-80 flex-col gap-3 rounded-panel-lg bg-overlay p-4 shadow-4"
        >
          {listening.kind === "idle" && (
            <>
              <div className="flex flex-col gap-1">
                <span className="text-[14px] font-medium text-ink">Listen together</span>
                <p className="m-0 text-[13px] text-ink-3">
                  Lead, and everyone who joins hears what you play as you play it. Each listens
                  through their own player.
                </p>
              </div>
              {others && (
                <div className="flex flex-col gap-1 border-t border-line pt-3">
                  <span className="eyebrow">Live in this project</span>
                  <div className="flex items-center gap-2.5 py-1">
                    <Avatar personId={liveRoom.leaderId} size={24} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-ink">
                        {personById(liveRoom.leaderId).name}
                      </span>
                      <span className="block truncate text-[12px] text-ink-3">
                        {liveRoom.label} · {liveRoom.listeners.length} listening
                      </span>
                    </span>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setOpen(false);
                        setListening({
                          kind: "following",
                          leaderId: liveRoom.leaderId,
                          fileId: liveRoom.fileId,
                          blocked: false,
                        });
                        navigate({ to: "/files/$fileId", params: { fileId: liveRoom.fileId } });
                      }}
                    >
                      Join
                    </Button>
                  </div>
                </div>
              )}
              <Button
                variant="primary"
                size="md"
                onClick={() => setListening({ kind: "leading", listeners: [] })}
              >
                Start leading
              </Button>
            </>
          )}
          {listening.kind === "leading" && (
            <>
              <div className="flex items-center gap-2">
                <span aria-hidden="true" className="size-1.5 rounded-full bg-signal" />
                <span className="text-[14px] font-medium text-ink">You are leading</span>
              </div>
              {listening.listeners.length === 0 ? (
                <p className="m-0 text-[13px] text-ink-3">
                  No one has joined yet. Members of this project can join from here, or from the
                  link.
                </p>
              ) : (
                <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                  {listening.listeners.map((id) => (
                    <li key={id} className="flex items-center gap-2.5 text-[13px] text-ink-2">
                      <Avatar personId={id} size={22} />
                      {personById(id).name}
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex items-center gap-2 border-t border-line pt-3">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    // Someone joining, for the prototype to show the room filling.
                    setListening({ kind: "leading", listeners: ["p-ines", "p-mira"] })
                  }
                >
                  <Icon name="link" size={14} />
                  Copy link
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto text-signal hover:text-signal"
                  onClick={() => {
                    setOpen(false);
                    setListening({ kind: "idle" });
                  }}
                >
                  End for everyone
                </Button>
              </div>
            </>
          )}
          {listening.kind === "following" && (
            <>
              <div className="flex items-center gap-2.5">
                <Avatar personId={listening.leaderId} size={24} />
                <span className="text-[14px] font-medium text-ink">
                  Following {personById(listening.leaderId).name}
                </span>
              </div>
              <p className="m-0 text-[13px] text-ink-3">
                Their play, pause, seeking and choice of file drive your player. Your volume stays
                yours.
                {liveRoom.listeners.length > 0 &&
                  ` Also listening: ${namesOf(liveRoom.listeners)}.`}
              </p>
              <div className="flex border-t border-line pt-3">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setOpen(false);
                    setListening({ kind: "idle" });
                  }}
                >
                  Leave
                </Button>
              </div>
            </>
          )}
          {listening.kind === "following" && fileId !== listening.fileId && (
            <p className="m-0 text-[12px] text-ink-3">
              You are on another file; the room plays {liveRoom.label}.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A strip above the player, only when there is something to do: the browser waits for a tap
 * before it will play, or the leader is on another file than this one.
 */
export function ListeningNotice({ fileId }: { fileId: string }) {
  const navigate = useNavigate();
  const [listening, setListening] = useListening();
  if (listening.kind !== "following") return null;
  const leader = personById(listening.leaderId).name;
  if (listening.blocked)
    return (
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2 text-[13px]">
        <span aria-hidden="true" className="size-1.5 rounded-full bg-signal" />
        <span className="min-w-0 flex-1 text-ink-2">
          {leader} is playing. Your browser waits for a tap before it plays.
        </span>
        <Button
          size="sm"
          variant="primary"
          onClick={() => setListening({ ...listening, blocked: false })}
        >
          <Icon name="play" size={12} />
          Start listening
        </Button>
      </div>
    );
  if (fileId === listening.fileId) return null;
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2 text-[13px]">
      <span aria-hidden="true" className="size-1.5 rounded-full bg-signal" />
      <span className="min-w-0 flex-1 text-ink-2">
        {leader} is playing {liveRoom.label}.
      </span>
      <Button
        size="sm"
        variant="secondary"
        onClick={() => navigate({ to: "/files/$fileId", params: { fileId: listening.fileId } })}
      >
        Back to the room
      </Button>
    </div>
  );
}

/** Away from the file pages, a pill keeps the room in reach: back to it, leave, or end it. */
export function ListeningPill() {
  const navigate = useNavigate();
  const [listening, setListening] = useListening();
  if (listening.kind === "idle") return null;
  const leading = listening.kind === "leading";
  return (
    <div
      role="status"
      data-e2e-overlap
      className="rise-in fixed bottom-4 left-1/2 z-30 flex max-w-[calc(100%-32px)] -translate-x-1/2 items-center gap-2 rounded-panel-lg bg-overlay py-1.5 pr-1.5 pl-3.5 shadow-4"
    >
      <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-signal" />
      <span className="min-w-0 truncate text-[13px] text-ink">
        {leading
          ? `Leading · ${listening.listeners.length} listening`
          : `Listening with ${personById(listening.leaderId).name}`}
      </span>
      {!leading && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => navigate({ to: "/files/$fileId", params: { fileId: listening.fileId } })}
        >
          Back to the room
        </Button>
      )}
      <Button size="sm" variant="ghost" onClick={() => setListening({ kind: "idle" })}>
        {leading ? "End" : "Leave"}
      </Button>
    </div>
  );
}

/**
 * Where a room's link lands: who leads and what they play, and Join, whose tap is also what
 * lets the browser start playing. A room that has ended, or one in a project the person cannot
 * see, says only that it is not open.
 */
export function ListeningRoomPage({ roomId }: { roomId: string }) {
  const navigate = useNavigate();
  const [, setListening] = useListening();
  const { settings } = useViewer();
  usePageHeader({ title: "Listen together" });
  const open = roomId === liveRoom.id && settings.state !== "expired";
  return (
    <div className="mx-auto flex max-w-md flex-col items-start gap-4 px-6 py-16">
      {open ? (
        <>
          <div className="flex items-center gap-3">
            <Avatar personId={liveRoom.leaderId} size={36} />
            <div className="flex flex-col">
              <span className="text-[16px] font-medium text-ink">
                {personById(liveRoom.leaderId).name} is leading
              </span>
              <span className="text-[13px] text-ink-3">
                {liveRoom.label} · {liveRoom.listeners.length} listening
              </span>
            </div>
          </div>
          <p className="m-0 text-ink-2">
            Join, and your player follows theirs: play, pause, seeking and which file. You can leave
            whenever you like.
          </p>
          <Button
            variant="primary"
            onClick={() => {
              setListening({
                kind: "following",
                leaderId: liveRoom.leaderId,
                fileId: liveRoom.fileId,
                blocked: false,
              });
              navigate({ to: "/files/$fileId", params: { fileId: liveRoom.fileId } });
            }}
          >
            Join
          </Button>
        </>
      ) : (
        <>
          <h2 className="m-0 text-[16px] font-medium">This listening room is not open</h2>
          <p className="m-0 text-ink-2">
            Its leader has ended it, or it is in a project you are not part of.
          </p>
          <Button variant="secondary" onClick={() => navigate({ to: "/" })}>
            Go home
          </Button>
        </>
      )}
    </div>
  );
}
