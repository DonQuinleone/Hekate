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

Members sign in with what their workspace already uses; guests never need an account.

- **Single sign-on:** one identity provider per workspace, by OpenID Connect (with PKCE) or SAML 2.0 (signed assertions required, each accepted once), set by its admins (Settings, Security) on Better Auth's SSO plugin. The person names the workspace; the provider is found by workspace, never by the domain of an address. The first sign-in makes the account and the membership; every sign-in sets the role the groups give (named groups make admins, everyone else is a member, owners stay owners), and is logged. An address that already has an account here is refused rather than linked, so a provider can vouch only for people it brought. Saving an OIDC issuer reads its discovery document once; the server fetches only from public addresses, or from origins the operator lists in `SSO_TRUSTED_ORIGINS` for a provider on a private network. The OIDC client secret is kept in the database as Better Auth needs it to sign in, and never sent back. A workspace can enforce single sign-on: every member route and play link then refuses a member whose session did not come through it (403, `sso_required`); owners keep their password, so a broken provider never locks a workspace out. A second factor the workspace asks for is still asked for, because Hekate cannot see what the provider checked (decision 050).
- **Directory:** LDAP (including Active Directory), per workspace (Settings, Security). The person types the workspace's short name, their directory username and password; Hekate searches as a service account (or anonymously), binds as the person to check the password, and reads their address, name and groups. The first sign-in makes the account and the membership; every sign-in sets the role the groups give (named groups make admins, everyone else is a member, owners stay owners), and is logged. The username is escaped before it enters the search filter (RFC 4515), and wrong passwords are slowed and locked as passwords are. A directory vouches for its own workspace only: an address that already has an account here, not made through that directory, is refused rather than taken over. `ldaps://` verifies the certificate unless an admin turns that off; the service account's password is sealed with the workspace key (AES-256-GCM) and never sent back. The sign-in page offers the directory only while some workspace has one turned on (decision 049).
- **Passkeys and hardware security keys:** WebAuthn passkeys for passwordless sign-in, and hardware security keys such as YubiKeys, for this instance's address only. A key signs in on its own, or confirms a password sign-in where a second factor or a hardware security key is asked for. Five keys per account by default (`MAX_PASSKEYS` raises it), each named, with when it was last used, and individually revocable; adding and removing one is logged. Recovery when every key is lost is the code app's recovery codes, or a new password by email.
- **Passwords:** optional, can be disabled per workspace; always paired with a second factor when policy requires. Twelve characters at least, and checked against known breaches (Have I Been Pwned, sending only the first five characters of a hash; `PASSWORD_LEAK_CHECK=false` turns it off on an instance without internet access).
- **Guessing:** per account, the first four wrong passwords cost nothing; after them each try waits twice as long as the last, up to a minute; ten within a quarter of an hour lock the account for a quarter of an hour, written to the access log of each workspace it belongs to. Attempts are kept under a hash of the address, never the address. A per-address limit also stands in front of every sign-in.
- **Forgotten passwords:** a six-digit code by email, with a link that carries it; both last ten minutes, work once, allow three tries, and are stored hashed. Setting the new password ends every session the account has, and is logged. Asking for a code says the same whether or not the address has an account. Members are never signed in by an emailed link or code (decision 025).
- **Guests:** magic links. A guest receives a single-use, short-lived link by email, scoped to the reviews they are invited to; opening it starts a session bound to that browser. Links last three days unless a workspace admin chooses 14 or 30 (Settings, General; the longer the life, the longer a forwarded or intercepted mail stays useful, so three is the default), are stored only as hashes, and sending a new one revokes the last. The session lasts a fortnight in an httpOnly, SameSite Strict cookie. Links can be re-sent and revoked, and every use is logged. A workspace can also ask for a code (Settings, General, "Guests sign in with"): opening the link then signs no one in, but sends a six-digit code to the address the review was sent to, so a forwarded mail is no use to whoever it was forwarded to. The code lasts ten minutes, allows five tries, is stored only as a hash bound to its link, and another can be sent after half a minute, five in all per link; the link is spent only when the code is right. Each code sent and each failed try (wrong, expired, too many) is in the access log.
- **Second factor:** a code app (TOTP: six digits, every 30 seconds) asked for after the password. Adding one asks for the password again, shows the key as a QR code and as text, and takes effect only once a first code from it is right. Ten recovery codes are issued then and shown once; each works once, and they are stored only as keyed hashes (HMAC-SHA256 with the auth secret), never as codes. The code app's key is stored encrypted with the auth secret. A browser can be trusted for 30 days, so it is not asked there again. Ten wrong codes in a row lock the second step for a quarter of an hour. Removing the factor, or generating new recovery codes (which replace the old), asks for the password; adding, removing and new codes are written to the access log of each workspace the account belongs to.
- **Policy:** per workspace, admins choose whether a second factor is required of nobody, of owners and admins, or of everyone; nobody can require one they do not have themselves. `REQUIRE_SECOND_FACTOR=true` requires it of every account on the instance. Someone who owes one is asked at their next request, wherever they are, and every member route refuses them (403, `second_factor_required`) until they add one; they may still read who they are and switch to another workspace. Operators always need a hardware security key (decision 039). A workspace can also require owners and admins to sign in with a passkey or hardware security key. Each session records how it was signed in (decision 048), and the rule reads the session: someone with a key who signed in with a password is asked to confirm with it, and only someone with no factor is asked to add one. Enforcing single sign-on is the one choice of method so far; choosing each allowed method is not built yet.

