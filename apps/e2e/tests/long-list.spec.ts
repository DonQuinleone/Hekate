import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { seeded } from "./fixtures.ts";

/**
 * A folder of thousands of files draws only the rows near the view, and the keys still reach
 * every row. The files are added for this test alone and taken away after it, so the captures
 * that follow see the project as seeded.
 */
test.describe("a long file list", () => {
  const sql = postgres(process.env.E2E_DATABASE_URL ?? process.env.DATABASE_URL ?? "", { max: 1 });
  const prefix = "Opening titles - Shot ";

  test.beforeAll(async () => {
    const { videoProjectId, cutFileId } = seeded();
    await sql`insert into files (id, organisation_id, project_id, name, kind, blob_id, content_type, byte_size, stream_status, analysis_status)
      select gen_random_uuid(), f.organisation_id, ${videoProjectId}, ${prefix} || lpad(g::text, 4, '0') || '.mov',
        'other', f.blob_id, 'application/octet-stream', f.byte_size, 'none', 'none'
      from (select * from files where id = ${cutFileId}) f, generate_series(1, 2000) g`;
  });
  test.afterAll(async () => {
    await sql`delete from files where project_id = ${seeded().videoProjectId} and name like ${`${prefix}%`}`;
    await sql.end();
  });

  test("draws only what is near the view, and the arrows reach every row", async ({
    page,
  }, info) => {
    test.skip(info.project.name === "phone", "Once is enough");
    await page.goto(`/projects/${seeded().videoProjectId}/files`);
    const rows = page.locator("main ul[aria-label=Contents] > li");
    await expect(rows.first()).toBeVisible();
    expect(await rows.count()).toBeLessThan(80);

    // The first row is the deliverable, as a folder is (#16), then the cut itself; the shots
    // follow in name order.
    // The shots are in the list before the keys are tried: the first row alone may arrive first.
    await expect(page.getByText(`${prefix}0001.mov`)).toBeVisible();
    await page.locator("main ul[aria-label=Contents] [data-name]").first().focus();
    for (let i = 0; i < 151; i++) await page.keyboard.press("ArrowDown");
    await expect(page.locator(":focus")).toContainText(`${prefix}0150.mov`);
    expect(await rows.count()).toBeLessThan(80);
  });
});
