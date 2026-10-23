---
title: Workspace subdomains
description: Each workspace at its own name under the instance's address, with one sign-in for all of them.
---

An instance can give each workspace its own address under the instance's: `endless-hall.review.example` beside `review.example`. A workspace's name there is the subdomain it was made with (the instance's **Workspaces**, the workspace, its header). Nothing about a workspace changes: it is the same workspace at a second address. The setting is off until you turn it on, and an instance with one studio needs none of this.

## Turn it on

1. Point a wildcard DNS record, `*.review.example`, at the instance, as well as `review.example` itself.
2. Set `WORKSPACE_SUBDOMAINS=true`, keeping `PUBLIC_URL` at the root's address (`https://review.example`).
3. Give every name a certificate:
   - **Compose:** set `HEKATE_CADDYFILE=Caddyfile.subdomains` in `.env` and restart. Caddy then gets a certificate for each name as it is first opened, through the same HTTP challenge it uses for the root. Before each one it asks the app whether the name is the root's or a workspace's (`/api/tls/ask`), so nobody can make it ask for certificates for names the instance does not serve.
   - **Kubernetes:** set `ingress.wildcard: true`. The chart adds `*.host` to the Ingress and turns `WORKSPACE_SUBDOMAINS` on. The TLS Secret must cover `*.host` too: a wildcard certificate, which cert-manager issues only through a DNS-01 solver, named in the Ingress's annotations.
   - **Another proxy:** pass the `Host` header through unchanged (or set `X-Forwarded-Host`, with `TRUST_PROXY=true`), and give the proxy a wildcard certificate or one per name.

## What changes

| | |
| --- | --- |
| Signing in | Once, at any of the addresses, for every workspace someone belongs to: the session's cookie is the root's, sent to every workspace's host. |
| A workspace's host | Admits only that workspace's members; anyone else is sent to the root, and from there to a workspace of their own. A name that is no workspace's answers nothing. |
| The root | Keeps the instance's pages and the sign-in, which asks which workspace for single sign-on and a directory. A signed-in member opening it is sent to their workspace's host. |
| Single sign-on and directories | At a workspace's host, the sign-in page knows the workspace and goes straight to its identity provider or asks only for the directory's username and password. |
| Passkeys | Bound to the root's name, so a key made at any of the addresses works at all of them. |
| Switching workspace | Goes to the other workspace's host. |
| Links in mail | Still the root's address; they open in the workspace the person is in. |

Names that would stand for the instance itself (`www`, `api`, `mail`, `instance` and a few more) cannot be a workspace's.
