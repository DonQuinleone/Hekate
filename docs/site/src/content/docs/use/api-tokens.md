---
title: API tokens
description: Tokens for your own scripts and tools, service tokens that act for a workspace, the scopes each may hold, and how calls are made, limited and logged.
---

Scripts and tools reach Hekate's API with a token instead of signing in. There are two kinds:

- **Your own tokens**, in *Account*, *API tokens*. A token acts as you: it can do no more than you can, and only what its scopes allow. It reaches the workspace you made it in, and nothing else; switch workspace to make one for another.
- **Service tokens**, in *Workspace settings*, *API*, for owners and admins. They act as the workspace rather than a person: a release pipeline, an archive that syncs every night. What one makes is shown as the token's, and it keeps working whoever leaves.

## Making a token

Choose **Token** (or **Create**, for a service token), give it a name you will recognise, pick the least it needs and how long it lasts: 30 days, 90 days, a year, or until you revoke it.

The token is shown once. Copy it then: Hekate keeps only a hash of it and cannot show it again. It starts `hk_pat_` (yours) or `hk_svc_` (a service token), so a secret scanner can find one that leaked. If one does, revoke it at once.

Each row says what a token may do, when it was made, when it was last used and when it runs out. Its menu renames it, changes its scopes (from its next call) or revokes it. A revoked or expired token is refused from then on; make another rather than bring one back. Leaving a workspace, or deleting your account, revokes your tokens there.

## Scopes

| Scope | What it allows |
| --- | --- |
| `files:read` | List and read projects, folders, files, tracks, versions and variations, and search. |
| `files:write` | Upload versions and variations, make folders, change files. Includes `files:read`. |
| `reviews:read` | Read reviews, reviewers and decisions. |
| `reviews:write` | Request reviews and record decisions as the token's member. Includes `reviews:read`. |
| `comments` | Read and write comments and their anchors. |
| `downloads` | Download originals and proxies: watermarked for the token's member, and logged. |
| `workflows` | Read and change workflows and their runs. |
| `org:read` | The workspace's members, roles and settings, read-only. |

Some things no token can do, whatever it holds: sign in, change an account, a workspace's settings or another token, reach the instance's pages, play media or render a document's pages (those stay bound to a browser), delete or move a project, or make calendar links. Such a call is refused with `token_not_allowed`.

## Making calls

Send the token in each call's `Authorization` header:

```sh
curl https://review.endlesshall.example/api/projects \
  -H "Authorization: Bearer $HEKATE_TOKEN"
```

The answers and errors are the web app's own. A token that is wrong, revoked or expired gets `401` with `token_invalid`; a call its scopes do not cover gets `403` with `insufficient_scope`, naming the scope it needs. A session cookie sent with a token is ignored: the token alone decides.

A download works as it does in the app: ask for one (`POST /api/files/{id}/downloads`) and fetch the link it gives within five minutes, once, with the same token.

## Limits and the API log

Each token may make 600 calls a minute; past that it gets `429` with `Retry-After`, the seconds to wait.

Every call a token makes, refused or not, is written to the API log: when, which token, the method and path (never the query or the body), the answer and how long it took. A workspace's owners and admins see its latest calls in *Workspace settings*, *API*; operators see every workspace's in the instance's *Logs*, under *API*, kept for 30 days unless they choose otherwise. Making, changing and revoking a token are in the workspace's access log.
