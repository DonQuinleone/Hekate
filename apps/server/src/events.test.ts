import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { createDb, runMigrations, schema, uuidv7 } from "@hekate/db";
import type { ChannelKind, EventKind, WebhookBody } from "@hekate/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Answer, createSend, type Send, verifySignature } from "./channels.ts";
import {
  type DeliveryDeps,
  deliver,
  dispatchEvents,
  emitEvent,
  replayDelivery,
  resumeChannel,
  sealConfig,
  sealContext,
} from "./events.ts";
import { createKeyring } from "./keyring.ts";
import { purgeLogs } from "./log-retention.ts";
import { webhookLog } from "./logs.ts";
import { tellProcessingFailed } from "./notifications.ts";

const url = process.env.DATABASE_URL;

describe.runIf(url)("events and deliveries (#161)", () => {
  const { db, close } = createDb(url ?? "", { max: 4 });
  const keyring = createKeyring(db, { current: Buffer.alloc(32, 9), previous: [] });
  const queued: { name: string; data: unknown; options: unknown }[] = [];
  const jobs = {
    send: async (name: string, data: unknown, options?: unknown) => {
      queued.push({ name, data, options });
      return "job";
    },
  };
  const received: { headers: IncomingHttpHeaders; body: string }[] = [];
  const receiver = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(204).end();
    });
  });
  let origin = "";

  beforeAll(async () => {
    await runMigrations(url ?? "");
    await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    receiver.close();
    await close();
  });

  /** A workspace with a project and a file in it. */
  const workspace = async () => {
    const [org] = await db
      .insert(schema.organisations)
      .values({ name: "Endless Hall Records", slug: `events-${uuidv7()}` })
      .returning();
    const organisationId = org?.id ?? "";
    const [project] = await db
      .insert(schema.projects)
      .values({ organisationId, name: "Joplin Rags", profile: "music" })
      .returning();
    const [blob] = await db
      .insert(schema.blobs)
      .values({
        organisationId,
        backend: "local",
        key: `org/${organisationId}/${uuidv7()}`,
        byteSize: 5,
        sha256: "0".repeat(64),
        wrappedKey: "x",
        keyVersion: 1,
      })
      .returning();
    const [file] = await db
      .insert(schema.files)
      .values({
        organisationId,
        projectId: project?.id ?? "",
        name: "Bethena.wav",
        kind: "audio",
        contentType: "audio/wav",
        byteSize: 5,
        blobId: blob?.id ?? "",
      })
      .returning();
    return { organisationId, projectId: project?.id ?? "", fileId: file?.id ?? "" };
  };

  const channel = async (
    organisationId: string,
    kind: ChannelKind,
    events: EventKind[],
    config: { url: string; secret?: string },
  ) => {
    const id = uuidv7();
    const { version, key } = await keyring.current(organisationId);
    const [row] = await db
      .insert(schema.channels)
      .values({
        id,
        organisationId,
        kind,
        name: `#${kind}`,
        target: config.url,
        events,
        configSealed: sealConfig(key, config, sealContext(organisationId, id)),
        keyVersion: version,
      })
      .returning();
    if (!row) throw new Error("No channel");
    return row;
  };

  const deliveriesOf = (channelId: string) =>
    db.select().from(schema.eventDeliveries).where(eq(schema.eventDeliveries.channelId, channelId));

  const deps = (send: Send): DeliveryDeps => ({
    db,
    keyring,
    jobs,
    send,
    publicUrl: "https://review.endlesshall.example",
  });

  it("writes nothing while no channel carries the kind", async () => {
    const { organisationId, fileId, projectId } = await workspace();
    const input = {
      organisationId,
      kind: "processing.failed" as const,
      actor: null,
      projectId,
      fileId,
      path: `/files/${fileId}`,
    };
    expect(await emitEvent(db, input)).toBeNull();
    await channel(organisationId, "slack", ["version.arrived"], {
      url: "https://hooks.slack.com/x",
    });
    expect(await emitEvent(db, input)).toBeNull();
    const written = await db
      .select()
      .from(schema.events)
      .where(eq(schema.events.organisationId, organisationId));
    expect(written).toEqual([]);
  });

  it("delivers each event once to each channel, signed, and a receiver can tell", async () => {
    const { organisationId, fileId, projectId } = await workspace();
    const secret = "whsec_receiver-test";
    const hook = await channel(organisationId, "webhook", ["processing.failed"], {
      url: `${origin}/hook?token=abc`,
      secret,
    });
    // The place it happens: a file that could not be processed, told once however often.
    await tellProcessingFailed(db, organisationId, fileId);
    await tellProcessingFailed(db, organisationId, fileId);
    const [event, ...more] = await db
      .select()
      .from(schema.events)
      .where(eq(schema.events.organisationId, organisationId));
    expect(more).toEqual([]);
    expect(event?.data).toMatchObject({
      project: { id: projectId, name: "Joplin Rags" },
      file: { id: fileId, name: "Bethena.wav" },
      actor: null,
    });

    // Dispatching twice makes one delivery.
    queued.length = 0;
    await dispatchEvents(db, jobs);
    await dispatchEvents(db, jobs);
    const [delivery, ...others] = await deliveriesOf(hook.id);
    expect(others).toEqual([]);
    expect(queued.filter((q) => q.name === "event-delivery")).toHaveLength(1);

    const send = deps(createSend([origin]));
    received.length = 0;
    // Due the moment it is made: the database's clock is finer than ours, so a delivery sent in
    // the same millisecond as it was made must still be due.
    expect(await deliver(send, organisationId, delivery?.id ?? "", delivery?.nextAttemptAt)).toBe(
      "delivered",
    );
    // Delivered is delivered: the job running again sends nothing.
    expect(await deliver(send, organisationId, delivery?.id ?? "")).toBe("not_due");
    expect(received).toHaveLength(1);
    const got = received[0];
    const signature = String(got?.headers["hekate-signature"]);
    expect(verifySignature(secret, got?.body ?? "", signature)).toBe(true);
    expect(verifySignature(secret, `${got?.body} `, signature)).toBe(false);
    const body = JSON.parse(got?.body ?? "{}") as WebhookBody;
    expect(body).toMatchObject({
      id: event?.id,
      type: "processing.failed",
      workspace: { id: organisationId, name: "Endless Hall Records" },
      summary: "Bethena.wav could not be processed in Joplin Rags",
      url: `https://review.endlesshall.example/files/${fileId}`,
    });
    expect(got?.headers["hekate-delivery"]).toBe(delivery?.id);

    // A replay is a delivery of its own, of the same event.
    const replay = await replayDelivery(db, jobs, organisationId, delivery?.id ?? "", null);
    expect(await deliver(send, organisationId, replay?.id ?? "", replay?.nextAttemptAt)).toBe(
      "delivered",
    );
    const again = JSON.parse(received[1]?.body ?? "{}") as WebhookBody;
    expect(again.id).toBe(event?.id);
    expect(received[1]?.headers["hekate-delivery"]).toBe(replay?.id);

    // The webhook log has both, newest first.
    const log = await webhookLog(db, { range: "1h", workspace: organisationId, limit: 10 });
    expect(log.rows.map((r) => [r.status, r.replay, r.result])).toEqual([
      ["delivered", true, "204"],
      ["delivered", false, "204"],
    ]);
  });

  it("refuses to send to a private address the operator has not allowed", async () => {
    const { organisationId, fileId, projectId } = await workspace();
    const hook = await channel(organisationId, "webhook", ["file.downloaded"], {
      url: `${origin}/hook`,
      secret: "whsec_x",
    });
    await emitEvent(db, {
      organisationId,
      kind: "file.downloaded",
      actor: null,
      projectId,
      fileId,
      path: `/files/${fileId}`,
      details: { download: "original" },
    });
    await dispatchEvents(db, jobs);
    const [delivery] = await deliveriesOf(hook.id);
    received.length = 0;
    expect(await deliver(deps(createSend([])), organisationId, delivery?.id ?? "")).toBe(
      "retrying",
    );
    expect(received).toEqual([]);
    const [after] = await deliveriesOf(hook.id);
    expect(after?.lastResult).toMatch(/private network/);
  });

  it("tries again later, pauses a channel that keeps failing, and gives up in the end", async () => {
    const { organisationId, fileId, projectId } = await workspace();
    const slack = await channel(organisationId, "slack", ["file.downloaded"], {
      url: "https://hooks.slack.com/services/x",
    });
    await emitEvent(db, {
      organisationId,
      kind: "file.downloaded",
      actor: null,
      projectId,
      fileId,
      path: `/files/${fileId}`,
      details: { download: "proxy" },
    });
    await dispatchEvents(db, jobs);
    const [delivery] = await deliveriesOf(slack.id);
    const id = delivery?.id ?? "";
    let answer: Answer = { status: 500, retryAfter: null };
    let sends = 0;
    const failing = deps(async () => {
      sends += 1;
      return answer;
    });
    let now = new Date();
    expect(await deliver(failing, organisationId, id, now)).toBe("retrying");
    // Not again until it is due: 30 seconds after the first failure.
    expect(await deliver(failing, organisationId, id, now)).toBe("not_due");
    const [first] = await deliveriesOf(slack.id);
    expect(first?.nextAttemptAt.getTime()).toBe(now.getTime() + 30_000);
    // The receiver's Retry-After is kept to, where it asks for longer.
    answer = { status: 429, retryAfter: 600 };
    now = new Date(now.getTime() + 31_000);
    expect(await deliver(failing, organisationId, id, now)).toBe("retrying");
    const [second] = await deliveriesOf(slack.id);
    expect(second?.nextAttemptAt.getTime()).toBe(now.getTime() + 600_000);
    expect(second?.lastResult).toBe("429");
    answer = { status: 500, retryAfter: null };
    for (let i = 0; i < 3; i++) {
      now = new Date((second?.nextAttemptAt.getTime() ?? 0) + (i + 1) * 3_600_000);
      expect(await deliver(failing, organisationId, id, now)).toBe("retrying");
    }
    // Five failures in a row: the channel pauses, and what waits on it waits with it.
    const [paused] = await db
      .select()
      .from(schema.channels)
      .where(eq(schema.channels.id, slack.id));
    expect(paused?.failures).toBe(5);
    expect(paused?.pausedUntil?.getTime()).toBe(now.getTime() + 5 * 60_000);
    const before = sends;
    now = new Date(now.getTime() + 4 * 3_600_000);
    // Paused by a later failure in the meantime, as another delivery could have.
    await db
      .update(schema.channels)
      .set({ pausedUntil: new Date(now.getTime() + 60_000) })
      .where(eq(schema.channels.id, slack.id));
    expect(await deliver(failing, organisationId, id, now)).toBe("paused");
    expect(sends).toBe(before);
    // Resumed by hand: due at once, and the sixth failure is the last.
    await resumeChannel(db, jobs, organisationId, slack.id, now);
    expect(await deliver(failing, organisationId, id, now)).toBe("failed");
    const [failed] = await deliveriesOf(slack.id);
    expect(failed).toMatchObject({ status: "failed", attempts: 6 });
    expect(await deliver(failing, organisationId, id, new Date(now.getTime() + 1e9))).toBe(
      "not_due",
    );
  });

  it("gives up at once on an address that is gone, and skips a kind no longer carried", async () => {
    const { organisationId, fileId, projectId } = await workspace();
    const discord = await channel(organisationId, "discord", ["file.downloaded"], {
      url: "https://discord.com/api/webhooks/1/x",
    });
    const emit = () =>
      emitEvent(db, {
        organisationId,
        kind: "file.downloaded",
        actor: null,
        projectId,
        fileId,
        path: `/files/${fileId}`,
        details: { download: "proxy" },
      });
    await emit();
    await emit();
    await dispatchEvents(db, jobs);
    const [one, two] = await deliveriesOf(discord.id);
    const gone = deps(async () => ({ status: 410, retryAfter: null }));
    expect(await deliver(gone, organisationId, one?.id ?? "")).toBe("failed");
    await db.update(schema.channels).set({ events: [] }).where(eq(schema.channels.id, discord.id));
    expect(await deliver(gone, organisationId, two?.id ?? "")).toBe("skipped");
  });

  it("gives up on a channel whose address no key opens, rather than failing the job", async () => {
    const { organisationId, fileId, projectId } = await workspace();
    const [broken] = await db
      .insert(schema.channels)
      .values({
        organisationId,
        kind: "slack",
        name: "#broken",
        target: "hooks.slack.com",
        configSealed: "not sealed",
        keyVersion: 1,
        events: ["processing.failed"],
      })
      .returning();
    await emitEvent(db, {
      organisationId,
      kind: "processing.failed",
      actor: null,
      projectId,
      fileId,
      path: `/files/${fileId}`,
    });
    await dispatchEvents(db, jobs);
    const [delivery] = await deliveriesOf(broken?.id ?? "");
    let sends = 0;
    const counting = deps(async () => {
      sends += 1;
      return { status: 200, retryAfter: null };
    });
    expect(await deliver(counting, organisationId, delivery?.id ?? "")).toBe("failed");
    expect(sends).toBe(0);
    const [after] = await deliveriesOf(broken?.id ?? "");
    expect(after?.lastResult).toMatch(/could not be opened/);
  });

  it("sends a delivery once, however many workers take its job at the same time", async () => {
    const { organisationId, fileId, projectId } = await workspace();
    const teams = await channel(organisationId, "teams", ["processing.failed"], {
      url: "https://example.logic.azure.com/workflows/x",
    });
    await emitEvent(db, {
      organisationId,
      kind: "processing.failed",
      actor: null,
      projectId,
      fileId,
      path: `/files/${fileId}`,
    });
    await dispatchEvents(db, jobs);
    const [delivery] = await deliveriesOf(teams.id);
    let sends = 0;
    const slow = deps(async () => {
      sends += 1;
      await new Promise((r) => setTimeout(r, 50));
      return { status: 202, retryAfter: null };
    });
    const results = await Promise.all(
      [1, 2, 3].map(() => deliver(slow, organisationId, delivery?.id ?? "")),
    );
    expect(sends).toBe(1);
    expect(results.sort()).toEqual(["delivered", "not_due", "not_due"]);
  });

  it("keeps events and their deliveries as long as the webhook log is kept", async () => {
    const { organisationId, fileId, projectId } = await workspace();
    const slack = await channel(organisationId, "slack", ["processing.failed"], {
      url: "https://hooks.slack.com/x",
    });
    await emitEvent(db, {
      organisationId,
      kind: "processing.failed",
      actor: null,
      projectId,
      fileId,
      path: `/files/${fileId}`,
    });
    await dispatchEvents(db, jobs);
    const keep = { audit: null, auth: null, mail: null, webhooks: 30 as const, api: null };
    expect((await purgeLogs(db, keep)).webhooks).toBe(0);
    const later = new Date(Date.now() + 31 * 24 * 60 * 60_000);
    expect((await purgeLogs(db, keep, later)).webhooks).toBeGreaterThanOrEqual(1);
    expect(await deliveriesOf(slack.id)).toEqual([]);
  });

  it("keeps one workspace's deliveries from another", async () => {
    const a = await workspace();
    const b = await workspace();
    const hook = await channel(a.organisationId, "slack", ["processing.failed"], {
      url: "https://hooks.slack.com/x",
    });
    await emitEvent(db, {
      organisationId: a.organisationId,
      kind: "processing.failed",
      actor: null,
      projectId: a.projectId,
      fileId: a.fileId,
      path: `/files/${a.fileId}`,
    });
    await dispatchEvents(db, jobs);
    const [delivery] = await deliveriesOf(hook.id);
    const ok = deps(async () => ({ status: 200, retryAfter: null }));
    // Named under the wrong workspace, it is not found, sent or replayed.
    expect(await deliver(ok, b.organisationId, delivery?.id ?? "")).toBe("not_due");
    expect(await replayDelivery(db, jobs, b.organisationId, delivery?.id ?? "", null)).toBeNull();
    expect(await deliver(ok, a.organisationId, delivery?.id ?? "")).toBe("delivered");
  });
});
