---
title: OAuth clients and connected apps
description: Register an application that asks people for access with OAuth 2.1, how the consent screen, tokens and refresh work, and how members see and disconnect their connected apps.
---

An application that works for the people who use it (a chat integration, a desktop tool, a delivery service) connects to Hekate with OAuth 2.1 rather than a token someone pastes into it. A workspace registers the application as an **OAuth client**; each member who wants it lets it in on the **consent screen**, and it then acts as them, within what they allowed, until they disconnect it.

A connected app reaches the workspace that registered it, and nothing else, exactly as an [API token](../api-tokens/) does. Its calls are asked for the same scopes, limited the same way and written to the same API log.

## Registering a client

Owners and admins register clients in *Workspace settings*, *API and OAuth clients*. Choose **Client**, then give it:

- **A name.** People see it on the consent screen and in their connected apps.
- **A kind.** *Confidential* for an application that runs on a server and can keep a secret; *Public (PKCE)* for one on someone's computer or phone, which cannot. A client's kind never changes; register another instead.
- **Redirect addresses**, one per line, where the application is sent back to with its answer. Each is matched character for character. Use `https`, `http` on the person's own computer only (`127.0.0.1`, `[::1]` or `localhost`), or the application's own scheme (`hekate-logic://callback`). At `127.0.0.1` and `[::1]` the port may differ from the one registered, as a desktop application listens on whichever is free. An address with a fragment (`#`), or a scheme such as `javascript:` or `file:`, is refused.
- **The scopes it may ask for**: the same scopes as a token's. Each person grants some or all of them.

Hekate answers with the client's id (`hk_cli_…`) and, for a confidential client, its secret (`hk_cls_…`). The secret is shown once; Hekate keeps only a hash of it.

Each client's menu edits it, rotates its secret, shows **who has connected** it (each person, what they granted, when they connected and when it last called for them) and deletes it. Taking scopes away from a client takes them from everyone connected at once, live tokens included. Deleting a client disconnects everyone and stops every token it holds.

**Rotating the secret** stops the old one at once. Tokens already issued keep working until they end; the application needs the new secret to refresh them. To cut everything off, delete the client.

## The flow

Hekate is an OAuth 2.1 authorisation server for the authorisation code flow. Its metadata (RFC 8414) is at:

```
https://review.endlesshall.example/.well-known/oauth-authorization-server
```

| | |
| --- | --- |
| Authorisation | `GET /oauth/authorize` |
| Token | `POST /api/oauth/token` |
| Revocation | `POST /api/oauth/revoke` |
| Grants | `authorization_code`, `refresh_token` |
| PKCE | Required of every client, `S256` only |
| Client authentication | `client_secret_basic` or `client_secret_post` for confidential clients; `none` (the `client_id` alone) for public ones |

1. **Send the person to the consent screen** with `response_type=code`, your `client_id`, a registered `redirect_uri`, the `scope` you need (space-separated; without it, every scope the client may ask for), a `state` you will check, and a PKCE `code_challenge` with `code_challenge_method=S256`.

   ```
   https://review.endlesshall.example/oauth/authorize?response_type=code
     &client_id=hk_cli_…&redirect_uri=https%3A%2F%2Fapp.example%2Fcallback
     &scope=reviews%3Aread%20comments&state=…&code_challenge=…&code_challenge_method=S256
   ```

2. **The person answers.** Signed out, they sign in first and come back. The screen names the application, the workspace, what it would be allowed and where the answer goes. Someone who is not a member of the client's workspace, or whose sign-in falls short of what it asks (a second factor, single sign-on), is refused there. Someone who already granted as much goes straight back; send `prompt=consent` to ask them again.

3. **Back at your redirect address** you get `code` (a minute long, used once), your `state` and `iss`, the issuer. Check both. A refusal comes back as `error=access_denied`; a request with something else wrong as its error (`invalid_scope`, `invalid_request`, `unsupported_response_type`). An unknown client, or an address you did not register, is never sent anywhere: the person sees why on the screen.

4. **Exchange the code** at the token endpoint, form-encoded, with the same `redirect_uri` and your `code_verifier`:

   ```sh
   curl https://review.endlesshall.example/api/oauth/token \
     -u "$CLIENT_ID:$CLIENT_SECRET" \
     -d grant_type=authorization_code -d code="$CODE" \
     -d redirect_uri=https://app.example/callback -d code_verifier="$VERIFIER"
   ```

   The answer carries an `access_token` (`hk_oat_…`, an hour long), a `refresh_token` (`hk_ort_…`, 30 days), `expires_in` and the `scope` granted. A public client sends `client_id` in the body instead of `-u`.

5. **Call the API** with the access token, as with any token: `Authorization: Bearer hk_oat_…`. It acts as the person, with their role as it is at each call, so it can do no more than they can.

6. **Refresh** before the hour is up with `grant_type=refresh_token`. Each refresh token works once: the answer carries the next. You may ask for a narrower `scope` for the new access token; a wider one is refused (`invalid_scope`) and spends nothing.

7. **Revoke** (RFC 7009) when the person signs out of your application: `POST /api/oauth/revoke` with `token`. An access token is revoked alone; a refresh token takes every token of the connection with it. The answer is `200` whatever the token was.

## What is refused

- **A code or refresh token used twice.** The second use may be someone who stole it, so it is refused (`invalid_grant`) and every token of that connection stops working; the application asks the person again.
- **A wrong verifier or address.** The code is spent by the attempt, so neither can be tried twice.
- **A wider scope than granted**, on the consent screen or a refresh.
- **A client without its credentials.** A confidential client's missing or wrong secret, or a public client sending one, is `401 invalid_client`.
- **Anything after the person leaves.** Removed from the workspace, or their account deleted, their connections end with them. A suspended workspace issues nothing.

## Connected apps

Each member sees the applications they connected to the workspace in *Account*, *Connected apps*: what each may do, when it was connected and when it last called. **What it may do** lists the scopes one by one; **Disconnect** stops every token it holds at once. Connecting, disconnecting and every change to a client are in the workspace's access log, and every call a connected app makes is in the API log, named for the application and the member it acts for.
