---
title: Channels and webhooks
description: How a workspace's events reach Slack, Discord, Microsoft Teams or a receiver of your own, and how a webhook is checked.
---

A workspace can tell other places what happens in it: a review asked for, a decision recorded, a new version, a stage that starts, a download. Each place is a **channel**. Admins set them up in *Workspace settings*, *Notifications and integrations*.

- **Kinds.** A Slack incoming webhook, a Discord webhook, a Microsoft Teams workflow webhook, or a webhook of your own. Slack, Discord and Teams get one line and a link into Hekate; a webhook gets the whole event as JSON.
- **Which events.** The *Events* table has a row for each kind of event and a column for each channel; *Which events…* on a channel's menu does the same for one channel.
- **The address is kept sealed.** It is encrypted with the workspace's key, and settings show only where it points: a Slack address is its own secret.
- **Test.** *Test* sends a message now and says what came back.
- **Failures.** A delivery that fails is tried again after 30 seconds, then a minute, two, four, up to six times, or later where the receiver asks for longer (`Retry-After`). An address that is gone (404 or 410) is given up at once. Five failures in a row pause the channel for five minutes; *Resume* starts it again at once.
- **Nothing private.** A channel must be HTTPS and reach the public internet. A receiver inside your own network needs the operator to allow its origin with `WEBHOOK_TRUSTED_ORIGINS`.

An event names things (the project, the review, the track, who acted) and links to them; it never carries media, a comment's words or who was mentioned. Operators see every delivery in the instance's *Logs*, under *Webhooks*, and can send one again from *Debug tools*.

## Receiving a webhook

Each delivery is a `POST` with these headers:

| Header | What it holds |
| --- | --- |
| `Hekate-Event` | The kind, such as `decision.recorded`, or `ping` for a test. |
| `Hekate-Delivery` | This delivery's id; a retry keeps it, a replay has its own. |
| `Hekate-Signature` | `t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body">`, made with the channel's signing secret. |

The body's `id` is the event's: the same on every retry and replay, so a receiver that has seen it can ignore it. Check the signature against the raw body before reading it, and refuse one more than five minutes old:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

export function verified(secret, body, header, now = Date.now()) {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || Math.abs(now / 1000 - t) > 300) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  const given = String(parts.v1 ?? "");
  return given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}
```

The signing secret is shown once, when the webhook is made. *Edit…* and *New secret* make another; the old one stops working at once.

## Events

| Kind | When |
| --- | --- |
| `review.requested` | A review or a share is asked for. |
| `decision.recorded` | A reviewer approves or requests changes. |
| `feedback.submitted` | A reviewer submits feedback. |
| `version.arrived` | A track has a new version. |
| `stage.started` | A workflow stage starts on a track. |
| `comment.mentioned` | A comment mentions someone. |
| `guest.signed_in` | A guest signs in with their link. |
| `file.downloaded` | Someone downloads a file, its original or its listening copy. |
| `processing.failed` | A file cannot be processed. |

Each event's `data` always has `project`, `actor` and `path`, and what its kind is about: `review`, `track`, `file`, `decision`, `version` or `stage`. The schemas are in `packages/shared/src/events.ts`.
