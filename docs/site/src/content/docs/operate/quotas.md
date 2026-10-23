---
title: Quotas and usage
description: Holding a workspace to a storage quota and a member limit, what is refused at a limit, and what each workspace's usage counts.
---

A workspace may be held to a storage quota and a number of members. Nothing is limited until an operator says so: a self-hosted instance with one studio need set nothing here.

## Set the limits

On the instance side, **Workspaces**, choose the workspace, then **Storage**. Its **Quota** section shows what it uses against each limit, and an operator chooses the storage quota (250 GB, 1 TB, 2 TB, 5 TB or none) and the member limit (5 to 100, or none) there. Each change is an instance event.

**Settings**, **Defaults for new workspaces**, sets what a workspace an operator makes starts with. Changing a default changes no workspace that exists already.

## What a limit refuses

| Limit | Refused at it | Counts |
| --- | --- | --- |
| Storage quota | Starting an upload, by a member or through an upload request; attaching a file to a comment. | Every byte the workspace stores, before encryption: originals and what Hekate made from them, with the uploads still arriving, which take their room as they begin. |
| Member limit | Inviting someone; accepting an invitation; a first sign-in through the workspace's directory. Someone signing in through its single sign-on for the first time is signed in, and joins on a later sign-in once there is room. | Members, and the invitations waiting, each of which takes a place. |

A refusal says where the workspace stands: *Storage quota reached: 1.0 TB of 1.0 TB*. Lowering a limit below what a workspace uses removes nothing: it only refuses what would add to it. Renditions, pages and waveforms of files already uploaded are always made, even past the quota.

From 90% of a limit, the workspace's **Storage** settings and its Storage tab on the instance side say it is nearly full, and the instance's **Overview** lists each workspace at 90% of its storage quota or more.

## Usage

Each workspace's **Storage** settings show, for its admins, its storage, members, guests and projects as they are now, and the month so far: plays (a player starting a session), downloads, and its storage at the month's peak. A job counts the month each hour (`usage-refresh`), reading only the access log's events since its last count; months are kept by their first day, in UTC, for billing to read later.
