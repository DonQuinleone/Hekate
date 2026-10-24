import { type createDb, type Database, inOrg, schema } from "@hekate/db";
import { type ListeningRoom, roomOpen, stillThere } from "@hekate/shared";
import { asc, eq, sql } from "drizzle-orm";

/**
 * Listening rooms (#200, decision 234): one member leads, and everyone in the room hears what
 * they play. A room's state lives in the database, which every replica shares; each page in a
 * room holds one server-sent event stream, on whichever replica it reached. When the leader
 * changes something, the replica that took the change wakes its own streams at once and
 * announces the room on a PostgreSQL channel, which every other replica hears and passes to
 * its streams (as decision 188 does for settings). Each stream then reads the room again,
 * within its workspace, and sends it if it changed. Streams also read again every few seconds,
 * for the replicas the announcement cannot reach.
 */

export const LISTENING_CHANNEL = "hekate_listening";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** This process's streams, by room: what wakes them. */
export interface ListeningHub {
  /** A room changed: wake its streams here. */
  heard(roomId: string): void;
  /** Anything may have changed (the channel reconnected): wake every stream here. */
  heardAll(): void;
  /** Be woken when a room changes; returns what stops it. */
  subscribe(roomId: string, wake: () => void): () => void;
  /** How many streams this process holds. */
  size(): number;
}

export function createListeningHub(): ListeningHub {
  const rooms = new Map<string, Set<() => void>>();
  const wakeAll = (set: Set<() => void> | undefined) => {
    for (const wake of set ?? []) wake();
  };
  return {
    heard: (roomId) => wakeAll(rooms.get(roomId)),
    heardAll: () => {
      for (const set of rooms.values()) wakeAll(set);
    },
    subscribe(roomId, wake) {
      const set = rooms.get(roomId) ?? new Set();
      set.add(wake);
      rooms.set(roomId, set);
      return () => {
        set.delete(wake);
        if (set.size === 0) rooms.delete(roomId);
      };
    },
    size: () => [...rooms.values()].reduce((n, set) => n + set.size, 0),
  };
}

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Tell every other replica a room changed, when the caller's transaction commits. */
export async function announceRoom(tx: Tx | Database, roomId: string): Promise<void> {
  await tx.execute(sql`select pg_notify(${LISTENING_CHANNEL}, ${roomId})`);
}

/**
 * Pass what other replicas announce to this process's streams; on every connection, the first
 * included, wake them all, as anything may have changed meanwhile. Returns what stops it.
 */
export async function listenForRooms(
  client: ReturnType<typeof createDb>["sql"],
  hub: ListeningHub,
): Promise<() => Promise<void>> {
  const { unlisten } = await client.listen(
    LISTENING_CHANNEL,
    (payload) => {
      if (UUID.test(payload)) hub.heard(payload);
    },
    () => hub.heardAll(),
  );
  return unlisten;
}

const { listeningRooms, listeningRoomPeople, users } = schema;

/** A room as everyone in it sees it, and whether it is still open; null outside the workspace. */
export async function readRoom(
  db: Pick<Database, "select">,
  organisationId: string,
  roomId: string,
  now = new Date(),
): Promise<{ room: ListeningRoom; open: boolean } | null> {
  const [row] = await db
    .select({
      id: listeningRooms.id,
      projectId: listeningRooms.projectId,
      leaderId: listeningRooms.leaderId,
      leaderName: users.name,
      fileId: listeningRooms.fileId,
      playing: listeningRooms.playing,
      position: listeningRooms.position,
      rate: listeningRooms.rate,
      stateAt: listeningRooms.stateAt,
      revision: listeningRooms.revision,
      endedAt: listeningRooms.endedAt,
    })
    .from(listeningRooms)
    .innerJoin(users, eq(users.id, listeningRooms.leaderId))
    .where(inOrg(listeningRooms, organisationId, eq(listeningRooms.id, roomId)));
  if (!row) return null;
  const people = await db
    .select({ id: users.id, name: users.name, seenAt: listeningRoomPeople.seenAt })
    .from(listeningRoomPeople)
    .innerJoin(users, eq(users.id, listeningRoomPeople.userId))
    .where(inOrg(listeningRoomPeople, organisationId, eq(listeningRoomPeople.roomId, roomId)))
    .orderBy(asc(listeningRoomPeople.createdAt));
  const leaderSeenAt = people.find((p) => p.id === row.leaderId)?.seenAt ?? null;
  return {
    open: roomOpen({ endedAt: row.endedAt, leaderSeenAt }, now),
    room: {
      id: row.id,
      projectId: row.projectId,
      leader: { id: row.leaderId, name: row.leaderName },
      fileId: row.fileId,
      playing: row.playing,
      position: row.position,
      rate: row.rate,
      at: row.stateAt.toISOString(),
      revision: row.revision,
      listeners: people
        .filter((p) => p.id !== row.leaderId && stillThere(p.seenAt, now))
        .map((p) => ({ id: p.id, name: p.name })),
    },
  };
}

/** Say someone is in a room now: joining it, or still there. */
export async function markPresent(
  db: Pick<Database, "insert">,
  organisationId: string,
  roomId: string,
  userId: string,
  now = new Date(),
): Promise<void> {
  await db
    .insert(listeningRoomPeople)
    .values({ organisationId, roomId, userId, seenAt: now })
    .onConflictDoUpdate({
      target: [listeningRoomPeople.roomId, listeningRoomPeople.userId],
      set: { seenAt: now },
    });
}
