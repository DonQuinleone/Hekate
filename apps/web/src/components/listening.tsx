import type { ListeningRoom } from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Avatar } from "~/components/avatar";
import { Icon } from "~/components/icons";
import { Button } from "~/components/ui/button";
import { usePopover } from "~/components/ui/menu";
import { cn } from "~/lib/cn";
import { followStep, leaderState } from "~/lib/listening";
import {
  type Listening,
  listeningRoomQuery,
  listeningRoomsQuery,
  useListening,
} from "~/lib/listening-room";
import { fileQuery, meQuery } from "~/lib/queries";

/**
 * Listening together (#200), as the prototype draws it: one control in the file page's header
 * (rooms to join, starting one, who is listening, leaving or ending), a strip above the player
 * only when there is something to do, a pill elsewhere in the app, and the page a room's link
 * opens. The player itself is untouched: the page's media element is moved as the leader's is.
 */

const firstName = (name: string) => name.split(/\s+/)[0] ?? name;

/** A file's short name for the room: a track's version and variation, or the file's own name. */
function useFileLabel(fileId: string | null) {
  const { data } = useQuery({ ...fileQuery(fileId ?? ""), enabled: Boolean(fileId) });
  if (!data) return null;
  return data.variation
    ? `${data.variation.trackName} · V${data.variation.versionNumber} ${data.variation.name}`
    : data.name;
}

/** Copy the room's link, for someone not looking at the file to join from. */
const linkOf = (roomId: string) => `${window.location.origin}/listen/${roomId}`;

