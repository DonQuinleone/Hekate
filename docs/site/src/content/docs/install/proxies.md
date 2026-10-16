---
title: Reverse proxies
description: Running Hekate behind nginx, Traefik or another proxy instead of Caddy.
---

The Compose file puts Caddy in front of Hekate: it obtains certificates, serves HTTPS and passes requests to the app. To use another proxy, remove the `caddy` service, publish the app's port 3000 to your proxy, and make sure the proxy does what Caddy does.

- **Pass the client's address** in `X-Forwarded-For`, and set `TRUST_PROXY=true`, so rate limits, the access log and sign-in lockouts see real addresses. Set it only behind a proxy: a client reaching the app directly could otherwise claim any address.
- **Set the address people open.** Sign-in callbacks, passkeys and the links in emails are bound to it. With the Compose file, set `HEKATE_DOMAIN` in `.env`: the file builds `PUBLIC_URL` from it as `https://` and the domain, and a `PUBLIC_URL` in `.env` would be overridden. Elsewhere, set `PUBLIC_URL` itself, with `https://`.
- **Allow large bodies.** Uploads arrive in chunks of 8 MB; let the proxy pass bodies of at least 16 MB, and do not buffer them to disk.
- **Add HSTS** (`Strict-Transport-Security: max-age=31536000`) at the proxy, which terminates TLS. Hekate sets every other security header itself, including the Content Security Policy, so leave those as the app sends them.
- **Do not cache** anything under `/api/`. Media responses already say `no-store`; a cache that ignored it would keep unreleased material where Hekate cannot protect it.

An nginx server block, as a starting point:

```nginx
server {
  listen 443 ssl;
  server_name review.example.com;
  client_max_body_size 16m;
  proxy_request_buffering off;
  add_header Strict-Transport-Security "max-age=31536000" always;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```
