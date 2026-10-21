---
title: Load testing
description: The k6 scenarios, the targets a release must meet, and how to run them against your own hardware.
---

Hekate carries a load test: [k6](https://grafana.com/docs/k6/) scenarios in `load/hekate.js` that drive one instance as a busy studio would, with the targets below as their thresholds. A run fails when any target is missed.

## What it does

It sets up (or signs in to) an instance, makes a project of its own, uploads a minute of audio and waits for it to stream, and asks for a review of it. Then, for two minutes, all at once:

| Scenario | Rate | What each iteration does |
| --- | --- | --- |
| Playback | 2 a second | Starts a stream, reads its playlists, fetches the key and every segment, as a player does. |
| Comments | 5 a second | Posts a comment on the timeline, and reads the comments back. |
| Review | 5 a second | Opens the review page: the review, its file and its comments. |
| Uploads | 12 a minute | Uploads 17 MiB in parts (three), and completes it. |
| Transcodes | 4 in all | Uploads the minute of audio, and times it until it streams. |

`HEKATE_SCALE` multiplies every rate, to find where a bigger machine or more replicas stop meeting the targets.

## Targets

| Measure | Target |
| --- | --- |
| Requests that fail | under 1% |
| Starting a stream | 95% within 1 s |
| A stream key | 95% within 500 ms |
| A segment | 95% within 500 ms |
| Posting and listing comments | 95% within 750 ms |
| The review page's requests | 95% within 1 s |
| An upload's part (8 MiB) | 95% within 2 s |
| Segments served | over 15 a second, the setup included (two streams a second) |
| A minute of audio, uploaded until it streams | 95% within 30 s |
| Transcodes that fail | none |

The figures are for the image on a GitHub-hosted runner (four cores, 16 GB), with PostgreSQL and Caddy on the same machine: a floor, not a measure of what production hardware does. Segments are counted for the whole instance: with several replicas, scale the run with them, so that each still serves this many.

## When it runs

CI runs it against the app image, served as the Compose file serves it, on every release pull request before it merges, and whenever the test itself changes. To run it by hand: Actions, Load test, Run workflow, with a longer duration or a higher scale if you like. The results are kept as the run's `load-test` artefact.

## Running it yourself

Against a test instance only, never one people use: it leaves its project, uploads and comments behind. You need k6 and ffmpeg.

```sh
ffmpeg -f lavfi -i "sine=frequency=220:duration=60" -f lavfi -i "anoisesrc=d=60:a=0.05" \
  -filter_complex "[0][1]amix=inputs=2,aformat=channel_layouts=stereo" -ar 48000 -c:a flac media.flac

k6 run -e HEKATE_URL=https://review.example.test -e HEKATE_MEDIA=media.flac \
  -e HEKATE_EMAIL=… -e HEKATE_PASSWORD=… load/hekate.js
```

| Variable | Default | What it says |
| --- | --- | --- |
| `HEKATE_URL` | `https://localhost` | The instance. |
| `HEKATE_SETUP_CODE` | | Set up a fresh instance first, with this setup code and the account below. |
| `HEKATE_EMAIL`, `HEKATE_PASSWORD` | the visual suite's owner | The account to sign in as: a member who may start projects. |
| `HEKATE_MEDIA` | `media.flac` | The audio to upload and stream. |
| `HEKATE_DURATION` | `2m` | How long each scenario runs. |
| `HEKATE_SCALE` | `1` | Multiplies every arrival rate. |
| `HEKATE_SESSIONS` | `6` | Sessions to spread the load over. |
| `HEKATE_INSECURE` | | `1` accepts a certificate the machine does not trust, such as Caddy's own for `localhost`. |

The test signs in once for each session and shares them, as Hekate allows ten sign-ins a minute from one address and each session thirty stream keys a minute. So playback can start at most half as many streams a second as there are sessions: raise `HEKATE_SESSIONS` (up to ten) along with `HEKATE_SCALE`, or the key limit refuses streams and the run fails. Past five streams a second, run k6 from several addresses.
