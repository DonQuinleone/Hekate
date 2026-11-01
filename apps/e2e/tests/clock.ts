import type { Page } from "@playwright/test";
import { createDb } from "../../../packages/db/src/client.ts";
import type {
  CalendarEvent,
  HealthChecks,
  StatusPage,
} from "../../../packages/shared/src/index.ts";
import { readStatusPage } from "../../server/src/status.ts";
import { FIXED_TIME } from "./fixtures.ts";

/**
 * Every capture is taken at FIXED_TIME (#543), the moment the seed set its rows to: the browser's
 * clock stands still there. The server keeps the real time, and a few answers are worked out
 * against it (what is late on the calendar, the status page's 90 days), so those are worked out
 * again here against the fixed clock, by the same functions, in the page alone.
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
    const { db, close } = createDb(process.env.E2E_DATABASE_URL ?? process.env.DATABASE_URL ?? "", {
      max: 1,
    });
    try {
      await route.fulfill({ response, json: await readStatusPage(db, checks, now) });
    } finally {
      await close();
    }
  });
}
