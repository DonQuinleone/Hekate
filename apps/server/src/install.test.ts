import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InstallState } from "@hekate/shared";
import { serve } from "@hono/node-server";
import { afterAll, describe, expect, it } from "vitest";
import { createInstallApp } from "./install-app.ts";
import { INSTALLED, PROGRESS, readSettingsFile } from "./settings-file.ts";
import {
  createSetupGate,
  SETUP_CODE_ATTEMPTS,
  SETUP_CODE_HEADER,
  SETUP_CODE_WINDOW_MS,
} from "./setup-code.ts";

const url = process.env.DATABASE_URL;
const code = "7KQ2-M9XD-4HPW";

describe("the setup code", () => {
  it("is twelve unambiguous characters, new at each start unless one is given", () => {
    expect(createSetupGate().code).toMatch(
      /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/,
    );
    expect(createSetupGate().code).not.toBe(createSetupGate().code);
    expect(createSetupGate({ code: "7kq2m9xd4hpw" }).code).toBe(code);
  });

  it("refuses everything for a while after too many wrong codes", () => {
    let now = 0;
    const gate = createSetupGate({ code, now: () => now });
    for (let i = 0; i < SETUP_CODE_ATTEMPTS; i++)
      expect(gate.check("AAAA-AAAA-AAAA")).toBe("wrong");
    expect(gate.check(code)).toBe("locked");
    now += SETUP_CODE_WINDOW_MS;
    expect(gate.check(code)).toBe("ok");
    expect(gate.check(undefined)).toBe("wrong");
  });
});

