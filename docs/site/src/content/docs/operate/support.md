---
title: Support desk
description: Answering workspaces' tickets in the app, or pointing the help menu at a desk or mailbox of your own.
---

Support is a module, off by default: a self-hosted install answers its own people however it likes. `HEKATE_SUPPORT` chooses how:

| Value | What the help menu offers |
| --- | --- |
| `off` | The documentation (`HEKATE_DOCS_URL`), and nothing else. |
| `app` | The documentation, **My tickets** and **Contact support**: tickets answered on the instance's Support page. |
| `link` | The documentation, and **Contact support** opening your own help desk at `HEKATE_SUPPORT_ADDRESS`. |
| `mail` | The documentation, and **Contact support** writing to `HEKATE_SUPPORT_ADDRESS`. |

In every mode the help menu also offers **Status**: the instance's own [status page](../status/), or another page set by the desk or `HEKATE_STATUS_URL`. See the [configuration reference](../../install/configuration/).

## The desk

With `HEKATE_SUPPORT=app`, the instance side has a **Support** section for its operators.

- **Figures**: tickets open and those waiting on you, the median time to a first reply this month, those resolved this month, and whether an incident is open on the status page.
- **Status page**: the incidents posted for it, and where the help menu links; see [Status page and incidents](../status/).
- **Tickets** from every workspace, newest activity first, filtered by state (open, waiting on you, all), workspace and severity, and searched by subject, reference, workspace or who asked.
- **A ticket** opens as its thread beside who asked (their role in the workspace and when they were last seen) and the workspace (its plan and open reviews), each a step from its page on the instance side; the error reference, looked up in place; the file or review it is about, and whether they let you open it; and its severity.
- **Answering** tells whoever asked, in their inbox and by email as they choose in their notification settings, and the ticket waits on them; the state select sets any state, with or without a reply. A **canned reply** puts its words in the reply box, to change before sending. Attachments go both ways, each download in the workspace's access log under your name.
- **States**: waiting on support (new, or the workspace replied), open (being looked into), answered (waiting on the workspace) and resolved.

## The desk's settings

- **Severities by plan.** Low and Normal on every plan; what else each plan allows is set with the plan, under Billing. Without billing every workspace may mark any severity.
- **On call.** The operator who hears of each new ticket and reply first. With nobody on call, every operator does. An Emergency is marked as one in the subject, so a mail rule can page whoever is on call.
- **Canned replies.** The answers the desk gives most.

Every reply, change of state and change to the desk is in the instance's audit log.
