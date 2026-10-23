---
title: Registration
description: Who may make a workspace on the instance (its operators, people they invite, or anyone), the sign-up page, trials, and the limits that keep sign-up from being abused.
---

Registration decides who may make a workspace. It changes nothing about joining one: a workspace's owners and admins invite its members whatever registration says.

On the instance side, **Settings**, **Registration**, **New workspaces**:

| Choice | Who makes a workspace |
| --- | --- |
| **Operators only** (the default) | The instance's operators, on the **Workspaces** page, inviting its first owner by email. Nobody can sign up. |
| **Anyone invited** | Someone an operator invites, at the link in the invitation. They name the workspace, choose its subdomain and become its owner. |
| **Anyone** | Anyone who confirms their email at `/sign-up`. The sign-in page offers **Make a workspace**. An operator can still invite someone. |

A self-hosted studio leaves it on **Operators only**. A hosted offering opens it. Each change is an instance event.

## Inviting someone to make a workspace

With **Anyone invited** or **Anyone**, **Invite…** beside Registration sends an invitation by email. It works once, for a week. The invitations waiting are listed under the choice, each withdrawn from its menu. If the mail cannot be sent, the link is shown to pass on by hand. Turning registration back to **Operators only** stops every invitation still waiting.

## Signing up

1. At `/sign-up`, the person gives their email. A link to make a workspace goes to it: it lasts a day and works once. The page says the same whether or not the address has an account, so it tells nobody who is here.
2. At the link, they name the workspace and choose its subdomain, then give their name and a password (twelve characters or more, checked against known breaches like any other). An address that already has an account signs in first, and only names the new workspace.
3. The workspace starts from the instance's [defaults for new workspaces](../quotas/), with them as its owner, and they are signed in to it. With [workspace subdomains](../../install/subdomains/) on, they go to its own address.

The link is what confirms the email: it reached that address. Accounts made by sign-up are marked verified.

## Trials

With the [billing module](../billing/) on, a workspace that signs up starts a trial on the first plan that has a price and is neither hidden nor retired, in the order the **Plans** tab lists them. The trial lasts as long as **Billing**, **Gateways**, **Trials** says (14 days unless changed; none at 0). When its owner chooses a plan, the trial carries over and converts when it would have ended. Without billing, or without a plan to try, the workspace is on the internal plan, as one an operator makes is.

## Abuse limits

- A link to make a workspace: five an hour from one address, three an hour to one email.
- Workspaces made by sign-up: ten an hour from one address, three a day for one email.
- Past a limit, the answer is 429, with when to try again.
- Each workspace made by sign-up is an instance event, with its owner, the address it came from, whether it was invited, and its trial.
