# Hekate prototype

A clickable prototype of the whole application on fictional sample data: no backend, no API calls, every screen and state reachable from a switcher in the corner that sets who you are (owner, admin, each project role, approval and feedback reviewers, a guest, a group member, the instance admin) and how the screen is shown (desktop or phone, shadows on or off, and the empty, loading, processing, failed, refused, expired and long states).

```sh
pnpm --filter @hekate/prototype dev      # http://localhost:5174
pnpm --filter @hekate/prototype build    # dist/, then artifact/index.html folded into one file
```

The build folds everything into `artifact/index.html` so it can be published as a single page; the app mounts in a shadow root so a host page's stylesheet cannot reach it.

What is here follows `docs/inventory.md`, the approved screen inventory: the shell, the home dashboard and the inbox, reviews with their steps and gate, the request form, the share dialog, the recording page (review and QA) with the score, loops, comparison, takes and comments, projects, the file browser (list, columns and grid), tracks, the board and the calendar, tasks and people, the workflow builder, project settings, triage, version comparison, sessions and takes, video tools, documents, exports, notifications and search, the production tools, organisation settings, security, storage, leak tracing, the access log, operations, the account and the instance.

Everything in `src/data` is invented: Endless Hall Records, the projects Joplin Rags and Opening titles, and four fictional people.

## The workflow model

A workflow is a graph (`src/data/flows.ts`). Its nodes are events (something happens: a version is uploaded, a decision is recorded, a due date passes) and actions (something is done: ask for approval or feedback, assign a task, run the checks, notify, set a status, wait, share, move, finish). Each node exposes outcomes; connectors wire an outcome of one node to the input of another and may carry a condition of their own. A connector that runs back to the left is a loop and needs a way out. Groups frame nodes as a stage.

The rules live in the model, not the canvas: an action never starts a workflow, an event never ends one, an action follows an outcome of an event or another action, a loop needs a stop, and nothing follows a finish. `flowProblems` applies them and the builder shows what it finds on the node, in the inspector and in a count on the canvas.

The builder has three views of the same workflows: basic (each workflow as a list of steps with the fields people change most), advanced (every workflow of the project on one canvas that pans, zooms and takes right-clicks, with an inspector, a node picker, statuses and a walk-through) and code (the workflow as YAML to copy, download and import).

## Navigation

Once a project is open, the sidebar carries its primary navigation with a project switcher at the top of the block; pages with sections (settings, production) use the same secondary list at the left; tabs are kept for a third level. The player keeps its own layout.

## Round six

Members live in organisation settings under Access, and organisation settings are reached from the account menu; neither sits in the sidebar. The instance (the operator's side: overview, organisations, people, queues, logs, storage, debug tools, settings, operations) is the same shell with its own block in the sidebar, reached from the account menu or the fingerprint by the bell. Sign-in offers password, passkey and single sign-on side by side; single sign-on asks for the organisation unless the organisation's own subdomain already says which. The second factor, the forgotten password, the emailed link with its code and the new password are states of the same page (`?view=code|forgot|link|sent|reset|sso`); the installer's steps are addresses too (`?step=1` to `8`). Organisation settings gained the email templates and the brand and design system page, where every reusable component is shown with the rule for using it. In the workflow builder each node family has a shape and a colour, and the code view highlights its YAML.
