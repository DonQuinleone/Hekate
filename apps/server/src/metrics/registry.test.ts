import { describe, expect, it } from "vitest";
import { createRegistry } from "./registry.ts";

describe("the metrics registry (#70)", () => {
  it("writes counters and gauges in the text format, label values escaped", async () => {
    const r = createRegistry();
    const requests = r.counter("hekate_http_requests_total", "Requests answered", [
      "route",
      "status",
    ]);
    requests.inc({ route: "/api/files/:id", status: "200" });
    requests.inc({ route: "/api/files/:id", status: "200" }, 2);
    requests.inc({ route: 'odd "route"\\', status: "404" });
    const waiting = r.gauge("hekate_jobs_waiting", "Jobs waiting", ["queue"]);
    waiting.set({ queue: "media-probe" }, 3);
    expect(await r.render()).toBe(
      [
        "# HELP hekate_http_requests_total Requests answered",
        "# TYPE hekate_http_requests_total counter",
        'hekate_http_requests_total{route="/api/files/:id",status="200"} 3',
        'hekate_http_requests_total{route="odd \\"route\\"\\\\",status="404"} 1',
        "# HELP hekate_jobs_waiting Jobs waiting",
        "# TYPE hekate_jobs_waiting gauge",
        'hekate_jobs_waiting{queue="media-probe"} 3',
        "",
      ].join("\n"),
    );
  });

  it("counts observations into cumulative buckets, with a sum and a count", async () => {
    const r = createRegistry();
    const duration = r.histogram("d_seconds", "How long", ["queue"], [0.1, 1]);
    duration.observe({ queue: "q" }, 0.05);
    duration.observe({ queue: "q" }, 0.5);
    duration.observe({ queue: "q" }, 3);
    const text = await r.render();
    expect(text).toContain('d_seconds_bucket{queue="q",le="0.1"} 1');
    expect(text).toContain('d_seconds_bucket{queue="q",le="1"} 2');
    expect(text).toContain('d_seconds_bucket{queue="q",le="+Inf"} 3');
    expect(text).toContain('d_seconds_sum{queue="q"} 3.55');
    expect(text).toContain('d_seconds_count{queue="q"} 3');
  });

  it("runs its collectors before each scrape, and survives one that fails", async () => {
    const r = createRegistry();
    const gauge = r.gauge("g", "A gauge", ["k"]);
    let n = 0;
    r.onCollect(async () => {
      gauge.reset();
      gauge.set({ k: "now" }, ++n);
    });
    r.onCollect(async () => {
      throw new Error("the database is away");
    });
    expect(await r.render()).toContain('g{k="now"} 1');
    expect(await r.render()).toContain('g{k="now"} 2');
  });

  it("refuses a bad name, a name twice, and a counter going down", () => {
    const r = createRegistry();
    expect(() => r.counter("bad-name", "x")).toThrow();
    expect(() => r.counter("ok", "x", ["bad-label"])).toThrow();
    const ok = r.counter("ok", "x");
    expect(() => r.gauge("ok", "x")).toThrow();
    expect(() => ok.inc({}, -1)).toThrow();
  });
});
