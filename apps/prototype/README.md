# Hekate prototype

A clickable prototype of the whole application on fictional sample data: no backend, no API calls, every screen and state reachable from a switcher in the corner that sets who you are (owner, admin, each project role, approval and feedback reviewers, a guest, a group member, the instance admin) and how the screen is shown (desktop or phone, shadows on or off, and the empty, loading, processing, failed, refused, expired and long states).

```sh
pnpm --filter @hekate/prototype dev      # http://localhost:5174
pnpm --filter @hekate/prototype build    # dist/, then artifact/index.html folded into one file
```

The build folds everything into `artifact/index.html` so it can be published as a single page; the app mounts in a shadow root so a host page's stylesheet cannot reach it.

What is here follows `docs/inventory.md`, the approved screen inventory: the shell and inbox, reviews and the request form, the recording page (review and QA) with the score, loops, comparison, takes and comments, projects, files, tracks and the board, the workflow builder, project settings, triage, version comparison, sessions and takes, video tools, documents, exports, notifications and search, the production tools, organisation settings, security, storage, leak tracing, the access log, operations, the account and the instance.

Everything in `src/data` is invented: Endless Hall Records, the projects Joplin Rags and Opening titles, and four fictional people.
