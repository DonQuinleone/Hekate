import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { ChannelKind, PingBody, WebhookBody } from "@hekate/shared";
import { privateAddress, publicLookup } from "./sso.ts";

/**
 * What each kind of channel is sent (#161), how a webhook is signed, and the one way out of the
 * server to a channel's address: no redirects, ten seconds, and a public address only, unless
 * the operator trusts the origin (`WEBHOOK_TRUSTED_ORIGINS`), so a workspace cannot point the
 * server at the network it runs in.
 */

/** What a channel's sealed configuration holds. */
export interface ChannelConfig {
  url: string;
  /** A webhook's signing secret. */
  secret?: string;
}

export const newSigningSecret = () => `whsec_${randomBytes(32).toString("base64url")}`;

/**
 * A webhook's signature header: when it was signed, and an HMAC-SHA256 of that time and the
 * body, `t=1700000000,v1=hex`. A receiver checks both, so an old delivery cannot be replayed
 * against it.
 */
export function signatureHeader(secret: string, body: string, at = new Date()): string {
  const t = Math.floor(at.getTime() / 1000);
  const mac = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return `t=${t},v1=${mac}`;
}

/** Whether a signature header holds for a body, signed within `toleranceSeconds` of now. */
export function verifySignature(
  secret: string,
  body: string,
  header: string,
  now = new Date(),
  toleranceSeconds = 300,
): boolean {
  const parts = new Map(
    header.split(",").map((p) => {
      const at = p.indexOf("=");
      return [p.slice(0, at).trim(), p.slice(at + 1).trim()] as const;
    }),
  );
  const t = Number(parts.get("t"));
  const given = parts.get("v1") ?? "";
  if (!Number.isInteger(t) || Math.abs(now.getTime() / 1000 - t) > toleranceSeconds) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return (
    given.length === expected.length &&
    timingSafeEqual(Buffer.from(given, "utf8"), Buffer.from(expected, "utf8"))
  );
}

/** Slack's mrkdwn treats these three as its own. */
const slackText = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Discord's markdown, made literal: names may hold asterisks and underscores. */
const discordText = (s: string) => s.replace(/([\\*_~`|>[\]])/g, "\\$1");

export interface Outgoing {
  body: string;
  headers: Record<string, string>;
}

/**
 * The request a channel is sent for an event. Chat channels get the sentence and a link; a
 * webhook gets the whole event, signed, with its id to tell a repeat from a new one.
 */
export function outgoing(
  kind: ChannelKind,
  event: WebhookBody | PingBody,
  options: { deliveryId: string; secret?: string; at?: Date },
): Outgoing {
  const json = { "content-type": "application/json", "user-agent": "Hekate-Webhooks/1" };
  if (kind === "slack")
    return {
      headers: json,
      body: JSON.stringify({ text: `${slackText(event.summary)} · <${event.url}|Open in Hekate>` }),
    };
  if (kind === "discord")
    return {
      headers: json,
      body: JSON.stringify({
        username: "Hekate",
        content: `${discordText(event.summary)}\n<${event.url}>`,
        // Nobody is pinged, whatever a name says.
        allowed_mentions: { parse: [] },
      }),
    };
  if (kind === "teams")
    return {
      headers: json,
      body: JSON.stringify({
        type: "message",
        attachments: [
          {
            contentType: "application/vnd.microsoft.card.adaptive",
            content: {
              $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
              type: "AdaptiveCard",
              version: "1.4",
              body: [{ type: "TextBlock", text: event.summary, wrap: true }],
              actions: [{ type: "Action.OpenUrl", title: "Open in Hekate", url: event.url }],
            },
          },
        ],
      }),
    };
  const body = JSON.stringify(event);
  return {
    body,
    headers: {
      ...json,
      "hekate-event": event.type,
      "hekate-delivery": options.deliveryId,
      ...(options.secret
        ? { "hekate-signature": signatureHeader(options.secret, body, options.at) }
        : {}),
    },
  };
}

export interface Answer {
  status: number;
  /** Seconds the receiver asked to be left alone for (Retry-After), if it said. */
  retryAfter: number | null;
}

/** POSTs to a channel's address and says what it answered; rejects when nothing answered. */
export type Send = (url: string, out: Outgoing) => Promise<Answer>;

export function createSend(trusted: string[], timeoutMs = 10_000): Send {
  return (url, out) => {
    const target = new URL(url);
    const request = target.protocol === "https:" ? httpsRequest : httpRequest;
    const host = target.hostname.replace(/^\[|\]$/g, "");
    // An address given as a number is connected to without a lookup, so it is checked here.
    if (!trusted.includes(target.origin) && isIP(host) && privateAddress(host))
      return Promise.reject(new Error(`${host} is on a private network`));
    return new Promise((resolve, reject) => {
      const req = request(
        target,
        {
          method: "POST",
          headers: { ...out.headers, "content-length": Buffer.byteLength(out.body) },
          timeout: timeoutMs,
          ...(trusted.includes(target.origin) ? {} : { lookup: publicLookup }),
        },
        (res) => {
          // The body says nothing Hekate keeps; it is read only to free the connection.
          res.resume();
          res.on("end", () => {
            const after = Number(res.headers["retry-after"]);
            resolve({
              status: res.statusCode ?? 0,
              retryAfter: Number.isFinite(after) && after > 0 ? after : null,
            });
          });
          res.on("error", reject);
        },
      );
      req.on("timeout", () => req.destroy(new Error("Timed out")));
      req.on("error", reject);
      req.end(out.body);
    });
  };
}
