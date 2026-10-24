import { createDb, runMigrations, schema } from "@hekate/db";
import { context, propagation, SpanStatusCode, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { InMemoryLogRecordExporter, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler, requestId } from "./errors.ts";
import { runJob } from "./jobs.ts";
import { run } from "./media/ffmpeg.ts";
import { collectorShown, headersOf, startTelemetry, type Telemetry, traced } from "./telemetry.ts";
import { currentTraceId, inSpan } from "./tracing.ts";

const job = { id: "j-1", data: {}, signal: new AbortController().signal, retryCount: 0 };

describe("telemetry without a collector (#162)", () => {
  it("reads headers as the OpenTelemetry variables write them", () => {
    expect(headersOf("authorization=Bearer%20abc, x-team = endless-hall,broken")).toEqual({
      authorization: "Bearer abc",
      "x-team": "endless-hall",
    });
    expect(headersOf(undefined)).toEqual({});
  });

  it("shows the collector's address in Settings without any credential it carries (#160)", () => {
    expect(collectorShown("http://otel-collector:4318")).toBe("http://otel-collector:4318");
    expect(collectorShown("https://hekate:hidden-word@otel.example:4318/ingest/?token=abc#x")).toBe(
      "https://otel.example:4318/ingest",
    );
    expect(collectorShown(undefined)).toBeNull();
    expect(collectorShown("")).toBeNull();
    expect(collectorShown("not an address")).toBeNull();
  });

  it("records nothing and costs nothing while no collector is named", async () => {
    const telemetry = await startTelemetry({});
    const seen = await inSpan("work", {}, async () => currentTraceId());
    expect(seen).toBeUndefined();
    await telemetry.shutdown();
  });
});

describe("telemetry to a collector (#162)", () => {
  const spans = new InMemorySpanExporter();
  const records = new InMemoryLogRecordExporter();
  let telemetry: Telemetry;

  beforeAll(async () => {
    telemetry = await startTelemetry(
      { OTEL_SERVICE_NAME: "hekate-test" },
      {
        spans: new SimpleSpanProcessor(spans),
        logs: new SimpleLogRecordProcessor({ exporter: records }),
      },
    );
  });
  afterAll(async () => {
    await telemetry.shutdown();
    trace.disable();
    context.disable();
    propagation.disable();
    logs.disable();
  });
  beforeEach(() => {
    spans.reset();
    records.reset();
  });

  const app = (db?: Parameters<typeof errorHandler>[0]) => {
    const app = new Hono();
    app.use("/api/*", traced);
    app.use("/api/*", requestId);
    app.get("/api/files/:id", (c) => c.json({ id: c.req.param("id") }));
    app.get("/api/broken", () => {
      throw new Error("disk full");
    });
    app.onError(errorHandler(db));
    return app;
  };

  it("names a request's span by its route, never its path, and marks a failure", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await app().request("/api/files/0199e3a1-7c2f-7b40-9a51-4f2d8c1e09aa");
    await app().request("/api/broken");
    error.mockRestore();
    const [found, broken] = spans.getFinishedSpans();
    expect(found?.name).toBe("GET /api/files/:id");
    expect(found?.attributes).toMatchObject({
      "http.request.method": "GET",
      "http.route": "/api/files/:id",
      "http.response.status_code": 200,
    });
    expect(JSON.stringify([found?.name, found?.attributes])).not.toContain("0199e3a1");
    expect(found?.status.code).toBe(SpanStatusCode.UNSET);
    expect(broken?.name).toBe("GET /api/broken");
    expect(broken?.attributes["http.response.status_code"]).toBe(500);
    expect(broken?.status.code).toBe(SpanStatusCode.ERROR);
  });

  it("continues the trace a caller started", async () => {
    await app().request("/api/files/1", {
      headers: { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" },
    });
    const [span] = spans.getFinishedSpans();
    expect(span?.spanContext().traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(span?.parentSpanContext?.spanId).toBe("00f067aa0ba902b7");
  });

  it("gives each job a span by its queue, failed when the job fails", async () => {
    await runJob("workspaces-purge", job, async () => undefined);
    await expect(
      runJob("workspaces-purge", job, async () => {
        throw new Error("disk full");
      }),
    ).rejects.toThrow("disk full");
    const [done, failed] = spans.getFinishedSpans();
    expect(done?.name).toBe("job workspaces-purge");
    expect(done?.attributes).toMatchObject({
      "messaging.destination.name": "workspaces-purge",
      "messaging.message.id": "j-1",
      "hekate.job.attempt": 1,
    });
    expect(failed?.status.code).toBe(SpanStatusCode.ERROR);
    expect(failed?.events.map((e) => e.name)).toEqual(["exception"]);
  });

  it("gives each media tool run a span, inside its job's, without its arguments", async () => {
    await runJob("workspaces-purge", job, async () => {
      await run(process.execPath, ["-e", "", "Maple Leaf Rag.wav"]);
    });
    const [tool, outer] = spans.getFinishedSpans();
    expect(tool?.name).toBe("node");
    expect(tool?.attributes).toEqual({
      "process.executable.name": "node",
      "hekate.media.arguments": 3,
    });
    expect(tool?.parentSpanContext?.spanId).toBe(outer?.spanContext().spanId);
    expect(JSON.stringify([tool?.name, tool?.attributes, tool?.events])).not.toContain(
      "Maple Leaf",
    );
  });

  it("sends each log line too, in the trace it was written in", async () => {
    const traceId = await inSpan("work", {}, async () => {
      console.warn("Storage is nearly full", { free: 3 });
      return currentTraceId();
    });
    const [record] = records.getFinishedLogRecords();
    expect(record?.body).toBe('Storage is nearly full {"free":3}');
    expect(record?.severityText).toBe("WARN");
    expect(record?.spanContext?.traceId).toBe(traceId);
  });

  const url = process.env.DATABASE_URL;

  it.runIf(url)("joins a failure's reference to its trace", async () => {
    await runMigrations(url ?? "");
    const { db, close } = createDb(url ?? "", { max: 2 });
    try {
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const response = await app(db).request("/api/broken");
      error.mockRestore();
      const { error: body } = (await response.json()) as { error: { reference: string } };
      const [row] = await db
        .select({ traceId: schema.errorReports.traceId })
        .from(schema.errorReports)
        .where(eq(schema.errorReports.reference, body.reference));
      const [span] = spans.getFinishedSpans();
      expect(row?.traceId).toBe(span?.spanContext().traceId);
    } finally {
      await close();
    }
  });
});
