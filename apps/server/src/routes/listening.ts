import { type Database, inOrg, schema } from "@hekate/db";
import {
  LISTENING_HEARTBEAT_MS,
  LISTENING_REREAD_MS,
  type ListeningEvent,
  type ListeningRoom,
  listeningStateInput,
  startListeningInput,
} from "@hekate/shared";
import { zValidator } from "@hono/zod-validator";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { actorOf, can, canOnFile, projectAccess } from "../access.ts";
import { NotFound } from "../errors.ts";
import { isStopping } from "../lifecycle.ts";
import { announceRoom, type ListeningHub, markPresent, readRoom } from "../listening.ts";
import type { TenantVariables } from "../tenancy.ts";

/**
 * Listening rooms (#200, decision 234). Members of a project start one on a file they can
 * play, and anyone who may see the project joins it. Only the leader moves it: which file,
 * playing or paused, where, how fast. What reaches a listener is only that; their page then
 * plays the file through their own playback request, so their own permissions and the
 * protected delivery path decide what they hear, and nothing of the leader's stream is shared.
 */

const { listeningRooms, listeningRoomPeople } = schema;

export interface ListeningDeps {
  db: Database;
  hub: ListeningHub;
}

const idParam = zValidator("param", z.object({ id: z.uuid() }));

/** The leader's file must be one they can see, in the room's project. */
async function assertPlayable(
  db: Database,
  actor: ReturnType<typeof actorOf>,
  fileId: string,
  projectId: string,
) {
  const access = await canOnFile(db, actor, "view", fileId);
  if (access.projectId !== projectId)
    throw new HTTPException(400, {
      message: "A listening room plays the files of its own project",
    });
}

/** A room the asker may be in: in their workspace, in a project they can see; 404 otherwise. */
async function roomFor(db: Database, vars: TenantVariables, roomId: string) {
  const found = await readRoom(db, vars.organisationId, roomId);
  if (!found || !(await projectAccess(db, actorOf(vars), found.room.projectId)))
    throw new NotFound("Listening room");
  return found;
}

const ended = () => new HTTPException(410, { message: "This listening room has ended" });

/** The open rooms of a project, newest first; and starting one. */
export function projectListeningRoutes({ db, hub }: ListeningDeps) {
  return new Hono<{ Variables: TenantVariables }>()
    .get("/:id/listening-rooms", idParam, async (c) => {
      const projectId = c.req.valid("param").id;
      await can(db, actorOf(c.var), "view", projectId);
      const rows = await db
        .select({ id: listeningRooms.id })
        .from(listeningRooms)
        .where(
          inOrg(
            listeningRooms,
            c.var.organisationId,
            eq(listeningRooms.projectId, projectId),
            isNull(listeningRooms.endedAt),
          ),
        )
        .orderBy(asc(listeningRooms.createdAt));
      const now = new Date();
      const rooms: ListeningRoom[] = [];
      for (const { id } of rows) {
        const found = await readRoom(db, c.var.organisationId, id, now);
        if (found?.open) rooms.unshift(found.room);
      }
      return c.json({ rooms });
    })
    .post("/:id/listening-rooms", idParam, zValidator("json", startListeningInput), async (c) => {
      const projectId = c.req.valid("param").id;
      const { fileId } = c.req.valid("json");
      const actor = actorOf(c.var);
      await can(db, actor, "view", projectId);
      await assertPlayable(db, actor, fileId, projectId);
      // One room at a time: starting another ends the one this member leads now.
      const { roomId, endedIds } = await db.transaction(async (tx) => {
        const endedRows = await tx
          .update(listeningRooms)
          .set({ endedAt: sql`now()` })
          .where(
            inOrg(
              listeningRooms,
              c.var.organisationId,
              eq(listeningRooms.leaderId, c.var.userId),
              isNull(listeningRooms.endedAt),
            ),
          )
          .returning({ id: listeningRooms.id });
        const [made] = await tx
          .insert(listeningRooms)
          .values({
            organisationId: c.var.organisationId,
            projectId,
            leaderId: c.var.userId,
            fileId,
          })
          .returning({ id: listeningRooms.id });
        if (!made) throw new Error("The listening room was not made");
        await markPresent(tx, c.var.organisationId, made.id, c.var.userId);
        for (const r of endedRows) await announceRoom(tx, r.id);
        return { roomId: made.id, endedIds: endedRows.map((r) => r.id) };
      });
      for (const id of endedIds) hub.heard(id);
      const found = await readRoom(db, c.var.organisationId, roomId);
      return c.json({ room: found?.room }, 201);
    });
}

