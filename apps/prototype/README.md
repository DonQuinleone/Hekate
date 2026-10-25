# Hekate prototype

A clickable prototype of the whole application on fictional sample data: no backend, no API calls, every screen and state reachable from a switcher in the corner that sets who you are (owner, admin, each project role, approval and feedback reviewers, a guest, a group member, the instance admin) and how the screen is shown (desktop or phone, shadows on or off, and the empty, loading, processing, failed, refused, expired and long states).

```sh
pnpm --filter @hekate/prototype dev      # http://localhost:5174
pnpm --filter @hekate/prototype build    # dist/, then artifact/index.html folded into one file
pnpm --filter @hekate/prototype screens  # docs/screens/*.png, every screen at 1440 by 900
```

`docs/screens` holds a capture of every screen and major state, named in the inventory's last column. `scripts/screens.mjs` keeps the one list of them (the address, the role, the switcher's state and any clicks), builds the prototype into a temporary folder, serves it on a free port and captures each with Playwright, which it takes from wherever Node finds it rather than as a dependency. Name screens to take only those (`screens review files`); `-- --list` names them all; `-- --dev` serves the sources instead of a build. Take them again when a screen changes.

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

## Round seven

Sign-in: the lockup larger and centred with the tagline "Listen, decide, release."; passkey (its own glyph) and single sign-on side by side; single sign-on asks for the organisation, or reads it from the organisation's subdomain; the second factor's code boxes fill the width; no emailed sign-in link for members (magic links are for guests). The installer's steps show green ticks for what is done, a larger orange dot for now and white dots for what is to come. The instance: organisations and their people are one screen (a searchable, filterable list at the left, tabs for the chosen organisation: overview, members, projects, storage and quota, settings, keys); operators have their own page; logs are tabbed tables (audit, authentication, API, email, webhooks); system health carries gauges, graphs and the storage backends; system information holds the version, build, update channel, available patches to apply in place and the way back; debug tools centre on error references (look one up for who, where, the request, the job and the stack) and what failed today. A second factor can be required by an organisation or for the whole instance. Accounts get API tokens and connected apps; organisations register OAuth clients and hold service tokens. The prototype's own corner control has an "Open a screen" picker for the arrival pages and every installer step. The sidebar's switch and the centred hints work inside the shadow root (the transform variables now have a floor).

## Round eight

The organisations screen of the instance is a full-height split: the searchable, filterable list at the left runs the height of the pane like the secondary nav, the chosen organisation's tabs at the right. The lockup's mark starts on the wordmark's cap line and ends on its baseline, and the wordmark sits a touch quieter. Billing and support are modules: the instance has Billing (revenue, trials, overdue, plans, every organisation's plan and invoice, the provider and dunning) and Support (tickets across organisations with a reply box, canned replies and a status page); an organisation has Billing (its plan, usage, card, details, invoices, change plan) and Support (ask for help with the error reference, its tickets, the guide, status and who runs the instance); each organisation also has a Billing tab on the instance side.

## Round nine

Organisations are called workspaces in every piece of copy (the identifiers stay). A "?" to the left of the bell offers the documentation (`HEKATE_DOCS_URL`, docs.hekate.studio by default), your tickets and a new ticket. The workspace's Support page is its ticket list; a new ticket shows the deflection first (search the documentation, the three commonest answers, the status page), then a form with subject, type, severity (Low and Normal on every plan; High, Urgent and Emergency unlock with the plan), message and attachments; the reference is generated. Tickets are threads and open in a modal; on the instance side the modal also carries who asked (with a jump to their account), the workspace, the error reference and the severity. Instance Billing has tabs for plans, promo codes, gateways (with dunning, currency and trial rules) and reports; Logs gained a Gateway tab. Billing and support are modules set in the environment (`HEKATE_BILLING`, `HEKATE_SUPPORT`), off by default, listed under the instance's Settings; the prototype runs with both on. System health has larger gauges and sparklines on their own ground, each named by its Prometheus metric, with a catalogue of everything exported. Switches are a plain pill with the knob positioned rather than translated; the secondary nav keeps its place on scroll; the fingerprint sparkles, very slightly.
