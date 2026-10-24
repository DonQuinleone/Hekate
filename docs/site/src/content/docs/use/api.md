---
title: The API
description: "Hekate's public API, version 1, at /api/v1: authentication, versions and what they promise, errors, limits, worked examples and the OpenAPI document."
---

Scripts, pipelines and other tools reach Hekate through its public API: the calls an [API token](../api-tokens/) may make, under a versioned address that only grows. Every call is listed, with its scope, parameters, body and an example, in the **API reference** (in the sidebar), written from the same routes the server runs.

An AI assistant that speaks the Model Context Protocol connects to the same API through Hekate's MCP endpoint instead: see [Assistants (MCP)](../mcp/).

## The address and versions

Each instance answers at its own address, under `/api/v1`:

```
https://review.endlesshall.example/api/v1
```

Within version 1, the API only grows: new calls, new optional fields in a request, new fields in an answer, new error codes. Read answers leniently and ignore fields you do not know, and a script written today keeps working. Anything that would break a script (removing or renaming a call or a field, making a field required, taking fewer values) waits for version 2, which will be answered beside version 1 for at least two releases, version 1's answers carrying `Deprecation` and `Sunset` headers meanwhile so a script can notice.

The web app talks to the unversioned `/api`, which changes with it in any release. A token works there too, but nothing there is promised: use `/api/v1`. Under `/api/v1`, a call outside the public API (signing in, your account, settings, tokens, playback) answers `404`.

## Authentication

Send a token in each call's `Authorization` header:

```sh
curl https://review.endlesshall.example/api/v1/projects \
  -H "Authorization: Bearer $HEKATE_TOKEN"
```

A member's token acts as them, with their role as it is at each call, within its scopes; a service token acts for the workspace with an admin's reach, within its scopes. Each call in the reference names the scope it needs. [API tokens](../api-tokens/) covers making them, the scopes and what no token can do.

## Worked examples

### Upload a file and add it as a version

An upload is started, sent in 8 MiB chunks (in any order, again if one fails) and finished. The file is then prepared in the background.

```sh
# 1. Say what is coming and where it goes.
curl -X POST https://review.endlesshall.example/api/v1/uploads \
  -H "Authorization: Bearer $HEKATE_TOKEN" -H "Content-Type: application/json" \
  -d '{"projectId":"01929b8e-5c1a-7d3e-9f40-2b6c8d1e4a57","name":"Maple Leaf Rag (wet).wav","size":52428800,"contentType":"audio/wav"}'
# It answers 201 with { "upload": { "id": …, "chunkSize": 8388608, "chunkCount": 7, … } }.

# 2. Send each chunk, numbered from 0.
split -b 8388608 -d -a 3 "Maple Leaf Rag (wet).wav" chunk.
for f in chunk.*; do
  curl -X PUT "https://review.endlesshall.example/api/v1/uploads/$UPLOAD/chunks/$((10#${f#chunk.}))" \
    -H "Authorization: Bearer $HEKATE_TOKEN" -H "Content-Type: application/octet-stream" \
    -H "Content-Digest: sha-256=:$(openssl dgst -sha256 -binary "$f" | base64):" \
    --data-binary @"$f"
done

# 3. Finish it: 201 with the file.
curl -X POST "https://review.endlesshall.example/api/v1/uploads/$UPLOAD/complete" \
  -H "Authorization: Bearer $HEKATE_TOKEN"

# 4. Make it the track's next version, as its only variation.
curl -X POST "https://review.endlesshall.example/api/v1/tracks/$TRACK/versions" \
  -H "Authorization: Bearer $HEKATE_TOKEN" -H "Content-Type: application/json" \
  -d '{"notes":"Horns up at bar 12, as asked.","variations":[{"fileId":"'"$FILE"'","name":"Wet mix","primary":true}]}'
```

`GET /api/v1/uploads/{id}` says which chunks have arrived, so an interrupted upload sends only the rest. The upload and the version need `files:write`.

### Send a bounce with its edit decision list

A DAW's bounce and the list it was edited from go up together: upload the `.edl` into the same project as any other file, then name it with the version. Where the project asks for a list with every version, the version waits for its files to be measured: until then the call answers `409` with the code `version_measuring`, so wait a few seconds and send it again.

```sh
# Upload "Maple Leaf Rag v3.wav" and "Maple Leaf Rag v3.edl" as above, giving $FILE and $EDL.
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  status=$(curl -s -o version.json -w '%{http_code}' \
    -X POST "https://review.endlesshall.example/api/v1/tracks/$TRACK/versions" \
    -H "Authorization: Bearer $HEKATE_TOKEN" -H "Content-Type: application/json" \
    -d '{"variations":[{"fileId":"'"$FILE"'","name":"Main","primary":true}],"edlFileId":"'"$EDL"'"}')
  if [ "$status" = 409 ] && grep -q version_measuring version.json; then sleep 5; else break; fi
done
```

