import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { WebhookBody } from "@hekate/shared";
import { describe, expect, it } from "vitest";
import {
  createSend,
  outgoing,
  retryAfterSeconds,
  signatureHeader,
  verifySignature,
} from "./channels.ts";

const event: WebhookBody = {
  id: "0190a6f0-0000-7000-8000-000000000001",
  type: "decision.recorded",
  createdAt: "2026-10-23T10:00:00.000Z",
  workspace: { id: "0190a6f0-0000-7000-8000-000000000002", name: "Endless Hall Records" },
  data: {
    project: { id: "0190a6f0-0000-7000-8000-000000000003", name: "Joplin Rags" },
    actor: { name: "Tomas *Varga*", guest: false },
    path: "/reviews/r",
    review: {
      id: "0190a6f0-0000-7000-8000-000000000004",
      title: "A & B <masters>",
      kind: "approval",
    },
    decision: "approved",
  },
  summary: "Tomas *Varga* approved “A & B <masters>” in Joplin Rags",
  url: "https://review.endlesshall.example/reviews/r",
};

describe("channels (#161)", () => {
  it("signs a webhook so only the holder of the secret could have sent it, and only lately", () => {
    const at = new Date("2026-10-23T10:00:00Z");
    const header = signatureHeader("whsec_test", '{"a":1}', at);
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(verifySignature("whsec_test", '{"a":1}', header, at)).toBe(true);
    expect(verifySignature("whsec_test", '{"a":2}', header, at)).toBe(false);
    expect(verifySignature("whsec_other", '{"a":1}', header, at)).toBe(false);
    // Replayed ten minutes later, it no longer holds.
    expect(verifySignature("whsec_test", '{"a":1}', header, new Date(at.getTime() + 600_000))).toBe(
      false,
    );
    expect(verifySignature("whsec_test", '{"a":1}', "v1=nothing", at)).toBe(false);
  });

  it("sends a webhook the whole event, with its id and signature in the headers", () => {
    const at = new Date();
    const out = outgoing("webhook", event, { deliveryId: "d1", secret: "whsec_test", at });
    expect(JSON.parse(out.body)).toEqual(event);
    expect(out.headers["hekate-event"]).toBe("decision.recorded");
    expect(out.headers["hekate-delivery"]).toBe("d1");
    expect(verifySignature("whsec_test", out.body, out.headers["hekate-signature"] ?? "", at)).toBe(
      true,
    );
  });

  it("sends chat channels the sentence and a link, their markup made literal", () => {
    const slack = JSON.parse(outgoing("slack", event, { deliveryId: "d" }).body);
    expect(slack.text).toBe(
      "Tomas *Varga* approved “A &amp; B &lt;masters&gt;” in Joplin Rags · <https://review.endlesshall.example/reviews/r|Open in Hekate>",
    );
    const discord = JSON.parse(outgoing("discord", event, { deliveryId: "d" }).body);
    expect(discord.content).toContain("Tomas \\*Varga\\*");
    expect(discord.allowed_mentions).toEqual({ parse: [] });
    const teams = JSON.parse(outgoing("teams", event, { deliveryId: "d" }).body);
    const card = teams.attachments[0].content;
    expect(card.type).toBe("AdaptiveCard");
    expect(card.body[0].text).toBe(event.summary);
    expect(card.actions[0].url).toBe(event.url);
  });

  it("reads a receiver's Retry-After as seconds or as a date", () => {
    const now = new Date("2026-10-23T10:00:00Z");
    expect(retryAfterSeconds("120", now)).toBe(120);
    expect(retryAfterSeconds("Fri, 23 Oct 2026 10:05:00 GMT", now)).toBe(300);
    expect(retryAfterSeconds("Fri, 23 Oct 2026 09:00:00 GMT", now)).toBeNull();
    expect(retryAfterSeconds("soon", now)).toBeNull();
    expect(retryAfterSeconds(undefined, now)).toBeNull();
  });

  it("answers with the status as soon as it comes, however long the body goes on", async () => {
    // A receiver that answers, then trickles a body that never ends.
    const trickling: Server = createServer((_req, res) => {
      res.writeHead(429, { "retry-after": "60" });
      const drip = setInterval(() => res.write("."), 20);
      res.on("close", () => clearInterval(drip));
    });
    await new Promise<void>((resolve) => trickling.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(trickling.address() as AddressInfo).port}`;
    try {
      const started = Date.now();
      const answer = await createSend([origin], 2_000)(`${origin}/hook`, {
        body: "{}",
        headers: { "content-type": "application/json" },
      });
      expect(answer).toEqual({ status: 429, retryAfter: 60 });
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      trickling.closeAllConnections();
      trickling.close();
    }
  });

  it("gives up on a receiver that never answers, whatever it trickles", async () => {
    // Bytes keep arriving, so no idle timeout fires; only the deadline ends it.
    const silent: Server = createServer(() => {});
    silent.on("connection", (socket) => {
      const drip = setInterval(() => socket.write(""), 20);
      socket.on("close", () => clearInterval(drip));
    });
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(silent.address() as AddressInfo).port}`;
    try {
      const started = Date.now();
      await expect(
        createSend([origin], 300)(`${origin}/hook`, { body: "{}", headers: {} }),
      ).rejects.toThrow(/Timed out/);
      expect(Date.now() - started).toBeLessThan(1_500);
    } finally {
      silent.closeAllConnections();
      silent.close();
    }
  });
});
