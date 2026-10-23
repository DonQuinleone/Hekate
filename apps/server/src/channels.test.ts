import type { WebhookBody } from "@hekate/shared";
import { describe, expect, it } from "vitest";
import { outgoing, signatureHeader, verifySignature } from "./channels.ts";

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
});
