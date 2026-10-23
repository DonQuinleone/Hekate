import {
  type Attributes,
  isSpanContextValid,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { version } from "./version.ts";

/**
 * Spans (#162), kept apart from the SDK and the request middleware in telemetry.ts: the media
 * tools and their worker threads import this, and each thread loads only the API with it.
 */

export const tracer = () => trace.getTracer("hekate", version);

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
