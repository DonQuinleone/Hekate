---
title: The master key
description: Keeping, rotating and recovering the key that protects every file.
---

Every file Hekate stores is encrypted with its own data key; data keys are wrapped by a key per workspace; workspace keys are wrapped by the master key, `MASTER_KEY`. Storage holds only ciphertext and the database only wrapped keys, so the master key is what turns a copy of both into readable media.

## Keep it

Generate it once (`openssl rand -base64 32`) and store a copy apart from the server and its backups: a password manager, or a sealed envelope. Without it, the media cannot be read by anyone, you included.

The Compose file reads it from `.env`. Where the app runs with Docker secrets instead (Swarm, Kubernetes), `MASTER_KEY_FILE` can name the file that holds it.

## Rotate it

1. Move the current key to `MASTER_KEYS_PREVIOUS`.
2. Set a new `MASTER_KEY`.
3. Restart the app.

At start-up Hekate re-wraps every workspace key with the new master key; no file is rewritten, however much is stored. Once it has started, remove the old key from `MASTER_KEYS_PREVIOUS` and restart again. Keep the old key with the backups taken before the rotation: they need it.

## If a key does not match

Hekate checks every workspace key against the configured master keys at start-up and refuses to start if one cannot be opened, naming the workspace and the key version. That usually means the wrong `MASTER_KEY` for this database, or a rotation with the old key missing from `MASTER_KEYS_PREVIOUS`. After a restore, `backup verify` makes the same check, and reads a sample of files too.
