---
title: Status page and incidents
description: The instance's own status page at /status, its services and uptime, and posting incidents from the Support section.
---

Every instance serves a status page at `/status`, readable by anyone, signed in or not. It shows:

- **What is happening now**: each open incident, with its updates.
- **Services**: App and API, Database, Storage, Processing (the worker) and Mail, each with its state and its last 90 days as bars over its uptime. Mail is listed only when the instance sends it; Storage only when there is a backend.
- **Past incidents** from the last 90 days.

It never names a workspace, a person or a version: the services by name, their state, and the incidents' own words. The page reads `/api/status` (and the help menu `/api/status/now`), which answer without a session.

## How the services are measured

System health checks each service (see [Monitoring](../monitoring/)), and every replica adds each minute to the day's count: minutes checked, and minutes a service was not answering. A minute is counted once however many replicas run. A worker that finished no job in ten minutes reads as slow; a failing check as an outage.

Something that stops the instance measuring (the database down, every replica gone) leaves no minutes behind. Post it as an incident, after the fact if need be, and its time counts: all of a major outage, three tenths of a partial one, none of a slowdown. Time measured as neither down nor in an incident counts as up. Days before the instance first measured anything are shown as not measured, and left out of the uptime.

If the database cannot be read, the page still answers with what was just checked, without its history.

## Posting an incident

Operators post from the instance's **Support** section, which every operator sees whatever `HEKATE_SUPPORT` says (with tickets answered elsewhere, it holds the status page alone).

1. **Post an incident**: a title, what it touches (one service or more), how badly (degraded performance, partial outage, major outage), where it stands (investigating, identified, monitoring, resolved) and what is happening, in plain words for everyone who uses the instance. For one posted after the fact, set when it began, and when it ended if it is already resolved; up to 90 days back, never ahead.
2. **Update it** from its row as you learn more: a new state, the words, and what it touches or how badly if that changed.
3. **Resolve it** with a last update. An update to a resolved incident opens it again.

One posted by mistake can be removed, with its updates. Every post, update, resolution and removal is in the instance's audit log under your name.

As soon as it is posted, an incident shows on the status page, in the help menu (whose button is marked while one is open) and on each workspace's Support page, above the form for a new ticket.

## Linking another page

The help menu and the Support page link the instance's own page unless another is set: the address in the Support section's **Status page** row, else `HEKATE_STATUS_URL` (see the [configuration reference](../../install/configuration/)). A page hosted elsewhere stays up when the instance does not, which no page served by the instance can. Incidents posted here still show at `/status` and in the app either way.