The list is read as CMX 3600, the form editors and DAWs export (Sequoia's *Export project as EDL*, for one). A list Hekate cannot read, or one that runs past the end of the version, is refused with `422` and the code `version_refused`, saying why. A list can also be given, changed or taken off later with `PUT /api/v1/versions/{id}/edl`. Both need `files:write`.

### Log a take from your own tool

A script beside the recorder or the DAW can keep the take log, and everyone with the session's take log open sees each take within a couple of seconds. Start the next take as recording starts, and stop it as recording stops:

```sh
TAKE=$(curl -s -X POST "https://review.endlesshall.example/api/v1/sessions/$SESSION/takes" \
  -H "Authorization: Bearer $HEKATE_TOKEN" -H "Content-Type: application/json" \
  -d '{"trackId":"'"$TRACK"'","timecodeIn":"10:02:13:05"}' | jq -r .take.id)
# It answers 201 with the take, numbered as the session numbers takes.

curl -X PATCH "https://review.endlesshall.example/api/v1/takes/$TAKE" \
  -H "Authorization: Bearer $HEKATE_TOKEN" -H "Content-Type: application/json" \
  -d '{"lifecycle":"recorded","timecodeOut":"10:04:51:12","falseStarts":1}'
```

- **The recorder's number.** A session numbered by the recorder needs `number` with each start; a number already logged for the track is refused (`409`).
- **One take at a time.** Starting a take while another in the session is still recording is refused (`409`), naming the take that is rolling.
- **Sent again safely.** Give the start an `id` of your own (a UUIDv7) and sending it again, because you could not tell whether it arrived, returns the same take rather than a second one. Give `at` (the moment it happened, by your clock) with a start or a change written while the connection was down.
- **Aborted.** `{"lifecycle":"aborted"}` stops a take that should not count.

Both need `files:write`, and the take's history (`GET /api/v1/takes/{id}/history`) shows each change the script made.

### Comment at a bar

```sh
curl -X POST "https://review.endlesshall.example/api/v1/files/$FILE/comments" \
  -H "Authorization: Bearer $HEKATE_TOKEN" -H "Content-Type: application/json" \
  -d '{"body":"The horns could come up a little at bar 12.","anchor":{"kind":"bar","from":{"bar":12,"beat":1}}}'
```

An anchor is `time` (seconds, or a range), `region` (a rectangle on a page or frame, from 0 to 1) or `bar` (a bar and beat, or a range of bars). Needs `comments`.

### Request an approval, and record a decision

```sh
curl -X POST "https://review.endlesshall.example/api/v1/projects/$PROJECT/reviews" \
  -H "Authorization: Bearer $HEKATE_TOKEN" -H "Content-Type: application/json" \
  -d '{"kind":"approval","items":[{"trackId":"'"$TRACK"'"}],"reviewers":[{"name":"Alex Rivera","email":"alex@endlesshall.example","label":"Conductor"}],"dueAt":"2026-10-30T17:00:00Z"}'

# A reviewer's own token records their decision.
curl -X POST "https://review.endlesshall.example/api/v1/reviews/$REVIEW/decisions" \
  -H "Authorization: Bearer $HEKATE_TOKEN" -H "Content-Type: application/json" \
  -d '{"decision":"approved","note":"Lovely. Ship it."}'
```

Both need `reviews:write`. A decision is recorded as the token's member, and logged.

### Download an original

```sh
curl -X POST "https://review.endlesshall.example/api/v1/files/$FILE/downloads" \
  -H "Authorization: Bearer $HEKATE_TOKEN" -H "Content-Type: application/json" \
  -d '{"kind":"original"}'
# It answers 201 with { "url": "/api/downloads/…" }: fetch that, on the same instance,
# once, within five minutes, with the same token.
curl -o master.wav -H "Authorization: Bearer $HEKATE_TOKEN" "https://review.endlesshall.example$URL"
```

Needs `downloads`. The file is watermarked for the token's member, and the download is in the access log.

## Errors

Every refusal and failure has one shape. Act on the `code`; the `message` is for people.

```json
{ "error": { "code": "insufficient_scope", "message": "That needs the files:write scope (…), which this token does not have." } }
```

A request that did not validate lists what was wrong in `issues`, each with its field's path:

```json
{ "error": { "code": "invalid_request", "message": "name: Give it a name", "issues": [{ "path": "name", "message": "Give it a name" }] } }
```

A failure (a `5xx`) carries a `reference`, such as `HK-7F3A-2C`: quote it to your instance's operator, who can look up exactly what happened. Every answer carries `X-Request-Id`.

| Code | Status | Meaning |
| --- | --- | --- |
| `invalid_request` | 400 | The body, query or path did not validate; `issues` says where and why. |
| `bad_request` | 400 | The request cannot be acted on as it stands. |
| `token_invalid` | 401 | The token is wrong, revoked or expired, or for another workspace. |
| `unauthenticated` | 401 | No token, and no session. |
| `insufficient_scope` | 403 | The token does not hold the scope the call needs; the message names it. |
| `token_not_allowed` | 403 | No token may make this call, whatever it holds. |
| `forbidden` | 403 | The token's member (or a service token's admin reach) may not do this. |
| `workspace_suspended` | 403 | The workspace is suspended. |
| `not_found` | 404 | Nothing there, or nothing the token's member may see, or not part of this version. |
| `conflict` | 409 | The change clashes with the state it would change. |
| `too_large` | 413 | The body is larger than the call takes. |
| `rate_limited` | 429 | Too many calls; `Retry-After` gives the seconds to wait. |
| `internal` | 500 | Hekate failed; quote the `reference` to the instance's operator. |
| `maintenance` | 503 | The instance is under maintenance; uploads wait until it is over. |

Some calls have codes of their own, named in the reference where they apply.

## Limits and the log

Each token may make 600 calls a minute; past that it gets `429` with `Retry-After`. Every call, refused or not, is in the workspace's API log, with the path as asked (version and all), never the query or the body.

## The OpenAPI document

The API is described in OpenAPI 3.1, read from the server's own routes, so it never lists a call the server does not answer or misses one it does. Each instance serves its own, with its address filled in, to anyone:

```
https://review.endlesshall.example/api/openapi.json
https://review.endlesshall.example/api/v1/openapi.json
```

This site publishes the same document at [`openapi.json`](../../openapi.json). Import it into Postman, Insomnia or Bruno, or generate a client from it; its operation ids are stable within a version.
