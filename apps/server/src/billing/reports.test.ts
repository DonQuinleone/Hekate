import { createDb, runMigrations, schema, uuidv7 } from "@hekate/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { billingReports, invoicesCsv, recognitionCsv } from "./reports.ts";

const url = process.env.DATABASE_URL;

/** Every line a CSV generator yields, joined. */
const read = async (lines: AsyncGenerator<string>) => {
  let all = "";
  for await (const line of lines) all += line;
  return all;
};

describe.runIf(url)("billing reports (#180)", () => {
  const { db, close } = createDb(url ?? "", { max: 2 });
  beforeAll(async () => {
    await runMigrations(url ?? "");
  });
  afterAll(async () => {
    await close();
  });

  // In francs, which no other test bills in, so the instance's other workspaces stay out.
  const now = new Date("2026-10-23T12:00:00Z");
  const plan = async (name: string, values: Partial<typeof schema.plans.$inferInsert> = {}) => {
    const [made] = await db
      .insert(schema.plans)
      .values({
        key: `${name.toLowerCase()}-${uuidv7().slice(-8)}`,
        name,
        currency: "CHF",
        features: [],
        severities: [],
        ...values,
      })
      .returning();
    return made?.id ?? "";
  };
  const workspace = async (name: string, planId: string, status: string, updatedAt = now) => {
    const [org] = await db
      .insert(schema.organisations)
      .values({ name, slug: `reports-${uuidv7()}` })
      .returning();
    const id = org?.id ?? "";
    await db.insert(schema.workspacePlans).values({
      organisationId: id,
      planId,
      status: status as "active",
      updatedAt,
    });
    return id;
  };
  const paid = (organisationId: string, amount: number, extra: object = {}) =>
    db.insert(schema.invoices).values({
      organisationId,
      source: "manual",
      number: `HK-R${uuidv7().slice(-4)}`,
      status: "paid",
      currency: "CHF",
      amountDue: amount,
      amountPaid: amount,
      issuedAt: new Date("2026-10-01T00:00:00Z"),
      paidAt: new Date("2026-10-02T00:00:00Z"),
      ...extra,
    });

  it("adds up the month's worth, the year's, churn, the average and where it comes from", async () => {
    const pro = await plan("Pro", { priceAmount: 4900, interval: "month" });
    const yearly = await plan("Yearly", { priceAmount: 49_000, interval: "year" });
    const agreed = await plan("Agreed");
    const euro = await plan("Euro", { priceAmount: 5000, interval: "month", currency: "EUR" });
    const a = await workspace("Endless Hall Records", pro, "active");
    await workspace("Mill Lane", yearly, "past_due");
    const c = await workspace("Bristol Choir", agreed, "active");
    await workspace("Opening titles", pro, "cancelled", new Date("2026-10-13T00:00:00Z"));
    await workspace("Lantern Pictures", euro, "active");
    await workspace("Long gone", pro, "cancelled", new Date("2026-05-01T00:00:00Z"));
    await paid(a, 4900, {
      periodStart: new Date("2026-10-01T00:00:00Z"),
      periodEnd: new Date("2026-11-01T00:00:00Z"),
    });
    await paid(c, 120_000, { description: "Agreed, the year" });
    await paid(a, 4900, {
      issuedAt: new Date("2026-08-01T00:00:00Z"),
      paidAt: new Date("2026-08-03T00:00:00Z"),
    });

    const r = await billingReports(db, "CHF", now);
    expect(r).toMatchObject({
      currency: "CHF",
      mrr: 4900 + 4083 + 10_000,
      arr: (4900 + 4083 + 10_000) * 12,
      paying: 3,
      average: Math.round((4900 + 4083 + 10_000) / 3),
      churn: { lost: 1, rate: 1 / 4 },
    });
    expect(r.otherCurrencies).toContain("EUR");
    expect(r.otherCurrencies).not.toContain("CHF");
    expect(r.byPlan.map((p) => [p.name, p.workspaces, p.amount])).toEqual(
      expect.arrayContaining([
        ["Agreed", 1, 10_000],
        ["Pro", 1, 4900],
        ["Yearly", 1, 4083],
      ]),
    );
    expect(r.byPlan[0]?.name).toBe("Agreed");
    expect(r.months).toHaveLength(12);
    expect(r.months.at(-1)).toEqual({ month: "2026-10", collected: 124_900, workspaces: 2 });
    expect(r.months.at(-3)).toEqual({ month: "2026-08", collected: 4900, workspaces: 1 });

    const invoices = await read(invoicesCsv(db, { from: "2026-10", to: "2026-10" }));
    expect(invoices.split("\r\n")[0]).toBe(
      '"number","workspace","source","status","currency","amount_due","amount_paid","issued","due","paid","period_start","period_end","description"',
    );
    expect(invoices).toContain(
      ',"Bristol Choir","manual","paid","CHF","1200.00","1200.00","2026-10-01","","2026-10-02","","","Agreed, the year"',
    );
    expect(invoices).not.toContain("2026-08-01");
    const recognised = await read(recognitionCsv(db, { from: "2026-08", to: "2026-10" }));
    expect(recognised).toContain('"2026-08","Endless Hall Records","Pro","CHF","49.00"');
    expect(recognised).toContain('"2026-10","Endless Hall Records","Pro","CHF","49.00"');
    expect(recognised).toContain('"2026-10","Bristol Choir","Agreed","CHF","1200.00"');
  });
});
