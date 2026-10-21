import { createDb, runMigrations, schema, uuidv7 } from "@hekate/db";
import { defaultInstanceSettings } from "@hekate/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createFlags } from "./flags.ts";
import { createInstanceSettings } from "./instance-settings.ts";
import { listenForSignals, type Signal, signal } from "./signals.ts";

const url = process.env.DATABASE_URL;

describe.runIf(url)("word between replicas (#188)", () => {
  // Two replicas: each its own connections, its own settings and flags in memory.
  const one = createDb(url ?? "");
  const two = createDb(url ?? "");
  // Time stands still, so nothing but a signal makes a replica read again.
  const frozen = new Date();
  const settingsOne = createInstanceSettings(one.db, () => frozen.getTime());
  const settingsTwo = createInstanceSettings(two.db, () => frozen.getTime());
  const flagsTwo = createFlags(two.db, () => frozen);
  const heard: Signal[] = [];
  let unlisten: () => Promise<void> = async () => {};
  // The operator who makes the changes.
  const by = uuidv7();

  beforeAll(async () => {
    await runMigrations(url ?? "");
    await one.db.delete(schema.instanceSettings);
    await one.db.delete(schema.instanceFlags);
    await one.db
      .insert(schema.users)
      .values({ id: by, name: "Alex Rivera", email: `${by}@example.test` });
    unlisten = await listenForSignals(two.sql, (what) => {
      heard.push(what);
      if (what === "flags") flagsTwo.forget();
      else settingsTwo.forget();
    });
  });
  afterAll(async () => {
    await unlisten();
    await one.db.delete(schema.instanceSettings);
    await one.db.delete(schema.instanceFlags);
    await one.db.delete(schema.users).where(eq(schema.users.id, by));
    await one.close();
    await two.close();
  });

  it("hears everything once on connecting, as anything may have changed meanwhile", () => {
    expect([...heard].sort()).toEqual(["flags", "settings"]);
  });

  it("tells every replica of a settings change when it commits, and never of one rolled back", async () => {
    expect((await settingsTwo.get()).maintenance.on).toBe(false);
    heard.length = 0;

    // Rolled back: nothing is announced, and the other replica keeps what it read.
    await expect(
      one.db.transaction(async (tx) => {
        await settingsOne.write(
          tx,
          { ...defaultInstanceSettings, maintenance: { on: true, message: "" } },
          by,
        );
        await signal(tx, "settings");
        throw new Error("rolled back");
      }),
    ).rejects.toThrow("rolled back");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(heard).toEqual([]);

    await one.db.transaction(async (tx) => {
      await settingsOne.write(
        tx,
        { ...defaultInstanceSettings, maintenance: { on: true, message: "" } },
        by,
      );
      await signal(tx, "settings");
    });
    await vi.waitFor(() => expect(heard).toEqual(["settings"]));
    // Its copy was fresh, yet it reads the change at once.
    expect((await settingsTwo.get()).maintenance.on).toBe(true);
  });

  it("tells every replica of a flag turned", async () => {
    expect(await flagsTwo.isOn("worker.verbose")).toBe(false);
    const flagsOne = createFlags(one.db, () => frozen);
    await one.db.transaction(async (tx) => {
      await flagsOne.set("worker.verbose", true, by, tx);
      await signal(tx, "flags");
    });
    await vi.waitFor(() => expect(heard).toContain("flags"));
    expect(await flagsTwo.isOn("worker.verbose")).toBe(true);
  });
});
