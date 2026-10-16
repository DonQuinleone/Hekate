---
title: Storage
description: Local disk, S3 and S3-compatible services, several at once.
---

Files can live in several named backends at once: a local directory and an S3 bucket, say. Each stored file records which backend holds it, so adding a backend or changing the default moves nothing and breaks nothing already stored. New files go to `STORAGE_DEFAULT`, unless a workspace's owners choose another backend for their uploads.

```sh
STORAGE_BACKENDS=local,archive
STORAGE_DEFAULT=archive
STORAGE_LOCAL_PATH=/data/storage
STORAGE_ARCHIVE_DRIVER=s3
STORAGE_ARCHIVE_BUCKET=hekate-media
STORAGE_ARCHIVE_ENDPOINT=https://s3.example.com
STORAGE_ARCHIVE_FORCE_PATH_STYLE=true
STORAGE_ARCHIVE_ACCESS_KEY_ID=...
STORAGE_ARCHIVE_SECRET_ACCESS_KEY_FILE=/run/secrets/s3-secret
```

Every setting a backend takes is in [Configuration](../configuration/#storage).

- **Only ciphertext.** Every file is encrypted with its own key before any backend sees it, so a bucket's contents are useless without the database and the master key. Do not make the bucket public; nothing in Hekate needs it to be.
- **Never served directly.** Browsers never fetch from storage: media reaches them only through Hekate's protected delivery (encrypted segments, short-lived signed addresses, a key bound to the session).
- **Checked at start-up.** Hekate writes and reads a test object in each backend before it starts, and will not start with one it cannot reach or write to.
- **Kept tidy.** A daily reconciliation compares each backend with the database: bytes nothing uses are removed once a second run a day later still finds them (or only reported, with `STORAGE_RECONCILE=report`), and files the database records but the storage lacks are reported for a person to look at.
