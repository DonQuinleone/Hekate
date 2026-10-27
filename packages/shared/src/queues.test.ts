import { describe, expect, it } from "vitest";
import { rateInWords, rateLimits } from "./instance-operations.ts";
import { formatJobSeconds, pausedQueues, queueParam } from "./queues.ts";

describe("queues (decision 250)", () => {
  it("reads a job's time as the table shows it", () => {
    expect(formatJobSeconds(0.84)).toBe("0.8 s");
    expect(formatJobSeconds(41.2)).toBe("41 s");
    expect(formatJobSeconds(130)).toBe("2 min");
    expect(formatJobSeconds(5400)).toBe("90 min");
    expect(formatJobSeconds(9000)).toBe("2.5 h");
  });

  it("takes only a queue's own spelling as its name", () => {
    expect(queueParam.safeParse({ name: "media-proxy" }).success).toBe(true);
    expect(queueParam.safeParse({ name: "Media Proxy" }).success).toBe(false);
    expect(queueParam.safeParse({ name: "a'; drop" }).success).toBe(false);
    expect(pausedQueues.safeParse(Array.from({ length: 65 }, () => "mail")).success).toBe(false);
  });
});

describe("rate limits in words (decision 251)", () => {
  it("says each rule as people read it", () => {
    expect(rateInWords(rateLimits.contentKeys)).toBe("30 a minute");
    expect(rateInWords(rateLimits.downloads)).toBe("20 an hour");
    expect(rateInWords(rateLimits.guestLinks)).toBe("30 in 10 minutes");
    expect(rateInWords({ max: 5, windowMs: 2 * 60 * 60_000 })).toBe("5 in 2 hours");
  });
});