/** One room: reading it, its stream, the leader's moves, ending it and leaving it. */
export function listeningRoutes({ db, hub }: ListeningDeps) {
  /** Only the leader moves or ends a room, and only while it is open. */
  const asLeader = async (vars: TenantVariables, roomId: string) => {
    const found = await roomFor(db, vars, roomId);
    if (found.room.leader.id !== vars.userId)
      throw new HTTPException(403, { message: "Only the room's leader can do that" });
    if (!found.open) throw ended();
    return found;
  };

  return new Hono<{ Variables: TenantVariables }>()
    .get("/:id", idParam, async (c) => {
      const found = await roomFor(db, c.var, c.req.valid("param").id);
      return c.json(found);
    })
    .post("/:id/state", idParam, zValidator("json", listeningStateInput), async (c) => {
      const roomId = c.req.valid("param").id;
      const input = c.req.valid("json");
      const found = await asLeader(c.var, roomId);
      await assertPlayable(db, actorOf(c.var), input.fileId, found.room.projectId);
      const revision = await db.transaction(async (tx) => {
        const [row] = await tx
          .update(listeningRooms)
          .set({
            fileId: input.fileId,
            playing: input.playing,
            position: input.position,
            rate: input.rate,
            stateAt: sql`now()`,
            revision: sql`${listeningRooms.revision} + 1`,
          })
          .where(
            inOrg(
              listeningRooms,
              c.var.organisationId,
              eq(listeningRooms.id, roomId),
              eq(listeningRooms.leaderId, c.var.userId),
              isNull(listeningRooms.endedAt),
            ),
          )
          .returning({ revision: listeningRooms.revision });
        if (!row) throw ended();
        // Moving the room is also being there.
        await markPresent(tx, c.var.organisationId, roomId, c.var.userId);
        await announceRoom(tx, roomId);
        return row.revision;
      });
      hub.heard(roomId);
      return c.json({ revision });
    })
    .post("/:id/end", idParam, async (c) => {
      const roomId = c.req.valid("param").id;
      const found = await roomFor(db, c.var, roomId);
      if (found.room.leader.id !== c.var.userId)
        throw new HTTPException(403, { message: "Only the room's leader can do that" });
      await db.transaction(async (tx) => {
        await tx
          .update(listeningRooms)
          .set({ endedAt: sql`now()` })
          .where(
            inOrg(
              listeningRooms,
              c.var.organisationId,
              eq(listeningRooms.id, roomId),
              isNull(listeningRooms.endedAt),
            ),
          );
        await announceRoom(tx, roomId);
      });
      hub.heard(roomId);
      return c.body(null, 204);
    })
    .post("/:id/leave", idParam, async (c) => {
      const roomId = c.req.valid("param").id;
      await roomFor(db, c.var, roomId);
      await db.transaction(async (tx) => {
        await tx
          .delete(listeningRoomPeople)
          .where(
            inOrg(
              listeningRoomPeople,
              c.var.organisationId,
              and(
                eq(listeningRoomPeople.roomId, roomId),
                eq(listeningRoomPeople.userId, c.var.userId),
              ),
            ),
          );
        await announceRoom(tx, roomId);
      });
      hub.heard(roomId);
      return c.body(null, 204);
    })
    .get("/:id/events", idParam, async (c) => {
      const roomId = c.req.valid("param").id;
      const vars = c.var;
      const first = await roomFor(db, vars, roomId);
      if (!first.open) throw ended();
      const response = streamSSE(c, async (stream) => {
        let wake: (() => void) | null = null;
        const wakeUp = () => {
          const resolve = wake;
          wake = null;
          resolve?.();
        };
        const unsubscribe = hub.subscribe(roomId, wakeUp);
        stream.onAbort(wakeUp);
        let sent = "";
        let beat = 0;
        try {
          // Reconnecting after a break waits only a moment.
          await stream.writeSSE({ event: "hello", data: "{}", retry: 2_000 });
          while (!stream.aborted && !stream.closed && !isStopping()) {
            const now = new Date();
            if (now.getTime() - beat >= LISTENING_HEARTBEAT_MS) {
              // Still allowed in, and still here: someone taken off the project is let go.
              const room = await readRoom(db, vars.organisationId, roomId, now);
              if (!room || !(await projectAccess(db, actorOf(vars), room.room.projectId))) break;
              await markPresent(db, vars.organisationId, roomId, vars.userId, now);
              if (beat > 0) await stream.write(": still here\n\n");
              else {
                // Arriving: everyone else in the room sees who joined at once.
                await announceRoom(db, roomId);
                hub.heard(roomId);
              }
              beat = now.getTime();
            }
            const found = await readRoom(db, vars.organisationId, roomId);
            if (!found?.open) {
              await stream.writeSSE({ event: "ended", data: "{}" });
              break;
            }
            const body = JSON.stringify(found.room);
            if (body !== sent) {
              sent = body;
              const event: ListeningEvent = { room: found.room, now: new Date().toISOString() };
              await stream.writeSSE({
                event: "room",
                id: String(found.room.revision),
                data: JSON.stringify(event),
              });
            }
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, LISTENING_REREAD_MS);
              wake = () => {
                clearTimeout(timer);
                resolve();
              };
            });
          }
        } catch (error) {
          // A stream that breaks ends; the page reconnects, and nothing of why reaches it.
          console.warn(`A listening room's stream ended early: ${String(error)}`);
        } finally {
          unsubscribe();
        }
      });
      // Nothing between here and the page may hold the events back to compress or buffer them.
      response.headers.set("Cache-Control", "no-cache, no-transform");
      response.headers.set("X-Accel-Buffering", "no");
      return response;
    });
}
