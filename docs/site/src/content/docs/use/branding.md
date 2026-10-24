---
title: Branding
description: A workspace's own logo and accent colour on its sign-in page, guest pages and email.
---

A workspace can show its own **logo** and **accent colour** to the people it works with: on its sign-in page (at its own address, where the instance gives each workspace one), on every page a guest reviewer sees, and in every email sent for it. Hekate's own mark stays in the app that members use. Owners and admins set both in *Workspace settings*, *Branding*.

- **The logo.** Upload a PNG, JPEG or WebP image of up to 2 MB. Hekate draws it again as a plain PNG of at most 512 pixels a side and keeps only that; SVG is not taken, as it can carry script. It takes Hekate's place at the top of the sign-in page, the guest pages and the email, named for the workspace for anyone whose mail client holds images back. A logo with its own background, or one that reads on dark and light alike, works best, since people see it in both.
- **The accent.** Choose a colour with the swatch or type its six hexadecimal digits. It stands in for Hekate's signal colour (the primary action, the playhead, the marks on a timeline) on those pages, and colours the action in email. It must read on the dark ground at 4.5:1 (WCAG AA); a colour too dark to read there is refused, saying how far short it falls. Light themes take a darker cut of it, worked out for you, that reads there at 4.5:1 too. Someone who has chosen one of the other palettes in *Appearance* keeps its own colours.
- **Back to Hekate's.** *Remove* takes the logo away, and *Use the signal* the accent.

Every change is in the workspace's access log.

## For operators

The logo is the one stored object anyone may fetch without signing in: a sign-in page and a mail client show it before anyone has a session. It is served at an address that names the workspace and changes with every new logo, only as the PNG Hekate drew, and with headers that let nothing in it run. Like every object it is encrypted at rest with its own key, and it counts towards the workspace's storage quota. See [the security model](../../security/model/) for the detail.
