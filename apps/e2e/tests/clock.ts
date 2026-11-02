import { statSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import postgres from "postgres";
import { createDb } from "../../../packages/db/src/client.ts";
import type {
  CalendarEvent,
  HealthChecks,
  StatusPage,
} from "../../../packages/shared/src/index.ts";
import { readStatusPage } from "../../server/src/status.ts";
import { FIXED_TIME, state } from "./fixtures.ts";

/** The greatest UUIDv7 a moment can make: every id made then or before sorts below it. */
const lastIdAt = (ms: number) => {
  const time = Math.floor(ms).toString(16).padStart(12, "0");
  return `${time.slice(0, 8)}-${time.slice(8)}-7fff-bfff-ffffffffffff`;
};

const databaseUrl = () => process.env.E2E_DATABASE_URL ?? process.env.DATABASE_URL ?? "";

/**
 * Every capture is taken at FIXED_TIME (#543), the moment the seed set its rows to: the browser's
 * clock stands still there. The server keeps the real time, and a few answers are worked out
 * against it (what is late on the calendar and the overview, the week's new versions, the
 * status page's 90 days), so those are worked out again here against the fixed clock, by the
 * same rules (the status page by the server's own function), in the page alone; and the logs
 * are read as they stood when the seed ended, without what the run itself has done since.
 */
export async function onTheFixedClock(page: Page) {
  await page.clock.setFixedTime(FIXED_TIME);
  const now = new Date(FIXED_TIME);
  const today = FIXED_TIME.slice(0, 10);

  // Late: due before the fixed day. The server's clock is later still, so what it calls late
  // and is not yet due on the fixed day is put back.
  const lateOnTheFixedClock = <T extends { overdue: boolean }>(item: T, date: string) => ({
    ...item,
    overdue: item.overdue && date < today,
  });
  await page.route(/\/api\/projects\/[^/]+\/calendar(\?.*)?$/, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    if (!response.ok()) return route.fulfill({ response });
    const body = (await response.json()) as { events: CalendarEvent[] };
    const events = body.events.map((e) => lateOnTheFixedClock(e, e.date));
    await route.fulfill({ response, json: { ...body, events } });
  });
  await page.route(/\/api\/projects\/[^/]+\/overview$/, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    if (!response.ok()) return route.fulfill({ response });
    const body = (await response.json()) as { overdue?: { dueAt: string | null }[] };
    const overdue = body.overdue?.filter((r) => r.dueAt && Date.parse(r.dueAt) < now.getTime());
    await route.fulfill({ response, json: { ...body, overdue } });
  });

  // The versions of the last seven days, counted to the fixed time.
  await page.route(/\/api\/home$/, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    if (!response.ok()) return route.fulfill({ response });
    const body = (await response.json()) as { projects: { id: string }[]; newVersions: number };
    const ids = body.projects.map((p) => p.id);
    if (ids.length === 0) return route.fulfill({ response, json: body });
    const sql = postgres(databaseUrl(), { max: 1 });
    try {
      const [week] = await sql<{ n: number }[]>`
        select count(*)::int as n from versions v join tracks t on t.id = v.track_id
        where t.project_id in ${sql(ids)} and v.organisation_id = t.organisation_id
          and v.created_at > ${now}::timestamptz - interval '7 days'
          and v.created_at <= ${now}::timestamptz`;
      await route.fulfill({ response, json: { ...body, newVersions: week?.n ?? 0 } });
    } finally {
      await sql.end();
    }
  });

  // The logs as they stood when the seed ended, which the fixed time stands for: what earlier
  // screens of this run did (a refused link, a file played) is later still. Their ids are
  // UUIDv7, so the access log's first page reads before the last id the seed's moment could
  // have made.
  await page.route(/\/api\/organisation\/audit(\?.*)?$/, (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== "GET" || url.searchParams.has("before"))
      return route.fallback();
    url.searchParams.set("before", lastIdAt(statSync(join(state, "seeded.json")).mtimeMs));
    return route.fallback({ url: url.toString() });
  });
  // The instance's logs page on from the row before by its time and id (#598), so the rows
  // written since are left out of their answer instead.
  await page.route(/\/api\/instance\/logs\/[a-z]+(\?.*)?$/, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch();
    if (!response.ok()) return route.fulfill({ response });
    const body = (await response.json()) as { rows: { id: string }[] };
    const last = lastIdAt(statSync(join(state, "seeded.json")).mtimeMs);
    await route.fulfill({
      response,
      json: { ...body, rows: body.rows.filter((r) => r.id <= last) },
    });
  });

  // The status page's days end on the fixed day, read by the server's own function.
  await page.route(/\/api\/status$/, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    if (!response.ok()) return route.fulfill({ response });
    const live = (await response.json()) as StatusPage;
    const listed = new Set(live.services.map((s) => s.name));
    const checks: HealthChecks = {
      database: listed.has("database") ? "ok" : "off",
      storage: listed.has("storage") ? "ok" : "off",
      worker: listed.has("worker") ? "ok" : "off",
      mail: listed.has("mail") ? "ok" : "off",
    };
    const { db, close } = createDb(databaseUrl(), { max: 1 });
    try {
      await route.fulfill({ response, json: await readStatusPage(db, checks, now) });
    } finally {
      await close();
    }
  });
}
