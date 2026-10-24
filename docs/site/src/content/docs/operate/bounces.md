---
title: Bounce reports
description: Letting the mail provider tell Hekate which addresses bounce for good or complain, for Resend, Mailgun, SendGrid, SparkPost, Amazon SES, Postal, Plunk and Mailcoach.
---

A mail provider can tell Hekate when an address bounces for good or someone marks a message as spam. Hekate then stops sending to the address: for everyone on the instance where the instance's mail reported it, or for one workspace where that workspace's own mail did. A bounce the provider retries by itself (a full mailbox, say) is not a report.

Reports arrive at a webhook, and count only once what proves they are the provider's holds. One that does not is refused with 401 and changes nothing.

## The instance's mail

1. Set `MAIL_WEBHOOK_SECRET` to what the provider proves its reports with (the table below).
2. Point the provider at `https://<your address>/api/hooks/mail/instance`.
3. Postal only: set `MAIL_BOUNCE_PROVIDER=postal`, as its host is your own and says nothing. A self-hosted Plunk needs `MAIL_BOUNCE_PROVIDER=plunk` for the same reason.

Hekate knows the other providers from the mail settings: the SMTP host for Resend, Mailgun, SendGrid, SparkPost and Plunk, any of Amazon SES's regional endpoints (`email-smtp.<region>.amazonaws.com`), and `MAIL_MAILCOACH_URL` for Mailcoach. **Settings**, **Address and mail**, shows the provider and the address once it does.

A workspace with mail of its own gives the same secret in its mail settings, and its dialog shows the address to use, ending `/api/hooks/mail/workspaces/<id>`.

## What each provider needs

| Provider | Secret | Events | Checked by |
| --- | --- | --- | --- |
| Resend | The webhook's signing secret (`whsec_…`) | `email.bounced`, `email.complained` | Svix HMAC, within five minutes |
| Mailgun | The HTTP webhook signing key | Permanent failure, complaint | HMAC, within five minutes |
| SendGrid | The signed Event Webhook's verification key | Bounce, spam report | ECDSA, within five minutes |
| SparkPost | The webhook's `user:password` | Bounce, spam complaint | Basic authentication |
| Amazon SES | The SNS topic's ARN | Bounce and complaint notifications | SNS's RSA signature, within an hour |
| Postal | Postal's signing public key | `MessageBounced`, `MessageHeld` | RSA, within an hour |
| Plunk | A token of your own | Workflows on `email.bounce` and `email.complaint` | The bearer token |
| Mailcoach | The webhook's secret | Bounced | HMAC |

### Amazon SES

SES reports through Amazon SNS.

1. Make an SNS topic (Standard), and in SES set it as the identity's bounce and complaint notification topic (or a configuration set's event destination for bounces and complaints).
2. Subscribe the webhook address to the topic with the **HTTPS** protocol, raw message delivery **off**. Hekate confirms the subscription itself; the subscription shows as confirmed within a moment.
3. Give the topic's ARN (`arn:aws:sns:<region>:<account>:<topic>`) as the secret.

Hekate checks each message's signature against SNS's certificate, which it fetches only from `sns.<region>.amazonaws.com` over HTTPS, and refuses a message for any other topic, however genuine. Setting the topic's signature version to 2 (SHA-256) is better than the default 1 (SHA-1); both are read. A permanent bounce and a complaint are reports; a complaint the recipient's provider marks `not-spam` is not.

### Postal

1. Find Postal's public key: the `p=` value of the DKIM record `postal default-dkim-record` prints (the whole record, or the key as PEM, will do too).
2. In the mail server's **Webhooks**, add one for the address, with the `MessageBounced` and `MessageHeld` events.
3. Give the public key as the secret.

Postal signs every webhook (with SHA-256 from Postal 3.2, SHA-1 before). It does not class a bounce as hard or soft, so Hekate takes a bounce message Postal links to a message it sent, and a message held because its address is on Postal's suppression list, where Postal puts an address after repeated hard failures. A message held for another reason (a send limit, say) is not a report.

### Plunk

Plunk signs nothing; its webhooks are a workflow's Webhook step, which sends the headers it is given.

1. Choose a long random token, such as one from `openssl rand -hex 32`, and give it as the secret.
2. Make a workflow triggered by `email.bounce`, with a **Webhook** step: the address, method `POST`, the headers `{"Authorization": "Bearer <token>"}`, and no body of its own (the default body is what Hekate reads).
3. Make a second workflow the same way, triggered by `email.complaint`.

A bounce whose `bounceType` is `Permanent` is a report; a transient one is not.

### Mailcoach

1. In Mailcoach's **Settings**, **Webhooks**, add one for the address, for the lists Hekate's addresses are on, with a secret.
2. Choose the **Bounced** event.
3. Give the secret as the secret.

Mailcoach sends no complaints by webhook, and its webhooks belong to email lists, so it reports bounces for addresses that are a list's subscribers.

## What bounced

**Bounced addresses…** (instance **Settings**, **Address and mail**; a workspace's **Notifications and integrations**, its mail's menu) lists what is no longer sent to. **Send again** takes an address off the list, for one put right or reported in error. Every report, and every message held back, is in the mail log.
