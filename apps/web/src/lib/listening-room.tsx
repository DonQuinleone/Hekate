import type { ListeningEvent, ListeningRoom, ListeningStateInput } from "@hekate/shared";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api } from "./api";
import { clockOffset, createSender } from "./listening";
import { json, meQuery } from "./queries";

/**
 * The listening room this tab is in (#200), across every page: one stream of the room's
 * events (server-sent, from the same origin, on the member's own session) while it is open,
 * and the leader's moves sent one at a time. The room is remembered for the tab, so a reload
 * goes back into it.
 */

const SEAT_KEY = "hekate.listening.room";

/** The open rooms of a project, to join; a few seconds stale at most. */
export const listeningRoomsQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["projects", projectId, "listening-rooms"],
    queryFn: async () =>
      (
        await json<{ rooms: ListeningRoom[] }>(
          await api.projects[":id"]["listening-rooms"].$get({ param: { id: projectId } }),
        )
      ).rooms,
    refetchInterval: 15_000,
  });

/** One room, as its link's page shows it before joining. */
export const listeningRoomQuery = (roomId: string) =>
  queryOptions({
    queryKey: ["listening-rooms", roomId],
    queryFn: async () =>
      json<{ room: ListeningRoom; open: boolean }>(
        await api["listening-rooms"][":id"].$get({ param: { id: roomId } }),
      ),
    retry: false,
  });

export type ListeningStatus = "connecting" | "live" | "ended";

export interface Listening {
  /** The room this tab is in, as last heard; null before the first event, or in none. */
  room: ListeningRoom | null;
  roomId: string | null;
  status: ListeningStatus | null;
  /** Whether this member leads it. */
  leading: boolean;
  /** The server's clock less this browser's, in ms. */
  offset: number;
  join(roomId: string): void;
  start(projectId: string, fileId: string): Promise<void>;
  /** The leader's move: where they are now. */
  move(state: ListeningStateInput): void;
  /** Leave (a listener) or end it for everyone (the leader). */
  leave(): Promise<void>;
  /** Put away the word that the room has ended. */
  dismiss(): void;
}

const Context = createContext<Listening | null>(null);

const remembered = (): string | null => {
  try {
    return sessionStorage.getItem(SEAT_KEY);
  } catch {
    return null;
  }
};
const remember = (roomId: string | null) => {
  try {
    if (roomId) sessionStorage.setItem(SEAT_KEY, roomId);
    else sessionStorage.removeItem(SEAT_KEY);
  } catch {
    // Not remembered: the room holds until the page reloads.
  }
};

export function ListeningProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const { data: me } = useQuery(meQuery);
  const [roomId, setRoomId] = useState<string | null>(remembered);
  const [room, setRoom] = useState<ListeningRoom | null>(null);
  const [status, setStatus] = useState<ListeningStatus | null>(roomId ? "connecting" : null);
  const [offset, setOffset] = useState(0);
  // Bumped to open the stream again after the server closed it.
  const [attempt, setAttempt] = useState(0);

  const seat = useCallback((id: string | null) => {
    remember(id);
    setRoomId(id);
    setRoom(null);
    setStatus(id ? "connecting" : null);
  }, []);

  useEffect(() => {
    if (!roomId) return;
    void attempt;
    const source = new EventSource(`/api/listening-rooms/${roomId}/events`);
    let retry: ReturnType<typeof setTimeout> | undefined;
    const ended = () => {
      source.close();
      remember(null);
      setStatus("ended");
    };
    source.addEventListener("room", (event) => {
      const data = JSON.parse((event as MessageEvent<string>).data) as ListeningEvent;
      setOffset(clockOffset(data.now, Date.now()));
      setRoom(data.room);
      setStatus("live");
    });
    source.addEventListener("ended", ended);
    source.onerror = () => {
      // A broken connection is tried again by the browser itself; one the server refused or
      // closed for good is asked about: gone, or only this replica stopping.
      if (source.readyState !== EventSource.CLOSED) return setStatus("connecting");
      void client
        .fetchQuery({ ...listeningRoomQuery(roomId), staleTime: 0 })
        .then((found) => {
          if (!found.open) return ended();
          retry = setTimeout(() => setAttempt((n) => n + 1), 2_000);
        })
        .catch(ended);
    };
    return () => {
      clearTimeout(retry);
      source.close();
    };
  }, [roomId, attempt, client]);

  const leading = Boolean(room && me && room.leader.id === me.user.id);
  const sender = useMemo(
    () =>
      createSender(async ({ id, state }: { id: string; state: ListeningStateInput }) => {
        await json(await api["listening-rooms"][":id"].state.$post({ param: { id }, json: state }));
      }),
    [],
  );
  const roomRef = useRef(roomId);
  roomRef.current = roomId;
  // The same function for the room's whole life, so a page's effects hold through its events.
  const move = useCallback(
    (state: ListeningStateInput) => {
      const id = roomRef.current;
      if (id) sender({ id, state });
    },
    [sender],
  );

  const value = useMemo<Listening>(
    () => ({
      room,
      roomId,
      status,
      leading,
      offset,
      join: (id) => seat(id),
      start: async (projectId, fileId) => {
        const { room: made } = await json<{ room: ListeningRoom }>(
          await api.projects[":id"]["listening-rooms"].$post({
            param: { id: projectId },
            json: { fileId },
          }),
        );
        seat(made.id);
        setRoom(made);
        void client.invalidateQueries({ queryKey: ["projects", projectId, "listening-rooms"] });
      },
      move,
      leave: async () => {
        const id = roomRef.current;
        if (!id) return;
        const wasLeading = leading;
        seat(null);
        const param = { param: { id } };
        await (wasLeading
          ? api["listening-rooms"][":id"].end.$post(param)
          : api["listening-rooms"][":id"].leave.$post(param)
        ).catch(() => undefined);
        if (room)
          void client.invalidateQueries({
            queryKey: ["projects", room.projectId, "listening-rooms"],
          });
      },
      dismiss: () => seat(null),
    }),
    [room, roomId, status, leading, offset, seat, move, client],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** The tab's listening room; outside the provider (a guest's pages), none. */
export function useListening(): Listening | null {
  return useContext(Context);
}