## Delivery

### Audio and video

- The media worker produces segmented proxies (HLS with fragmented MP4 segments) for every audio and video file, once the file has been measured. Audio gets a stereo AAC rendition for quick listening, a lossless FLAC rendition at the source's rate, bit depth and channels (up to eight, so 5.1 and 7.1 arrive intact) and, for Dolby Digital and Dolby Digital Plus sources (including E-AC-3 carrying Atmos), the original stream passed through untouched. Video gets an H.264 ladder of up to two rungs at or below the source size.
- ffmpeg packages the renditions in the job's private workspace. Hekate then encrypts each segment and the initialisation section with AES-128-CBC (the HLS `AES-128` method) under a random content key per rendition, with a fresh random IV for every segment, and stores the ciphertext as ordinary encrypted blobs. The content key is stored wrapped by the workspace key, like a data key. Plaintext segments are deleted from the workspace as they are sealed.
- Playback starts with `POST /api/files/:id/playback`, which needs membership of the file's workspace and returns a playlist URL carrying a signed token. The token names one file, is bound to the viewer's sign-in session and expires after four hours. Every playlist, segment and key request needs both the token and that session's cookie, and current membership; a copied URL is useless on its own, and signing out ends it.
- The key endpoint returns the content key only on a valid token and session. Keys are never cached, are limited to 30 requests a minute per session, and every issue is logged (`stream.key`) before the key leaves. Starting playback (`stream.session`) and every segment served (`stream.segment`, with its rendition and index) are logged too, so the log shows which parts of a file reached whom. All playback responses are `no-store` and same-origin.
- The player (hls.js under Hekate's own controls, for audio as well as video) decrypts through Media Source Extensions; Safari on iOS, which lacks them, plays the same encrypted stream natively. The network panel shows only encrypted fragments.
- Waveforms are drawn from precomputed peaks, so the waveform never needs the audio itself. Peaks are each channel's lowest and highest sample over blocks of at least 256 samples, in 8 bits: enough to draw at any zoom, far too little to rebuild audio. They are stored encrypted like everything else and served to members of the file's workspace without a playback token or an access-log entry.
- Loudness and levels are treated in the same way. They are momentary and short-term loudness, each channel's peak and RMS, and the phase correlation of the front pair, one set of numbers every 100 ms. They are measured from the same decode as the peaks, no audio can be rebuilt from them, and they are served like the peaks.
- Spectrograms are treated in the same way. Each channel (and the mid and side of the front pair) has one: the loudest level of every frequency band (about 23 Hz wide up to 24 kHz) over spans of at least 100 ms, in 8 bits, with no phase. A span pools several overlapping analysis windows, so what is stored is not a short-time Fourier transform, and phase-retrieval methods that rebuild audio from one have nothing consistent to work from. That is enough to draw at any colour map, scale and range, but not to rebuild audio. The worker builds them on a separate thread from its own decode of the file in the job's workspace, and their size is bounded however long the file turns out to be.

This is not DRM: a determined person can capture the key from a live session. That capture is tied to their session in the audit log, and the forensic watermark below still identifies them. A pluggable commercial DRM (Widevine, FairPlay, PlayReady) can be added later on the same encrypted segments if a deployment needs it.

### Documents and images

- Scores, PDFs and artwork are rendered on the server into page or image tiles at review resolution. The raw PDF or image is not sent to reviewers.
- Tiles are delivered like segments: signed, short-lived, session-bound.
- Tiles for guests carry a visible watermark burned in on the server.
- Text needed for search or bar mapping is extracted on the server; it is not exposed as a selectable layer to guests.

## Watermarking

### Visible

A per-viewer overlay (name or email, workspace, date) on video, documents and images. For documents and images it is burned into the tiles; for video it is an overlay layer in the player. It deters casual screen capture and makes any captured copy self-identifying.

### Forensic

Invisible marks that survive re-encoding, so a leaked copy can be traced.

- **Streaming (A/B segment marking).** The worker encodes two variants of each segment, A and B, each carrying a different inaudible or invisible mark. Each recipient is served a unique A/B sequence derived from their access identity. A leaked copy of enough consecutive segments reveals the sequence, and so the recipient. This costs two encodes per file, not one per recipient.
- **Downloads.** Each permitted download is generated on demand with a unique embedded payload (for audio, spread-spectrum marking such as `audiowmark`, which is GPL-3.0 and so compatible with the AGPL; for video and images, a forensic mark; for PDFs, a per-recipient visible and invisible mark).
- **Detection.** An owner can upload a suspected leak; Hekate extracts the payload and shows whose access it matches.

## Encryption at rest

Envelope encryption: every stored object (an original or a derivative) has its own random data key; data keys are wrapped by a workspace key, which is wrapped by an instance master key. Storage backends (local disk or S3) only ever hold ciphertext. Rotating the master key re-wraps workspace keys without touching files.

- **Objects** are encrypted with AES-256-GCM in 64 KiB segments, following the STREAM construction (as in Tink and age). Each nonce is a random 7-byte prefix stored in the object's header, the 32-bit segment index and a final-segment flag, so segments cannot be altered, reordered, dropped or truncated undetected. The blob's id is bound as associated data, so ciphertext cannot be moved between objects. Segments make byte ranges cheap: a seek in a long recording decrypts only the segments it touches.
- **Data keys** are wrapped with AES-256-GCM by the workspace key, bound to the blob's id, and stored on the blob row.
- **Workspace keys** (`organisation_keys`) are created on first use, versioned for later rotation, wrapped by the master key and bound to the workspace and version. Unwrapped keys exist only in the server's memory.
- **The master key** comes from `MASTER_KEY` (or `MASTER_KEY_FILE`). Each wrapped workspace key records a one-way fingerprint of the master key that wraps it. At start-up Hekate checks every workspace key against the configured master keys and refuses to start if one cannot be opened, rather than failing on the first read.
- **Rotation:** move the current key to `MASTER_KEYS_PREVIOUS`, set a new `MASTER_KEY` and restart. Hekate re-wraps every workspace key with the new key at start-up; the old key can then be removed. Stored objects are never rewritten.
- **Key management services** (AWS KMS, Vault and so on) can replace the configured master key later behind the same interface.

## Storage reconciliation

A daily job compares every storage backend with the database, one workspace at a time.

- **Orphaned bytes** (objects no blob row accounts for, including those of a deleted workspace) and **unused blobs** (no file, rendition, segment, peak level, loudness series, spectrogram or unfinished upload points at them) are recorded on first sight and removed only when a run at least a day later still finds them. Uploads and jobs in flight are therefore never touched. Each removal is written to the workspace's access log (`storage.remove`).
- **Missing bytes** (a blob row whose object is gone) mean data loss. They are reported (logged, and `storage.missing` in the access log once) and never changed: a person decides.
- `STORAGE_RECONCILE=report` keeps the findings and removes nothing.

## Uploads

Uploads are resumable and never sit on the server as plaintext.

- The browser creates an upload, then sends 8 MiB chunks in any order, three at a time, each with a SHA-256 `Content-Digest`; damaged or failed chunks are re-sent. Choosing the same file again after a dropped connection resumes from the chunks already received.
- Each chunk is encrypted the moment it arrives (128 segments of the format above, under the upload's own data key and nonce prefix) and stored as one part of a multipart upload in the chosen backend. The encrypted chunks join into exactly the object a single stream would have produced.
- Completing an upload creates the blob and the file, records a `file.upload` event, and queues the checksum and probe jobs. The checksum job reads the file back through decryption, which also proves it is intact.
- An upload belongs to the member who started it. Unfinished uploads expire after seven days; an hourly job discards their stored parts.

## Media processing

The media worker runs ffmpeg and ffprobe on uploads, which are untrusted input.

- **No playlists, no network.** Every call allows only the `file` protocol and an allow-list of real media demuxers, so a crafted upload cannot be an HLS playlist, concat list or image sequence that reads other files or reaches the network. Arguments are passed as a list, never through a shell, and file names are prefixed with `file:`.
- **Bounded.** Each run has a time limit, honours cancellation, and caps how much output it keeps.
- **Scratch space.** Media tools need seekable local files, so a job decrypts its input into a private directory (mode 0700) that is removed when the job ends, whether it succeeds or fails. If a worker dies mid-job, the next worker to start removes what it left. The Compose file mounts the scratch space as a tmpfs (`HEKATE_WORK_SIZE`, 8 GB by default), so plaintext never reaches a disk; elsewhere, point `WORK_DIR` at a tmpfs.
- **Tenancy.** Job data carries only a workspace (organisation) id and record ids; workers load everything else themselves, scoped to that workspace.

## Audit

An append-only access log records who accessed what, when, through which review, from which IP address and user agent, and whether it was a stream, a page, a key or a download. Owners can filter it per file, per person and per review.

- **Append-only in the database.** Triggers refuse every update, and every delete or truncate unless the transaction explicitly turns on `hekate.audit_purge`, which only retention and workspace removal do. A bug or a careless query cannot quietly rewrite history.
- **Self-contained records.** Events keep plain ids rather than foreign keys and copy the person's name and email at the time, so the record outlives the files, people and reviews it mentions.
- **Written before access.** Recording is awaited: if an event cannot be written, the key, page or download it describes is not served.
- **Client addresses** come from the socket, or from `X-Forwarded-For` only when `TRUST_PROXY` is set (the Compose file sets it, because Caddy replaces that header with the real client address). A client cannot claim another address otherwise.
- **Reading and export** are for workspace admins and owners: filters by project, file, review, person, action and time, newest first with cursor paging, and a CSV export. Exports are themselves logged, and cells that a spreadsheet would run as formulas are neutralised.

## Settled questions

- Commercial DRM is not needed yet; segments can be repackaged as CENC `cbcs` without re-encoding if it ever is (decision 022).
- Downloads are a per-reviewer permission (none, proxy, original), always watermarked and logged.
