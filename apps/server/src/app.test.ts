import { createDb, runMigrations, schema } from "@hekate/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { createClient } from "./client.ts";
import { loadConfig } from "./config.ts";

const url = process.env.DATABASE_URL;

describe("config", () => {
  it("reports every invalid setting", () => {
    expect(() => loadConfig({ PORT: "nope" })).toThrow(/PORT[\s\S]*DATABASE_URL/);
  });
});

describe.runIf(url)("api", () => {
  const { db, close } = createDb(url ?? "", { max: 2 });
  const orgs: string[] = [];
  let current = "";
  const app = createApp({ db, organisationId: async () => current, log: false });
  const client = createClient("http://test/api", {
    fetch: (input: string | URL | Request, init?: RequestInit) => app.request(input, init),
  });

  beforeAll(async () => {
    await runMigrations(url ?? "");
    for (const slug of ["test-a", "test-b"]) {
      await db.delete(schema.organisations).where(eq(schema.organisations.slug, slug));
      const [org] = await db.insert(schema.organisations).values({ name: slug, slug }).returning();
      if (org) orgs.push(org.id);
    }
  });
  afterAll(async () => {
    for (const id of orgs)
      await db.delete(schema.organisations).where(eq(schema.organisations.id, id));
    await close();
  });

  it("reports health", async () => {
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok", database: "ok" });
  });

  it("creates projects inside the current organisation only", async () => {
    current = orgs[0] ?? "";
    const created = await app.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Symphony No. 5", profile: "music" }),
    });
    expect(created.status).toBe(201);
    const { project } = (await created.json()) as { project: { id: string } };

    current = orgs[1] ?? "";
    const other = await app.request(`/api/projects/${project.id}`);
    expect(other.status).toBe(404);
    expect(await other.json()).toEqual({
      error: { code: "not_found", message: "Project not found" },
    });

    current = orgs[0] ?? "";
    const list = await app.request("/api/projects");
    expect(((await list.json()) as { projects: unknown[] }).projects).toHaveLength(1);
  });

  it("rejects invalid input with a 400", async () => {
    const res = await app.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "", profile: "podcast" }),
    });
    expect(res.status).toBe(400);
  });

  it("works through the typed client", async () => {
    current = orgs[0] ?? "";
    const res = await client.projects.$get();
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body.projects[0]?.profile).toBe("music");
  });
});
