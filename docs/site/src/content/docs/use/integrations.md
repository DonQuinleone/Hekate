---
title: Channels and webhooks
description: How a workspace's events reach Slack, Discord, Microsoft Teams or a receiver of your own, how a webhook is checked, and the workspace's own mail.
---

A workspace can tell other places what happens in it: a review asked for, a decision recorded, a new version, a stage that starts, a download. Each place is a **channel**. Admins set them up in *Workspace settings*, *Notifications and integrations*.

- **Kinds.** A Slack incoming webhook, a Discord webhook, a Microsoft Teams workflow webhook, or a webhook of your own. Slack, Discord and Teams get one line and a link into Hekate; a webhook gets the whole event as JSON.
- **Which events.** The *Events* table has a row for each kind of event and a column for each channel; *Which events…* on a channel's menu does the same for one channel.
- **The address is kept sealed.** It is encrypted with the workspace's key, and settings show only where it points: a Slack address is its own secret.
- **Test.** *Test* sends a message now and says what came back.
- **Failures.** A delivery that fails is tried again after 30 seconds, then a minute, two, four, up to six times, or later where the receiver asks for longer (`Retry-After`). An address that is gone (404 or 410) is given up at once. Five failures in a row pause the channel for five minutes; *Resume* starts it again at once.
- **Nothing private.** A channel must be HTTPS and reach the public internet. A receiver inside your own network needs the operator to allow its origin with `WEBHOOK_TRUSTED_ORIGINS`.

An event names things (the project, the review, the track, who acted) and links to them; it never carries media, a comment's words or who was mentioned. Operators see every delivery in the instance's *Logs*, under *Webhooks*, and can send one again from *Debug tools*.

## The workspace's own mail

The first row of *Channels* is the workspace's mail. Until an admin chooses otherwise, it is the instance's: whatever the operator set up. *Use the workspace's own* gives the workspace a provider of its own, with the same choices the installer offers (SMTP, Resend, SparkPost, Mailgun, SendGrid, Amazon SES, Postal, Plunk, Google Workspace, Microsoft 365 or Mailcoach) and an address to send from.

- **What it sends.** Everything sent for the workspace: notifications and digests, review requests and shares, guest links and codes, reminders, upload requests and invitations. Mail that belongs to an account rather than a workspace, such as a password reset, stays with the instance.
- **Sealed.** The password, API key, token or client secret is encrypted with the workspace's key and never shown again; leave it empty when editing to keep it.
- **Failures.** A message the workspace's mail refuses is sent by the instance's mail instead, so nothing is lost. Five refusals in a row pause the workspace's mail for a quarter of an hour; *Resume* tries it again at once, and saving new details starts afresh.
- **Test.** *Test* sends one message to you through the saved details, and nothing stands in for it: what comes back is the answer.
- **Nothing private.** An SMTP server or a Mailcoach address must be on the public internet, unless the operator lists it in `WEBHOOK_TRUSTED_ORIGINS` (`smtp://host:port` for SMTP).

## Bounce reports

Resend, Mailgun, SendGrid, SparkPost, Amazon SES, Postal, Plunk and Mailcoach can tell Hekate when an address bounces for good or someone marks a message as spam. Hekate then stops sending to that address, so a dead mailbox does not keep costing reputation. Google Workspace, Microsoft 365 and other SMTP servers send no such reports.

- **For a workspace's own mail.** Give what proves a report is the provider's in the workspace's mail (*Edit…*): Resend's webhook signing secret, Mailgun's HTTP webhook signing key, SendGrid's verification key, SparkPost's webhook `user:password`, the ARN of the Amazon SNS topic Amazon SES notifies, Postal's signing public key, a bearer token of your own for Plunk, or the secret on Mailcoach's webhook. The dialog then shows the address to paste into the provider's webhook, for its permanent bounce and complaint events. [Bounce reports](../../operate/bounces/) says what to set up at each provider.
- **For the instance's mail.** The operator sets `MAIL_WEBHOOK_SECRET` and points the provider's webhook at `/api/hooks/mail/instance`. The instance's mail settings say which provider it is (Postal needs `MAIL_BOUNCE_PROVIDER` too). An address it reports is not sent to by anyone on the instance.
- **Only signed reports count.** A report whose signature (or, for Plunk, token) does not hold, or that is older than the provider allows, is refused and changes nothing. A bounce the provider will retry by itself (a full mailbox, say) is not a report.
- **What bounced.** *Bounced addresses…* lists what is no longer sent to, and *Send again* is for an address put right or reported in error. Operators find the instance's list under *Settings*, *Address and mail*. Every report, and every message held back, is in the mail log.

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
