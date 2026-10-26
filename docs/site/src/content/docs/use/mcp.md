---
title: Assistants (MCP)
description: Connect an AI assistant to Hekate over the Model Context Protocol, so it can read what waits on you, read reviews and comments, comment, record decisions and read QA reports, within a token's scopes.
---

Hekate has a Model Context Protocol (MCP) server built in, so an assistant that speaks MCP can work with your reviews: tell you what is waiting on you, read a review and what people said, add a comment, record your decision on an approval, and read a recording's QA report. It acts as you, in one workspace, and only within the scopes of the token it holds.

No media ever leaves through it. An assistant can read about a file (its name, its comments, its QA findings) but cannot play, download or link to it; to listen or watch, open the review in Hekate.

## The address

Each instance answers at its own address:

```
https://review.endlesshall.example/api/mcp
```

A workspace's owners and admins find it, ready to copy, in *Workspace settings*, *Notifications and integrations*, under *API and MCP*.

It speaks MCP's Streamable HTTP transport (protocol versions `2025-11-25` and `2025-06-18`), without sessions: each message is posted on its own and answered with JSON, or with one event for a client that asks only for a stream.

## Connecting an assistant

An assistant authenticates exactly as a script does, with one of two kinds of token.

**An API token.** Make a token in *Account*, *API tokens* (see [API tokens](../api-tokens/)) with the scopes the assistant needs, and give it to the assistant as a bearer token. Assistants are set up in different ways; many take a configuration such as:

```json
{
  "mcpServers": {
    "hekate": {
      "type": "http",
      "url": "https://review.endlesshall.example/api/mcp",
      "headers": { "Authorization": "Bearer hk_pat_…" }
    }
  }
}
```

**OAuth.** An assistant that signs people in with OAuth finds Hekate's authorisation server by itself: the endpoint answers a request without a token with `401` and a `WWW-Authenticate` header naming its protected resource metadata (RFC 9728), at

```
https://review.endlesshall.example/.well-known/oauth-protected-resource/api/mcp
```

which names Hekate as the authorisation server and lists the scopes. A workspace's owner or admin first registers the assistant as an [OAuth client](../oauth/) with the redirect address it gives (assistants usually call it a callback URL), and gives the assistant the client's id (and secret, for a confidential client). Each member then connects it on the consent screen, choosing what it may do, and can disconnect it in *Account*, *Connected apps*. Hekate does not take dynamic client registration: every client is registered by the workspace.

A signed-in browser session is never enough: the endpoint takes a token and nothing else.

## Tools

The assistant sees only the tools its token's scopes allow, and each tool does no more than the same token could do through the [public API](../api/): every tool is one or more `/api/v1` calls made with that token, so the workspace, your role in each project, the token's limit and the API log apply as they do to a script.

| Tool | Scope | What it does |
| --- | --- | --- |
| `list_waiting_reviews` | `reviews:read` | The reviews that ask something of you, open ones first: by default those where it is your turn now; `include` takes `open` or `all` for more. |
| `get_review` | `reviews:read` | One review: its message, items, reviewers with their state and decision, the decisions so far and what you may do in it, with the comment threads on each reviewed file when the token also has `comments`. |
| `list_comments` | `comments` | A file's comment threads and their replies: who wrote each, when, where it points (a time range, a region or a bar) and whether it is resolved. |
| `add_comment` | `comments` | A comment as you, starting a thread (anchored or not) or replying to one. Mentions and notifications follow as in the app. |
| `record_decision` | `reviews:write` | Your decision on an approval review, *Approved* or *Changes requested*, with an optional note; only where you are a reviewer, it is your turn and your role allows deciding. It is logged as any decision is. |
| `get_qa_report` | `files:read` | A recording's or video's QA report: the delivery profile it is measured against and each finding, with its severity and where it is. |

A write scope includes its read (`reviews:write` lists and reads reviews too). A token with `downloads` gains no tool: nothing here downloads.

A call the token may not make, a review or file in another workspace, or a decision that is not yours to make is answered as a tool error in words the assistant can pass on, such as `That needs the comments scope, which this token does not have. [403 insufficient_scope]` or `Review not found [404 not_found]`. Arguments that do not fit a tool are said the same way, so the assistant can correct them.

## What to give an assistant

Give it the fewest scopes that do the job, and a token of its own so its calls are easy to tell apart in the API log and it can be revoked alone:

- To summarise what is waiting and what people said: `reviews:read` and `comments`.
- To comment as well: the same; `comments` writes as it reads.
- To sign off approvals: add `reviews:write`. Think twice: the decision is yours, recorded under your name.
- For QA reports: `files:read`.

Every call a tool makes is in the API log, with its path as asked (`/api/v1/reviews/…`), and a decision or comment it makes is in the access log and notifies people as yours would. Revoking the token, or disconnecting the OAuth client, stops the assistant at once.