/** The header's control on a recording or a video. */
export function ListenTogether({ fileId, projectId }: { fileId: string; projectId: string }) {
  const listening = useListening();
  const navigate = useNavigate();
  const [open, setOpen, box] = usePopover();
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { data: rooms } = useQuery({ ...listeningRoomsQuery(projectId), enabled: open });
  const { data: me } = useQuery(meQuery);
  if (!listening) return null;
  const { room, leading } = listening;
  const others = (room?.listeners ?? []).filter((p) => p.id !== me?.user.id).map((p) => p.name);
  const inRoom = listening.roomId !== null && listening.status !== "ended";
  const label = !inRoom
    ? "Listen together"
    : leading
      ? `Leading · ${room?.listeners.length ?? 0}`
      : room
        ? `Following ${firstName(room.leader.name)}`
        : "Joining";
  const joinable = (rooms ?? []).filter((r) => r.id !== listening.roomId);
  const join = (r: ListeningRoom) => {
    setOpen(false);
    listening.join(r.id);
    if (r.fileId && r.fileId !== fileId)
      void navigate({ to: "/files/$fileId", params: { fileId: r.fileId } });
  };
  return (
    <div ref={box} className="relative">
      <Button
        variant="ghost"
        size="sm"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={inRoom ? label : "Lead or join a listening room"}
        onClick={() => setOpen(!open)}
        className={cn(open && "bg-raised text-ink", inRoom && "text-ink")}
      >
        {inRoom ? (
          <span aria-hidden="true" className="size-1.5 rounded-full bg-signal" />
        ) : (
          <Icon name="headphones" size={14} />
        )}
        <span className="sr-only lg:not-sr-only">{label}</span>
      </Button>
      {open && (
        <div
          role="dialog"
          aria-label="Listen together"
          data-e2e-overlap
          className="rise-in absolute top-full right-0 z-40 mt-1.5 flex w-80 max-w-[calc(100vw-32px)] flex-col gap-3 rounded-panel-lg bg-overlay p-4 shadow-4"
        >
          {!inRoom && (
            <>
              <div className="flex flex-col gap-1">
                <span className="text-[14px] font-medium text-ink">Listen together</span>
                <p className="m-0 text-[13px] text-ink-3">
                  Lead, and everyone who joins hears what you play as you play it. Each listens
                  through their own player.
                </p>
              </div>
              {joinable.length > 0 && (
                <div className="flex flex-col gap-1 border-t border-line pt-3">
                  <span className="eyebrow">Live in this project</span>
                  {joinable.map((r) => (
                    <JoinRow key={r.id} room={r} onJoin={() => join(r)} />
                  ))}
                </div>
              )}
              {error && <p className="m-0 text-[13px] text-signal">{error}</p>}
              <Button
                variant="primary"
                size="md"
                onClick={() => {
                  setError(null);
                  listening
                    .start(projectId, fileId)
                    .catch((e: unknown) =>
                      setError(e instanceof Error ? e.message : "The room could not be started"),
                    );
                }}
              >
                Start leading
              </Button>
            </>
          )}
          {inRoom && leading && room && (
            <>
              <div className="flex items-center gap-2">
                <span aria-hidden="true" className="size-1.5 rounded-full bg-signal" />
                <span className="text-[14px] font-medium text-ink">You are leading</span>
              </div>
              {room.listeners.length === 0 ? (
                <p className="m-0 text-[13px] text-ink-3">
                  No one has joined yet. Members of this project can join from here, or from the
                  link.
                </p>
              ) : (
                <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                  {room.listeners.map((p) => (
                    <li key={p.id} className="flex items-center gap-2.5 text-[13px] text-ink-2">
                      <Avatar id={p.id} name={p.name} size={22} />
                      {p.name}
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex items-center gap-2 border-t border-line pt-3">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    void navigator.clipboard
                      ?.writeText(linkOf(room.id))
                      .then(() => setCopied(true))
                      .catch(() => undefined);
                  }}
                >
                  <Icon name={copied ? "check" : "link"} size={14} />
                  {copied ? "Copied" : "Copy link"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto text-signal hover:text-signal"
                  onClick={() => {
                    setOpen(false);
                    void listening.leave();
                  }}
                >
                  End for everyone
                </Button>
              </div>
            </>
          )}
          {inRoom && !leading && (
            <>
              {room ? (
                <div className="flex items-center gap-2.5">
                  <Avatar id={room.leader.id} name={room.leader.name} size={24} />
                  <span className="text-[14px] font-medium text-ink">
                    Following {room.leader.name}
                  </span>
                </div>
              ) : (
                <span className="text-[14px] font-medium text-ink">Joining the room</span>
              )}
              <p className="m-0 text-[13px] text-ink-3">
                Their play, pause, seeking and choice of file drive your player. Your volume stays
                yours.
                {others.length > 0 ? ` Also listening: ${others.join(", ")}.` : ""}
              </p>
              <div className="flex border-t border-line pt-3">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setOpen(false);
                    void listening.leave();
                  }}
                >
                  Leave
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function JoinRow({ room, onJoin }: { room: ListeningRoom; onJoin: () => void }) {
  const label = useFileLabel(room.fileId);
  return (
    <div className="flex items-center gap-2.5 py-1">
      <Avatar id={room.leader.id} name={room.leader.name} size={24} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] text-ink">{room.leader.name}</span>
        <span className="block truncate text-[12px] text-ink-3">
          {label ? `${label} · ` : ""}
          {room.listeners.length} listening
        </span>
      </span>
      <Button size="sm" variant="secondary" onClick={onJoin}>
        Join
      </Button>
    </div>
  );
}

/** What the file page's player is doing in a room, for the strip above it. */
export interface ListeningSync {
  /** The browser waits for a tap before it plays. */
  blocked: boolean;
  /** The listener moved their own player, and stopped following. */
  detached: boolean;
  /** The room plays another file than this one. */
  elsewhere: string | null;
  leaderName: string | null;
  resume(): void;
}

const idle: ListeningSync = {
  blocked: false,
  detached: false,
  elsewhere: null,
  leaderName: null,
  resume: () => {},
};

/** How long after moving the player itself the page takes its events as its own. */
const OWN_EVENTS_MS = 800;
/** How often a listener checks it is still where the leader is, and a leader says so. */
const FOLLOW_TICK_MS = 1_000;
const LEADER_TICK_MS = 10_000;

/**
 * Leads or follows with the file page's media element: a leader's play, pause, seeking and
 * speed are sent as they happen (and every few seconds while playing, so a stall is caught
 * up); a listener's player is moved to where the leader is, and taken to the leader's file
 * when the leader moves on from the one they were both on. A listener who plays, pauses or
 * seeks themselves stops following until they choose to again.
 */
export function useListeningSync(
  fileId: string,
  projectId: string,
  media: HTMLMediaElement | null,
): ListeningSync {
  const listening = useListening();
  const navigate = useNavigate();
  const [blocked, setBlocked] = useState(false);
  const [detached, setDetached] = useState(false);
  const own = useRef(0);
  // Held through a reconnection: a moment's break neither pauses the room nor lets go of it.
  const room = listening && listening.status !== "ended" ? listening.room : null;
  const leading = Boolean(listening?.leading);
  const inProject = room?.projectId === projectId;

  // The leader: every move of theirs, from this file.
  const move = listening?.move;
  useEffect(() => {
    if (!media || !move || !leading || !inProject) return;
    const send = () => move(leaderState(fileId, media));
    send();
    const events = ["play", "pause", "seeked", "ratechange", "ended"] as const;
    for (const e of events) media.addEventListener(e, send);
    const tick = setInterval(() => {
      if (!media.paused) send();
    }, LEADER_TICK_MS);
    return () => {
      for (const e of events) media.removeEventListener(e, send);
      clearInterval(tick);
      // Leaving the file stops its sound; the room stops with it, where it was.
      move({ ...leaderState(fileId, media), playing: false });
    };
  }, [media, move, leading, inProject, fileId]);

  // A listener: taken along when the leader moves on from the file they were both on.
  const followed = useRef<string | null>(null);
  useEffect(() => {
    if (!room || leading) {
      followed.current = null;
      return;
    }
    const was = followed.current;
    followed.current = room.fileId;
    if (room.fileId && was === fileId && room.fileId !== fileId && !detached) {
      void navigate({ to: "/files/$fileId", params: { fileId: room.fileId } });
    }
  }, [room, leading, fileId, navigate, detached]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new file is followed afresh.
  useEffect(() => {
    if (room && room.fileId === fileId) followed.current = fileId;
  }, [fileId]);

  // A listener on the room's file: played where the leader is.
  const here = Boolean(room && !leading && room.fileId === fileId);
  const roomRef = useRef(room);
  roomRef.current = room;
  const offset = listening?.offset ?? 0;
  const applyNow = useRef<() => void>(() => {});
  useEffect(() => {
    if (!media || !here || detached) return;
    let revision = -1;
    const apply = () => {
      const current = roomRef.current;
      if (!current || media.readyState < 1) return;
      const moved = current.revision !== revision;
      revision = current.revision;
      const step = followStep(
        {
          time: media.currentTime,
          paused: media.paused,
          rate: media.playbackRate,
          duration: media.duration,
        },
        current,
        Date.now() + offset,
        moved,
      );
      if (step.seek === null && step.play === null && step.rate === null) return;
      own.current = Date.now();
      if (step.rate !== null) media.playbackRate = step.rate;
      if (step.seek !== null) media.currentTime = step.seek;
      if (step.play === true)
        void media
          .play()
          .then(() => setBlocked(false))
          .catch((error: unknown) => {
            if (error instanceof DOMException && error.name === "NotAllowedError") setBlocked(true);
          });
      if (step.play === false) media.pause();
    };
    apply();
    applyNow.current = apply;
    const tick = setInterval(apply, FOLLOW_TICK_MS);
    media.addEventListener("loadedmetadata", apply);
    // Their own hand on the player: they stop following. Not the file ending by itself, nor
    // the stream nudging past a stall while it waits for data.
    const mine = (event: Event) => {
      if (Date.now() - own.current <= OWN_EVENTS_MS || media.ended) return;
      if (event.type === "seeking" && media.readyState < 2) return;
      setDetached(true);
    };
    const events = ["play", "pause", "seeking"] as const;
    for (const e of events) media.addEventListener(e, mine);
    return () => {
      applyNow.current = () => {};
      clearInterval(tick);
      media.removeEventListener("loadedmetadata", apply);
      for (const e of events) media.removeEventListener(e, mine);
    };
  }, [media, here, detached, offset]);
  // Each change the leader makes lands at once, not on the next tick.
  // biome-ignore lint/correctness/useExhaustiveDependencies: applied as each event arrives.
  useEffect(() => applyNow.current(), [room]);
  // Leaving the room, or a new one, starts afresh.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset whenever the room changes.
  useEffect(() => {
    setDetached(false);
    setBlocked(false);
  }, [listening?.roomId]);

  if (!listening || !room || leading) return idle;
  return {
    blocked: here && blocked && !detached,
    detached: here && detached,
    elsewhere: room.fileId !== fileId ? room.fileId : null,
    leaderName: room.leader.name,
    resume: () => {
      setDetached(false);
      if (media) {
        own.current = Date.now();
        void media
          .play()
          .then(() => setBlocked(false))
          .catch(() => undefined);
      }
    },
  };
}

/** The strip above the player, only when there is something to do. */
export function ListeningNotice({ sync }: { sync: ListeningSync }) {
  const navigate = useNavigate();
  const elsewhere = useFileLabel(sync.elsewhere);
  if (!sync.leaderName) return null;
  const strip = (text: string, action: React.ReactNode) => (
    <output className="flex shrink-0 flex-wrap items-center gap-3 border-b border-line px-3 py-2 text-[13px] lg:px-4">
      <span aria-hidden="true" className="size-1.5 rounded-full bg-signal" />
      <span className="min-w-0 flex-1 text-ink-2">{text}</span>
      {action}
    </output>
  );
  if (sync.blocked)
    return strip(
      `${sync.leaderName} is playing. Your browser waits for a tap before it plays.`,
      <Button size="sm" variant="primary" onClick={sync.resume}>
        <Icon name="play" size={12} />
        Start listening
      </Button>,
    );
  if (sync.detached)
    return strip(
      `You stopped following ${sync.leaderName}.`,
      <Button size="sm" variant="secondary" onClick={sync.resume}>
        Follow again
      </Button>,
    );
  if (sync.elsewhere)
    return strip(
      `${sync.leaderName} is playing ${elsewhere ?? "another file"}.`,
      <Button
        size="sm"
        variant="secondary"
        onClick={() =>
          void navigate({ to: "/files/$fileId", params: { fileId: sync.elsewhere ?? "" } })
        }
      >
        Back to the room
      </Button>,
    );
  return null;
}

/**
 * Away from the room's file (or, leading, from any file), a pill keeps the room in reach; and
 * once a room has ended, it says so until put away.
 */
export function ListeningPill({ onFile }: { onFile: string | null }) {
  const listening = useListening();
  const navigate = useNavigate();
  if (!listening?.roomId) return null;
  const { room, leading, status } = listening;
  const pill = (text: string, actions: React.ReactNode) => (
    <div
      role="status"
      data-e2e-overlap
      className="rise-in fixed bottom-4 left-1/2 z-30 flex max-w-[calc(100%-32px)] -translate-x-1/2 items-center gap-2 rounded-panel-lg bg-overlay py-1.5 pr-1.5 pl-3.5 shadow-4"
    >
      <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-signal" />
      <span className="min-w-0 truncate text-[13px] text-ink">{text}</span>
      {actions}
    </div>
  );
  if (status === "ended")
    return pill(
      leading || !room ? "The listening room has ended" : `${room.leader.name} ended the room`,
      <Button size="sm" variant="ghost" onClick={listening.dismiss}>
        Dismiss
      </Button>,
    );
  if (!room) return null;
  if (leading) {
    if (onFile) return null;
    return pill(
      `Leading · ${room.listeners.length} listening`,
      <Button size="sm" variant="ghost" onClick={() => void listening.leave()}>
        End
      </Button>,
    );
  }
  // On a file page, the strip above the player says where the room is instead.
  if (onFile) return null;
  return pill(
    `Listening with ${room.leader.name}`,
    <>
      {room.fileId && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            void navigate({ to: "/files/$fileId", params: { fileId: room.fileId ?? "" } })
          }
        >
          Back to the room
        </Button>
      )}
      <Button size="sm" variant="ghost" onClick={() => void listening.leave()}>
        Leave
      </Button>
    </>,
  );
}

/** Where a room's link lands: who leads and what they play, and Join. */
export function ListeningRoomPage({ roomId }: { roomId: string }) {
  const listening = useListening();
  const navigate = useNavigate();
  const { data, error, isPending } = useQuery(listeningRoomQuery(roomId));
  const label = useFileLabel(data?.room.fileId ?? null);
  if (isPending) return <p className="p-8 text-ink-3">Loading</p>;
  const open = Boolean(data?.open) && !error;
  return (
    <div className="mx-auto flex max-w-md flex-col items-start gap-4 px-6 py-16">
      {open && data ? (
        <>
          <div className="flex items-center gap-3">
            <Avatar id={data.room.leader.id} name={data.room.leader.name} size={36} />
            <div className="flex flex-col">
              <h1 className="m-0 text-[16px] font-medium text-ink">
                {data.room.leader.name} is leading
              </h1>
              <span className="text-[13px] text-ink-3">
                {label ? `${label} · ` : ""}
                {data.room.listeners.length} listening
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
              listening?.join(roomId);
              if (data.room.fileId)
                void navigate({ to: "/files/$fileId", params: { fileId: data.room.fileId } });
            }}
          >
            Join
          </Button>
        </>
      ) : (
        <>
          <h1 className="m-0 text-[16px] font-medium">This listening room is not open</h1>
          <p className="m-0 text-ink-2">
            Its leader has ended it, or it is in a project you are not part of.
          </p>
          <Button variant="secondary" onClick={() => void navigate({ to: "/" })}>
            Go home
          </Button>
        </>
      )}
    </div>
  );
}

export type { Listening };