/** An installer in a fresh directory, as a server would run it with this environment. */
function installer(env: Record<string, string | undefined>) {
  const settingsFile = join(mkdtempSync(join(tmpdir(), "hekate-install-")), "config", "hekate.env");
  let finished = 0;
  const app = createInstallApp({
    env,
    settingsFile,
    gate: createSetupGate({ code }),
    nonce: "this-server",
    finish: async () => {
      finished++;
    },
    nodeVersion: "26.1.0",
    docsUrl: "https://docs.hekate.studio",
    log: false,
  });
  const call = (path: string, body?: unknown, withCode = true) =>
    app.request(`/api/install${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "content-type": "application/json",
        ...(withCode ? { [SETUP_CODE_HEADER]: code } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const state = async () => (await (await call("/state")).json()) as InstallState;
  return { app, call, state, settingsFile, finished: () => finished };
}

describe("the installer", () => {
  it("answers that it is installing, and nothing else, without the code", async () => {
    const { app, call } = installer({});
    expect(await (await call("", undefined, false)).json()).toEqual({ installing: true });
    expect((await call("/state", undefined, false)).status).toBe(403);
    expect((await call("/steps/requirements", {}, false)).status).toBe(403);
    expect((await call("/code", { code: "AAAA-AAAA-AAAA" }, false)).status).toBe(403);
    expect((await call("/code", { code: code.toLowerCase() }, false)).status).toBe(204);
    // The rest of the API waits for the install; the page and its health answer.
    expect((await app.request("/api/me")).status).toBe(409);
    expect(await (await app.request("/api/setup")).json()).toEqual({ needed: true });
    expect(await (await app.request("/api/health")).json()).toMatchObject({ status: "installing" });
  });

  it("stops at a requirement the server cannot run without", async () => {
    // A settings directory beneath a file can never be made.
    const parent = join(mkdtempSync(join(tmpdir(), "hekate-install-")), "file");
    writeFileSync(parent, "");
    const settingsFile = join(parent, "config", "hekate.env");
    const old = createInstallApp({
      env: {},
      settingsFile,
      gate: createSetupGate({ code }),
      nonce: "x",
      finish: async () => {},
      docsUrl: "https://docs.hekate.studio",
      log: false,
    });
    const res = await old.request("/api/install/steps/requirements", {
      method: "POST",
      headers: { [SETUP_CODE_HEADER]: code },
    });
    expect(res.status).toBe(422);
    expect(existsSync(settingsFile)).toBe(false);
  });

  it("refuses a database it cannot reach, and saves nothing", async () => {
    const { call, settingsFile } = installer({});
    await call("/steps/requirements", {});
    const res = await call("/steps/database", { url: "postgres://hekate:x@127.0.0.1:1/hekate" });
    expect(res.status).toBe(422);
    expect(readSettingsFile(settingsFile)?.DATABASE_URL).toBeUndefined();
  });

  it("saves the master key only when it is said to be stored", async () => {
    const { call, settingsFile } = installer({});
    const key = randomBytes(32).toString("base64");
    expect((await call("/steps/master-key", { key, stored: false })).status).toBe(400);
    expect((await call("/steps/master-key", { key: "short", stored: true })).status).toBe(400);
    expect((await call("/steps/master-key", { key, stored: true })).status).toBe(200);
    expect(readSettingsFile(settingsFile)?.MASTER_KEY).toBe(key);
  });

  it("never overwrites what the environment sets", async () => {
    const env = { MASTER_KEY: randomBytes(32).toString("base64"), PUBLIC_URL: "http://env.test" };
    const { call, state, settingsFile } = installer(env);
    expect((await state()).fixed).toEqual(["masterKey", "address"]);
    expect((await call("/steps/master-key", { stored: true })).status).toBe(200);
    expect(readSettingsFile(settingsFile)?.MASTER_KEY).toBeUndefined();
  });

  describe.runIf(url)("from a clean start to a finished install", () => {
    const listening = new Set<{ close: () => void }>();
    afterAll(() => {
      for (const server of listening) server.close();
    });

    it("tests each step, saves it, resumes where it was left, and finishes", async () => {
      const { app, call, state, settingsFile, finished } = installer({ DATABASE_URL: url });
      expect((await state()).step).toBe("requirements");
      expect((await call("/finish", {})).status).toBe(422);

      expect((await call("/checks/requirements")).status).toBe(200);
      expect((await call("/steps/requirements", {})).status).toBe(200);
      const file = readSettingsFile(settingsFile);
      expect(file?.AUTH_SECRET?.length).toBeGreaterThanOrEqual(32);

      // The environment gives the database: it is tested and migrated, never written.
      const database = await call("/steps/database", {});
      expect(database.status).toBe(200);
      expect(readSettingsFile(settingsFile)?.DATABASE_URL).toBeUndefined();

      const storagePath = join(mkdtempSync(join(tmpdir(), "hekate-install-storage-")), "objects");
      expect((await call("/steps/storage", { kind: "local", path: storagePath })).status).toBe(200);
      expect(readSettingsFile(settingsFile)).toMatchObject({
        STORAGE_BACKENDS: "local",
        STORAGE_LOCAL_PATH: storagePath,
      });

      expect(
        (
          await call("/steps/master-key", {
            key: randomBytes(32).toString("base64"),
            stored: true,
          })
        ).status,
      ).toBe(200);

      // Left here: a new page picks up at the next step.
      expect((await state()).step).toBe("mail");

      // Mail settings are saved only once a test message has gone out with them.
      const mail = { provider: "log", from: "Hekate <hekate@endlesshall.example>" };
      expect((await call("/steps/mail", mail)).status).toBe(422);
      const test = await call("/checks/mail", { mail, to: "mira@endlesshall.example" });
      expect(test.status).toBe(200);
      expect(
        (await call("/steps/mail", { ...mail, from: "Other <other@endlesshall.example>" })).status,
      ).toBe(422);
      expect((await call("/steps/mail", mail)).status).toBe(200);
      expect(readSettingsFile(settingsFile)?.SMTP_URL).toBeUndefined();

      // The address is asked for a nonce only this server knows.
      const server = serve({ fetch: app.fetch, port: 0 });
      listening.add(server);
      await new Promise((resolve) => server.once("listening", resolve));
      const port = (server.address() as AddressInfo).port;
      const address = await call("/steps/address", { publicUrl: `http://localhost:${port}/` });
      expect(address.status).toBe(200);
      const { checks } = (await address.json()) as { checks: { name: string; state: string }[] };
      expect(checks).toContainEqual(
        expect.objectContaining({ name: "The address answers", state: "ok" }),
      );
      expect(readSettingsFile(settingsFile)?.PUBLIC_URL).toBe(`http://localhost:${port}`);

      expect((await state()).step).toBe("ready");
      // Two finishes at once start the server once.
      const both = await Promise.all([call("/finish", {}), call("/finish", {})]);
      expect(both.map((r) => r.status)).toEqual([200, 200]);
      expect(finished()).toBe(1);
      expect(readSettingsFile(settingsFile)).toMatchObject({
        [INSTALLED]: "true",
        [PROGRESS]: "requirements,database,storage,masterKey,mail,address",
      });
    });

    it("tells another server answering at the address from this one", async () => {
      const { call, state } = installer({ DATABASE_URL: url });
      const other = createInstallApp({
        env: {},
        settingsFile: join(mkdtempSync(join(tmpdir(), "hekate-install-")), "hekate.env"),
        gate: createSetupGate({ code }),
        nonce: "another-server",
        finish: async () => {},
        docsUrl: "https://docs.hekate.studio",
        log: false,
      });
      const server = serve({ fetch: other.fetch, port: 0 });
      listening.add(server);
      await new Promise((resolve) => server.once("listening", resolve));
      const port = (server.address() as AddressInfo).port;
      const res = await call("/checks/address", { publicUrl: `http://localhost:${port}` });
      const { checks } = (await res.json()) as { checks: { state: string; detail: string }[] };
      expect(checks).toContainEqual(
        expect.objectContaining({ state: "fail", detail: "another server answers there" }),
      );
      // Such an address is not saved.
      const saved = await call("/steps/address", { publicUrl: `http://localhost:${port}` });
      expect(saved.status).toBe(422);
      expect((await state()).address.publicUrl).toBeNull();
    });

    it("reaches a database the environment gives from a file", async () => {
      const secret = join(mkdtempSync(join(tmpdir(), "hekate-install-secret-")), "database-url");
      writeFileSync(secret, `${url}\n`);
      const { call } = installer({ DATABASE_URL_FILE: secret });
      await call("/steps/requirements", {});
      expect((await call("/steps/database", {})).status).toBe(200);
    });
  });
});
