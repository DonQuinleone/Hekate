# Media security

Material in Hekate is unreleased. It is shared with many people before the public ever hears or sees it. Protecting it is a core requirement, designed in from the start, not a later feature.

Two goals:

1. **Stop casual extraction.** Nobody should be able to open the browser's developer tools and save a usable copy of an audio file, video, score or artwork.
2. **Make leaks attributable.** If something reaches the public, we can tell whose access it came from.

Anything that can be heard or seen can be recorded from the speakers or the screen. Hekate does not pretend otherwise. It removes the easy routes and makes the hard routes traceable.

## Principles

- **Originals never reach a browser by default.** Reviewers get protected derivatives. Downloading an original is a separate permission, and every download is logged and watermarked.
- **No plain media URLs.** There is no URL that returns a whole file to anyone who holds it. Everything goes through short-lived, signed, session-bound delivery.
- **Encrypted at rest.** Stored files are encrypted with a per-file key.
- **Every access is logged.** Keys issued, segments served, pages rendered and downloads, with the person or guest and the review they came through.

## Authentication

Members sign in with what their organisation already uses; guests never need an account.

- **Single sign-on:** OpenID Connect and SAML 2.0, configured per organisation, with just-in-time membership and optional group-to-role mapping. An organisation can require SSO for its members.
- **Directory:** LDAP (including Active Directory) bind authentication for self-hosted installs, with group-to-role mapping.
- **Passkeys and security keys:** WebAuthn passkeys for passwordless sign-in, and hardware security keys such as YubiKeys as a second factor or as the sole factor. Five keys per account by default, a limit the operator can raise, each named and individually revocable, with recovery codes.
- **Passwords:** optional, can be disabled per organisation; always paired with a second factor when policy requires.
- **Guests:** magic links. A guest receives a single-use, short-lived link by email, scoped to the reviews they are invited to; opening it starts a session bound to that browser. Links can be re-sent and revoked, and every use is logged.
- **Policy:** per organisation, owners choose the allowed methods and whether a second factor or a security key is required.

## Delivery

### Audio and video

- The media worker produces segmented proxies (HLS with fragmented MP4 segments) for every audio and video file.
- Segments are encrypted with a per-file content key: AES-128 in the HLS sense, or CENC `cbcs`, so the same segments can later serve a commercial DRM if needed.
- Segment URLs are signed, expire within minutes, and are bound to the viewer's session.
- The key endpoint returns the content key only to an authenticated member or guest whose role or review grants access to that file. Keys are never cached, are rate-limited per session, and every issue is logged.
- The player (Vidstack, with hls.js for audio as well as video) decrypts through Media Source Extensions. The network panel shows only encrypted fragments.
- Waveforms are drawn from precomputed peaks, so the waveform never needs the audio itself.

This is not DRM: a determined person can capture the key from a live session. That capture is tied to their session in the audit log, and the forensic watermark below still identifies them. A pluggable commercial DRM (Widevine, FairPlay, PlayReady) can be added later on the same encrypted segments if a deployment needs it.

### Documents and images

- Scores, PDFs and artwork are rendered on the server into page or image tiles at review resolution. The raw PDF or image is not sent to reviewers.
- Tiles are delivered like segments: signed, short-lived, session-bound.
- Tiles for guests carry a visible watermark burned in on the server.
- Text needed for search or bar mapping is extracted on the server; it is not exposed as a selectable layer to guests.

## Watermarking

### Visible

A per-viewer overlay (name or email, organisation, date) on video, documents and images. For documents and images it is burned into the tiles; for video it is an overlay layer in the player. It deters casual screen capture and makes any captured copy self-identifying.

### Forensic

Invisible marks that survive re-encoding, so a leaked copy can be traced.

- **Streaming (A/B segment marking).** The worker encodes two variants of each segment, A and B, each carrying a different inaudible or invisible mark. Each recipient is served a unique A/B sequence derived from their access identity. A leaked copy of enough consecutive segments reveals the sequence, and so the recipient. This costs two encodes per file, not one per recipient.
- **Downloads.** Each permitted download is generated on demand with a unique embedded payload (for audio, spread-spectrum marking such as `audiowmark`, which is GPL-3.0 and so compatible with the AGPL; for video and images, a forensic mark; for PDFs, a per-recipient visible and invisible mark).
- **Detection.** An owner can upload a suspected leak; Hekate extracts the payload and shows whose access it matches.

## Encryption at rest

Envelope encryption: each file has a random data key; data keys are wrapped by an organisation key, which is wrapped by an instance master key from configuration or a key management service. Storage (local disk or S3) only ever holds ciphertext. Rotating the master key re-wraps organisation keys without touching files.

## Audit

An append-only access log records who accessed what, when, through which review, from which IP address and user agent, and whether it was a stream, a page, a key or a download. Owners can filter it per file, per person and per review.

## Settled questions

- Commercial DRM is not needed yet; encrypted HLS with `cbcs` leaves room for it.
- Downloads are a per-reviewer permission (none, proxy, original), always watermarked and logged.
