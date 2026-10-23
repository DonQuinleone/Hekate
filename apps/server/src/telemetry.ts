import {
  type Attributes,
  context,
  isSpanContextValid,
  propagation,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { type Logger, logs, SeverityNumber } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchLogRecordProcessor,
  LoggerProvider,
  type LogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { BatchSpanProcessor, NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { routeOf } from "./metrics/index.ts";
import { version } from "./version.ts";

/**
 * OpenTelemetry (#162): a span for each request, each job and each media tool run, and the
 * server's log lines as log records, sent to the collector the operator names
 * (OTEL_EXPORTER_OTLP_ENDPOINT) and nowhere else. Without one, the API's no-op stands in: a
 * span costs nothing and nothing leaves the server. A failure's trace id joins its error
 * reference (#159), so an operator can go from either to the other.
 */

const tracer = () => trace.getTracer("hekate", version);

export interface TelemetrySettings {
  OTEL_EXPORTER_OTLP_ENDPOINT?: string | undefined;
  OTEL_EXPORTER_OTLP_HEADERS?: string | undefined;
  OTEL_SERVICE_NAME?: string | undefined;
}

/** `k=v,k2=v2`, as the OpenTelemetry environment variables write headers. */
export function headersOf(text: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const pair of (text ?? "").split(",")) {
    const at = pair.indexOf("=");
    if (at <= 0) continue;
    headers[decodeURIComponent(pair.slice(0, at).trim())] = decodeURIComponent(
      pair.slice(at + 1).trim(),
    );
  }
  return headers;
}

export interface Telemetry {
  /** Send what is waiting, then stop: called as the server shuts down. */
  shutdown(): Promise<void>;
}

/**
 * Start sending traces and logs to the operator's collector, if one is named. The processors
 * may be given instead, for tests.
 */
export function startTelemetry(
  settings: TelemetrySettings,
  given?: { spans: SpanProcessor; logs?: LogRecordProcessor },
): Telemetry {
  const endpoint = settings.OTEL_EXPORTER_OTLP_ENDPOINT?.replace(/\/+$/, "");
  if (!endpoint && !given) return { shutdown: async () => {} };
  const headers = headersOf(settings.OTEL_EXPORTER_OTLP_HEADERS);
  const resource = resourceFromAttributes({
    "service.name": settings.OTEL_SERVICE_NAME || "hekate",
    "service.version": version,
  });
  const tracing = new NodeTracerProvider({
    resource,
    spanProcessors: [
      given?.spans ??
        new BatchSpanProcessor(new OTLPTraceExporter({ url: `${endpoint}/v1/traces`, headers })),
    ],
  });
  // The async context and the W3C trace context propagator, for the whole process.
  tracing.register();
  const logging = new LoggerProvider({
    resource,
    processors: [
      given?.logs ??
        new BatchLogRecordProcessor({
          exporter: new OTLPLogExporter({ url: `${endpoint}/v1/logs`, headers }),
        }),
    ],
  });
  logs.setGlobalLoggerProvider(logging);
  const restore = mirrorConsole(logging.getLogger("hekate", version));
  return {
    async shutdown() {
      restore();
      await Promise.allSettled([tracing.shutdown(), logging.shutdown()]);
    },
  };
}

const severities = {
  debug: SeverityNumber.DEBUG,
  log: SeverityNumber.INFO,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
} as const;

/**
 * Every console line also as a log record, in the span it was written in. The line still goes
 * to stdout as before, for log shippers that read it. Returns what puts the console back.
 */
function mirrorConsole(logger: Logger): () => void {
  const original = { ...console };
  for (const [method, severity] of Object.entries(severities) as [
    keyof typeof severities,
    SeverityNumber,
  ][]) {
    const write = original[method].bind(console);
    console[method] = (...args: unknown[]) => {
      write(...args);
      try {
        logger.emit({
          severityNumber: severity,
          severityText: method === "log" ? "INFO" : method.toUpperCase(),
          body: args
            .map((a) =>
              a instanceof Error
                ? (a.stack ?? a.message)
                : typeof a === "string"
                  ? a
                  : JSON.stringify(a),
            )
            .join(" ")
            .slice(0, 16_000),
          context: context.active(),
        });
      } catch {
        // A log record that cannot be made is not worth failing the line it copies.
      }
    };
  }
  return () => Object.assign(console, original);
}

/** The trace the current work belongs to, where one is being recorded; for error reports. */
export function currentTraceId(): string | undefined {
  const span = trace.getActiveSpan();
  if (!span?.isRecording()) return undefined;
  const ids = span.spanContext();
  return isSpanContextValid(ids) ? ids.traceId : undefined;
}

/** Run `work` inside a span of its own, ended however it ends; an error marks the span. */
export async function inSpan<T>(
  name: string,
  attributes: Attributes,
  work: (span: Span) => Promise<T>,
  kind: SpanKind = SpanKind.INTERNAL,
): Promise<T> {
  return tracer().startActiveSpan(name, { kind, attributes }, async (span) => {
    try {
      return await work(span);
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * A span for each request, named by the route that answered it (never by its path, which can
 * hold ids), continuing the caller's trace where it sent a `traceparent`. A 5xx marks it.
 */
export const traced = createMiddleware(async (c: Context, next) => {
  const carrier = Object.fromEntries(c.req.raw.headers.entries());
  const parent = propagation.extract(context.active(), carrier);
  const span = tracer().startSpan(
    c.req.method,
    { kind: SpanKind.SERVER, attributes: { "http.request.method": c.req.method } },
    parent,
  );
  await context.with(trace.setSpan(parent, span), async () => {
    try {
      await next();
    } finally {
      const route = routeOf(c);
      span.updateName(`${c.req.method} ${route}`);
      span.setAttribute("http.route", route);
      span.setAttribute("http.response.status_code", c.res.status);
      if (c.res.status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
    }
  });
});
