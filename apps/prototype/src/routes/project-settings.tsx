import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Icon } from "~/components/icons";
import { usePageHeader } from "~/components/page-header";
import { RolesAndAccess } from "~/components/role-editor";
import { Danger, Row, Section, SettingsLayout, SwitchRow } from "~/components/settings";
import { Dot } from "~/components/status";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import { Input, Select } from "~/components/ui/input";
import { ActionMenu } from "~/components/ui/menu";
import { Switch } from "~/components/ui/toggle";
import {
  categories,
  customRules,
  deliveryProfiles,
  measures,
  type Project,
  type ProjectPermission,
  personById,
  projectById,
  projectPacks,
  type QaRule,
  type QaRuleKind,
  qaRules,
  rulePacks,
  tracks,
  workflows,
} from "~/data";
import { cn } from "~/lib/cn";
import { useViewer } from "~/viewer/context";
import { Refused } from "~/viewer/state-gate";

export { accessAreas, accessOf, toolCopy } from "~/components/role-editor";

const sections = [
  { id: "general", label: "General", group: "Project" },
  { id: "comments", label: "Comments", group: "Project" },
  { id: "roles", label: "Roles and access", group: "Project" },
  { id: "workflow", label: "Workflow", group: "Project" },
  { id: "security", label: "Asset security", group: "Protection" },
  { id: "storage", label: "Storage", group: "Protection" },
  { id: "delivery", label: "Delivery profile", group: "Quality assurance" },
  { id: "qa", label: "QA rules", group: "Quality assurance" },
];

const intros: Record<string, string> = {
  general: "The project's name, what it is for, and what new projects copy from it.",
  comments: "How comments are anchored, categorised and carried between versions.",
  roles:
    "Who may do what, one role at a time: a level in each area, each including the ones before it, and the tools it is given.",
  workflow: "The stages a track goes through, the statuses they set, and who is told.",
  security: "How originals are protected on their way to a browser.",
  storage: "Where this project's files live and how much they take.",
  delivery: "The numbers the checks measure against: loudness, peaks, formats and lengths.",
  qa: "Every check that runs on a file, by category: plain errors always on, delivery checks and your own rules as you choose.",
};

const kindCopy: Record<QaRuleKind, { label: string; hint: string }> = {
  audio: { label: "Audio", hint: "Levels, format and content of stereo files" },
  immersive: { label: "Immersive audio", hint: "Atmos and surround deliverables" },
  video: { label: "Video", hint: "Picture, sync, and the audio in the container" },
  artwork: { label: "Artwork and documents", hint: "Covers, scores and notes" },
  naming: { label: "File names", hint: "What a name must carry" },
  metadata: { label: "Metadata", hint: "What the file says about itself" },
};

export const permissionCopy: Record<ProjectPermission, { label: string; hint: string }> = {
  view: { label: "View", hint: "See the project and play its files" },
  upload: { label: "Upload", hint: "Add files, versions and variants" },
  organise: { label: "Organise", hint: "Folders, renaming, moving, tags" },
  comment: { label: "Comment", hint: "Write and reply" },
  request_reviews: { label: "Request reviews", hint: "Approval, feedback and shares" },
  manage_reviewers: {
    label: "Manage reviewers",
    hint: "Invite guests, adjust permissions, revoke",
  },
  triage: { label: "Triage", hint: "Categorise, defer, assign, carry, resolve anyone's comments" },
  decide: { label: "Decide", hint: "Approve or request changes when asked" },
  edit_workflows: { label: "Edit workflows", hint: "Stages, statuses and upload rules" },
  manage_roles: { label: "Manage roles", hint: "Roles, their permissions and who has them" },
  delete: { label: "Delete", hint: "Files, versions and the project" },
};

const severityLabel: Record<QaRule["severity"], string> = {
  fail: "Issue",
  warn: "Warning",
  info: "Advisory",
};

/** One rule in a category: on or off, how hard it bites, whether it runs on upload. Dense on purpose. */
function RuleRow({
  rule,
  fixed = false,
  tag,
}: {
  rule: QaRule;
  fixed?: boolean;
  /** Where the rule came from, when it is not built in. */
  tag?: string;
}) {
  const [on, setOn] = useState(rule.on);
  const [upload, setUpload] = useState(rule.onUpload);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-2">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-[13px]">
          <span className={cn("truncate", on ? "text-ink" : "text-ink-3")}>{rule.name}</span>
          {tag && (
            <span className="shrink-0 rounded-chip border border-line px-1.5 text-[11px] text-ink-3">
              {tag}
            </span>
          )}
        </div>
        {rule.hint && <div className="truncate text-[12px] text-ink-3">{rule.hint}</div>}
      </div>
      <div className="flex items-center gap-3">
        <Select
          defaultValue={rule.severity}
          aria-label={`Severity of ${rule.name}`}
          className="h-7 w-28 text-[12px]"
          disabled={!on}
        >
          {(Object.keys(severityLabel) as QaRule["severity"][]).map((sv) => (
            <option key={sv} value={sv}>
              {severityLabel[sv]}
            </option>
          ))}
        </Select>
        <label
          className={cn("flex items-center gap-1.5 text-[12px]", on ? "text-ink-2" : "text-ink-3")}
        >
          <input
            type="checkbox"
            checked={upload}
            disabled={!on}
            onChange={(e) => setUpload(e.target.checked)}
          />
          On upload
        </label>
        {fixed ? (
          <span className="w-9 text-right text-[12px] text-ink-3">always</span>
        ) : (
          <Switch label={rule.name} checked={on} onChange={setOn} />
        )}
      </div>
    </div>
  );
}

function ProfileEditor({ onClose }: { onClose: () => void }) {
  return (
    <Dialog
      title="Custom delivery profile"
      description="What the checks measure against. Every project in the workspace can choose it."
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={onClose}>
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-4 @md/app:grid-cols-2">
        <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
          Name
          <Input defaultValue="Custom" />
        </label>
        <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
          Loudness target
          <span className="flex items-center gap-2">
            <Input defaultValue="−16" className="w-24" />
            <span className="text-ink-3">LUFS, ±</span>
            <Input defaultValue="2" className="w-16" />
          </span>
        </label>
        <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
          True peak ceiling
          <span className="flex items-center gap-2">
            <Input defaultValue="−2.0" className="w-24" />
            <span className="text-ink-3">dBTP</span>
          </span>
        </label>
        <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
          Sample rates
          <Input defaultValue="96 kHz" />
        </label>
        <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
          Bit depth
          <Select defaultValue="24">
            <option value="16">16-bit</option>
            <option value="24">24-bit</option>
            <option value="32">32-bit float</option>
          </Select>
        </label>
        <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
          Layout
          <Select defaultValue="any">
            <option value="stereo">Stereo</option>
            <option value="surround">5.1</option>
            <option value="atmos">Atmos</option>
            <option value="any">Any</option>
          </Select>
        </label>
      </div>
    </Dialog>
  );
}

/** Whom new comments are for: nobody, a role or a member of the project (#499). */
function AssigneeSelect({ project, inherits }: { project: Project; inherits?: string }) {
  return (
    <Select
      defaultValue={inherits ? "" : "nobody"}
      aria-label="Assign new comments to"
      className="w-full @3xl/app:w-56"
    >
      {inherits && <option value="">{inherits}</option>}
      <option value="nobody">Nobody</option>
      <optgroup label="Whoever holds the role">
        {project.roles.map((r) => (
          <option key={r.id} value={`role:${r.id}`}>
            {r.name}
          </option>
        ))}
      </optgroup>
      <optgroup label="Members">
        {project.members.map((m) => (
          <option key={m.personId} value={`member:${m.personId}`}>
            {personById(m.personId).name}
          </option>
        ))}
      </optgroup>
    </Select>
  );
}

export function ProjectSettingsPage({ project, section }: { project: Project; section: string }) {
  const viewer = useViewer();
  const navigate = useNavigate();
  const [profileOpen, setProfileOpen] = useState(false);
  const [ruleOpen, setRuleOpen] = useState(false);
  const [packsOn, setPacksOn] = useState<Set<string>>(new Set(projectPacks[project.id] ?? []));
  const [confirm, setConfirm] = useState<"archive" | "delete" | "move" | null>(null);
  const canRoles = viewer.can(project.id, "manage_roles");
  const canWorkflows = viewer.can(project.id, "edit_workflows");
  const workflow = workflows.find((w) => w.id === project.workflowId);
  usePageHeader({
    crumbs: [{ label: project.name, to: `/projects/${project.id}` }],
    title: "Settings",
  });
  const sec =
    section === "tools" ? "roles" : sections.some((s) => s.id === section) ? section : "general";
  return (
    <SettingsLayout
      title={sections.find((x) => x.id === sec)?.label ?? "Settings"}
      intro={intros[sec]}
      sections={sections}
      current={sec}
      base="/projects/$projectId/$view"
      param="section"
      search
    >
      {sec === "general" && (
        <>
          <Section title="Project">
            <Row name="Name">
              <Input defaultValue={project.name} className="w-64" />
            </Row>
            <Row
              name="Profile"
              hint="Only decides which tools appear; files of any kind are welcome in any project."
            >
              <Select defaultValue={project.profile} className="w-40">
                <option value="music">Music</option>
                <option value="video">Video</option>
                <option value="general">General</option>
              </Select>
            </Row>
            <Row name="Description">
              <Input defaultValue={project.description} className="w-full @3xl/app:w-80" />
            </Row>
          </Section>
          <Section title="Templates">
            <Row
              name="Save as a template"
              hint="Roles, categories, delivery profile, QA rules and version checks, without the files."
            >
              <Button variant="secondary" size="md">
                Save template…
              </Button>
            </Row>
            <Row
              name="Solo recital"
              hint="From Joplin Rags · 6 roles · 5 categories · saved by Alex Rivera"
            >
              <ActionMenu
                label="Solo recital"
                actions={[{ label: "Remove template", danger: true, onSelect: () => {} }]}
              />
            </Row>
          </Section>
          <Danger>
            <Row
              name="Archive this project"
              hint="Read-only for everyone; reviews close; it leaves the lists."
            >
              <Button variant="secondary" size="md" onClick={() => setConfirm("archive")}>
                Archive
              </Button>
            </Row>
            <Row
              name="Delete this project"
              hint="Files, comments and reviews go with it. Needs the delete permission and a second owner's confirmation."
            >
              <Button
                variant="secondary"
                size="md"
                className="text-signal"
                onClick={() => setConfirm("delete")}
              >
                Delete…
              </Button>
            </Row>
            <Row
              name="Move to another workspace"
              hint="Everything in it goes, files re-encrypted. Needs a second member here and the other workspace to agree, unless you run both."
            >
              <Button variant="secondary" size="md" onClick={() => setConfirm("move")}>
                Move…
              </Button>
            </Row>
          </Danger>
        </>
      )}
      {sec === "delivery" && (
        <>
          <Section
            title="Delivery profile"
            intro="What QA measures against. The project default applies to every track and file unless one overrides it."
          >
            <Row name="Project default">
              <Select defaultValue={project.deliveryProfile ?? ""} className="w-56">
                <option value="">Workspace default</option>
                {deliveryProfiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
              <Button variant="ghost" size="md" onClick={() => setProfileOpen(true)}>
                Custom…
              </Button>
            </Row>
            {deliveryProfiles
              .filter((p) => p.id === (project.deliveryProfile ?? "streaming"))
              .map((p) => (
                <Row
                  key={p.id}
                  name={p.name}
                  hint={[
                    p.loudness !== null
                      ? `${p.loudness} LUFS ±${p.tolerance}`
                      : "no loudness target",
                    `${p.truePeak} dBTP`,
                    p.rates.map((r) => `${r / 1000} kHz`).join(", "),
                    p.bitDepth ? `${p.bitDepth}-bit` : "any depth",
                    p.layout,
                    p.lossless ? "lossless" : "lossy allowed",
                  ].join(" · ")}
                />
              ))}
          </Section>
          <Section title="Overrides" intro="Tracks that measure against a different profile.">
            {tracks
              .filter((t) => t.projectId === project.id)
              .map((t) => (
                <Row
                  key={t.id}
                  name={
                    <Link
                      to="/tracks/$trackId"
                      params={{ trackId: t.id }}
                      className="hover:text-signal"
                    >
                      {t.name}
                    </Link>
                  }
                >
                  <Select defaultValue={t.deliveryProfile ?? ""} className="w-56">
                    <option value="">Project default</option>
                    {deliveryProfiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </Select>
                </Row>
              ))}
          </Section>
        </>
      )}
      {sec === "comments" && (
        <>
          <Section
            title="References"
            intro="What reviewers can type beside a comment, as they read it from the score or the document. Never derived from the time; never on the scrub bar. Each can also be switched per track."
          >
            <SwitchRow name="Pages" checked={project.references.page} />
            <SwitchRow
              name="Bars"
              hint="A bar or a range, such as 9–12; 0 for an upbeat"
              checked={project.references.bar}
            />
            <SwitchRow name="Beats" checked={project.references.beat} />
          </Section>
          {tracks.some((t) => t.projectId === project.id) && (
            <Section title="Overrides" intro="Tracks whose comments name other references.">
              {tracks
                .filter((t) => t.projectId === project.id)
                .map((t) => (
                  <Row
                    key={t.id}
                    name={
                      <Link
                        to="/tracks/$trackId"
                        params={{ trackId: t.id }}
                        className="hover:text-signal"
                      >
                        {t.name}
                      </Link>
                    }
                  >
                    <Select defaultValue="" className="w-56">
                      <option value="">Project default</option>
                      <option value="none">None</option>
                      <option value="bars">Bars</option>
                      <option value="bars-beats">Bars and beats</option>
                      <option value="pages-bars">Pages and bars</option>
                      <option value="pages-bars-beats">Pages, bars and beats</option>
                    </Select>
                  </Row>
                ))}
            </Section>
          )}
          <Section
            title="Categories"
            intro="Producers mark comments so each kind goes where it belongs."
            action={
              <Button variant="secondary" size="md">
                <Icon name="plus" size={14} />
                Category
              </Button>
            }
          >
            {categories.map((c, i) => (
              <Row
                key={c.id}
                name={
                  <span className="flex items-center gap-2">
                    <span
                      className="size-2.5 rounded-full"
                      style={{ background: `oklch(0.7 0.12 ${(i * 70) % 360})` }}
                    />
                    {c.name}
                    <kbd className="rounded-chip border border-line-strong px-1 text-[11px] text-ink-3">
                      {String(i + 1)}
                    </kbd>
                  </span>
                }
                hint={
                  c.handling === "deferred"
                    ? `Deferred to the ${c.stage} stage`
                    : c.handling === "information"
                      ? "Information only: no action expected"
                      : "Handled on this version"
                }
              >
                <ActionMenu
                  always
                  label={c.name}
                  actions={[
                    { label: "Rename", onSelect: () => {} },
                    { label: "Change handling…", onSelect: () => {} },
                    "divider",
                    { label: "Delete", danger: true, onSelect: () => {} },
                  ]}
                />
              </Row>
            ))}
          </Section>
          <Section title="Versions">
            <SwitchRow
              name="Carried comments shown on the new version"
              hint="Open comments travel to the next version with their anchors mapped; off keeps them until triage shows them."
              checked={project.carriedCommentsShown}
            />
            <Row
              name="Normalised playback"
              hint="Level-matched to the delivery profile's target, so a louder version is not mistaken for a better one."
            >
              <Select defaultValue={project.normalisation} className="w-40">
                <option value="off">Off</option>
                <option value="optional">Each person's choice</option>
                <option value="forced">Always</option>
              </Select>
            </Row>
          </Section>
          <Section
            title="Normalised playback by track"
            intro="Tracks with a normalisation of their own, in place of the project's: a set heard together can play as one."
          >
            {tracks
              .filter((t) => t.projectId === project.id)
              .map((t) => (
                <Row
                  key={t.id}
                  name={
                    <Link
                      to="/tracks/$trackId"
                      params={{ trackId: t.id }}
                      className="hover:text-signal"
                    >
                      {t.name}
                    </Link>
                  }
                >
                  <Select defaultValue="" className="w-56">
                    <option value="">Project default</option>
                    <option value="off">Off</option>
                    <option value="optional">Each person's choice</option>
                    <option value="forced">Always</option>
                  </Select>
                </Row>
              ))}
          </Section>
        </>
      )}
      {sec === "roles" && <RolesAndAccess project={project} canRoles={canRoles} />}
      {sec === "workflow" && (
        <>
          <Section
            title="Workflow"
            intro="The stages a track goes through, the statuses they set, and who is asked at each."
            action={
              canWorkflows ? (
                <Button
                  variant="primary"
                  size="md"
                  onClick={() =>
                    navigate({
                      to: "/projects/$projectId/$view",
                      params: { projectId: project.id, view: "workflow" },
                    })
                  }
                >
                  Open the builder
                </Button>
              ) : undefined
            }
          >
            <Row
              name={workflow?.name ?? "No workflow"}
              hint={
                workflow
                  ? `${workflow.stages.length} stages · ${workflow.statuses.length} statuses`
                  : "Tracks have no stages until one is set"
              }
            >
              <span className="flex items-center gap-2 text-[13px] text-ink-2">
                <Dot state="approved" /> Active
              </span>
            </Row>
            {workflow?.stages.map((s, i) => (
              <Row
                key={s.id}
                name={
                  <span className="flex items-center gap-2">
                    <span className="tabular w-5 text-ink-3">{i + 1}</span>
                    {s.name}
                  </span>
                }
                hint={`${s.kind === "approval" ? "Approval" : s.kind === "feedback" ? "Feedback" : "Task"} · ${s.participants} · sets ${s.status}`}
              />
            ))}
          </Section>
          <Section title="Notifications" intro="Who is told when a stage or status is entered.">
            <SwitchRow name="Participants, in the app" checked />
            <SwitchRow name="Participants, by mail" checked />
            <SwitchRow name="Everyone in the project, on a status change" checked={false} />
          </Section>
          <Section
            title="New comments"
            intro="Whom a comment is given to as it is opened, unless the stage the track waits at says otherwise. They are told, as of comments sent to them."
          >
            <Row
              name="Assign new comments to"
              hint="A member, or whoever has held a role the longest"
            >
              <AssigneeSelect project={project} />
            </Row>
          </Section>
          <Section title="Overrides" intro="Tracks whose new comments go to someone else.">
            {tracks
              .filter((t) => t.projectId === project.id)
              .map((t) => (
                <Row key={t.id} name={t.name}>
                  <AssigneeSelect project={project} inherits="Project default" />
                </Row>
              ))}
          </Section>
          <Section
            title="Checks on a new version"
            intro="A version that fails is refused, saying why; whoever edits the workflow can let it through, on the record."
          >
            <SwitchRow
              name="True peak under the delivery profile's ceiling"
              hint="−1 dBTP for Streaming"
              checked
            />
            <SwitchRow
              name="An edit decision list with every version"
              hint="The EDL the version was made from, uploaded beside it: it must hold edits, and end within the version."
              checked={false}
            />
          </Section>
        </>
      )}
      {sec === "qa" && (
        <>
          <Section
            title="Checks"
            intro="Errors are always on: choose how hard each bites and whether it runs as the file arrives. Delivery checks and your own rules sit in the same categories and switch off individually."
            action={
              <span className="flex items-center gap-3">
                <label className="flex items-center gap-2 text-[13px] text-ink-2">
                  Delivery checks
                  <Switch
                    label="Distributor delivery checks"
                    checked={packsOn.has("delivery")}
                    onChange={(v) => {
                      const next = new Set(packsOn);
                      if (v) next.add("delivery");
                      else next.delete("delivery");
                      setPacksOn(next);
                    }}
                  />
                </label>
                <Button variant="secondary" size="md" onClick={() => setRuleOpen(true)}>
                  <Icon name="plus" size={14} />
                  Rule
                </Button>
              </span>
            }
          >
            {(Object.keys(kindCopy) as QaRuleKind[]).map((kind) => {
              const errors = qaRules.filter((r) => r.kind === kind);
              const delivery = packsOn.has("delivery")
                ? rulePacks.flatMap((pk) => pk.rules).filter((r) => r.kind === kind)
                : [];
              const custom = customRules.filter((r) => r.kind === kind);
              const count = errors.length + delivery.length + custom.length;
              if (count === 0) return null;
              return (
                <div key={kind} className="flex flex-col divide-y divide-line/60">
                  <div className="flex items-baseline gap-2 bg-raised/30 px-4 py-1.5">
                    <span className="text-[13px] font-medium text-ink">{kindCopy[kind].label}</span>
                    <span className="text-[12px] text-ink-3">{kindCopy[kind].hint}</span>
                    <span className="tabular ml-auto text-[12px] text-ink-3">{count}</span>
                  </div>
                  {errors.map((r) => (
                    <RuleRow key={r.id} rule={r} fixed />
                  ))}
                  {delivery.map((r) => (
                    <RuleRow key={r.id} rule={r} tag="delivery" />
                  ))}
                  {custom.map((r) => (
                    <RuleRow key={r.id} rule={r} tag={`${r.measure} ${r.operator} ${r.value}`} />
                  ))}
                </div>
              );
            })}
          </Section>
          <p className="text-[13px] text-ink-3">
            {packsOn.has("delivery")
              ? "Delivery checks follow what distributors and aggregators refuse or query at delivery."
              : `${rulePacks.flatMap((pk) => pk.rules).length} delivery checks are off: switch them on when this project delivers through a distributor.`}{" "}
            Rules marked “on upload” also run as a file arrives, from the workflow's{" "}
            <Link
              to="/projects/$projectId/$view"
              params={{ projectId: project.id, view: "workflow" }}
              className="text-ink-2 hover:text-ink"
            >
              upload event
            </Link>
            , where their action (warn or refuse) is set.
          </p>
          {ruleOpen && (
            <Dialog
              title="New rule"
              description="Measured on every file the rule applies to; the finding carries your name for it."
              onClose={() => setRuleOpen(false)}
              footer={
                <>
                  <Button variant="ghost" onClick={() => setRuleOpen(false)}>
                    Cancel
                  </Button>
                  <Button variant="primary" onClick={() => setRuleOpen(false)}>
                    Add rule
                  </Button>
                </>
              }
            >
              <div className="flex flex-col gap-4">
                <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
                  Name
                  <Input placeholder="Masters at 96 kHz" autoFocus />
                </label>
                <div className="grid gap-3 @md/app:grid-cols-[minmax(0,1fr)_140px_minmax(0,1fr)]">
                  <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
                    Measure
                    <Select defaultValue="Sample rate">
                      {measures.map((m) => (
                        <option key={m}>{m}</option>
                      ))}
                    </Select>
                  </label>
                  <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
                    Comparison
                    <Select defaultValue="is">
                      {["is", "is not", "at least", "at most", "between", "one of", "matches"].map(
                        (o) => (
                          <option key={o}>{o}</option>
                        ),
                      )}
                    </Select>
                  </label>
                  <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
                    Value
                    <Input placeholder="96 kHz" />
                  </label>
                </div>
                <div className="grid gap-3 @md/app:grid-cols-3">
                  <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
                    Applies to
                    <Select defaultValue="audio">
                      <option value="audio">Audio</option>
                      <option value="immersive">Immersive audio</option>
                      <option value="video">Video</option>
                      <option value="artwork">Artwork and documents</option>
                      <option value="any">Every file</option>
                    </Select>
                  </label>
                  <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
                    When it fails
                    <Select defaultValue="warn">
                      <option value="fail">An issue</option>
                      <option value="warn">A warning</option>
                      <option value="info">An advisory</option>
                    </Select>
                  </label>
                  <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
                    On upload
                    <Select defaultValue="warn">
                      <option value="off">Not checked</option>
                      <option value="warn">Warn</option>
                      <option value="refuse">Refuse the file</option>
                    </Select>
                  </label>
                </div>
                <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
                  What the finding says
                  <Input placeholder="The label archives at 96 kHz; re-export from the mix." />
                </label>
              </div>
            </Dialog>
          )}
        </>
      )}
      {sec === "security" && (
        <>
          <Section
            title="Visible watermark"
            intro="Burned into pages and video for guests, and for members when you choose."
          >
            <Row name="Scope">
              <Select defaultValue="guests" className="w-56">
                <option value="off">Off</option>
                <option value="guests">Guests only</option>
                <option value="everyone">Everyone</option>
              </Select>
            </Row>
            <Row name="Position and opacity">
              <Select defaultValue="br" className="w-40">
                <option value="br">Bottom right</option>
                <option value="c">Centre</option>
                <option value="tile">Tiled</option>
              </Select>
              <Input defaultValue="35%" className="w-20" />
            </Row>
            <Row name="Preview" stacked>
              <div className="relative aspect-video w-full max-w-[420px] overflow-hidden rounded-panel bg-sunken">
                <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_40%_30%,#3a2a24,#0b0b0d_70%)]" />
                <span className="absolute right-3 bottom-2 text-[11px] tracking-[0.1em] text-paper/40">
                  Mira Solberg · Endless Hall Records · 14 Oct 2026
                </span>
              </div>
            </Row>
          </Section>
          <Section
            title="Forensic marking"
            intro="An inaudible and invisible mark per recipient on every stream and download, so a leak can be traced to the person who received it."
          >
            <SwitchRow name="Audio streams" checked />
            <SwitchRow name="Video streams" checked />
            <SwitchRow name="Downloads" checked />
          </Section>
          <Section
            title="Downloads and deletion"
            intro="Each narrows what the roles and reviews allow. A download is still made for the person who asked, marked and logged."
          >
            <Row name="Who may download">
              <Select defaultValue="roles" className="w-64">
                <option value="roles">Roles that allow downloads</option>
                <option value="nobody">Nobody</option>
              </Select>
            </Row>
            <Row
              name="Originals"
              hint="A download gives the proxy unless the person may have the original."
            >
              <Select defaultValue="roles" className="w-64">
                <option value="roles">Roles that allow originals</option>
                <option value="owners">Workspace owners and admins</option>
                <option value="never">Never</option>
              </Select>
            </Row>
            <Row name="Who may delete">
              <Select defaultValue="roles" className="w-64">
                <option value="roles">Roles that allow deleting</option>
                <option value="owners">Workspace owners and admins</option>
              </Select>
            </Row>
            <SwitchRow
              name="Files in a review cannot be deleted"
              hint="Open or closed, so what reviewers were asked about stays on the record."
              checked
            />
          </Section>
        </>
      )}
      {sec === "storage" && (
        <Section
          title="Storage"
          intro="Where new files go. Existing files stay where they are. Everything is encrypted at rest with a key per file."
        >
          <Row name="Backend for new files">
            <Select defaultValue="s3" className="w-64">
              <option value="local">Local disk (default)</option>
              <option value="s3">Hetzner Object Storage (S3)</option>
            </Select>
          </Row>
          <Row name="Used by this project" hint="Originals, renditions, pages and peaks">
            <span className="tabular text-[14px] text-ink">14.2 GB</span>
          </Row>
        </Section>
      )}
      {profileOpen && <ProfileEditor onClose={() => setProfileOpen(false)} />}
      {confirm === "move" && (
        <Dialog
          title={`Move ${project.name} to another workspace?`}
          description="Its files, comments, reviews and their sign-offs, roles and workflows go with it, its files re-encrypted under that workspace's key. People who are not members there lose their place in it; guests, tags and delivery profiles are matched there or copied."
          onClose={() => setConfirm(null)}
          width="sm"
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirm(null)}>
                Keep it here
              </Button>
              <Button variant="secondary" className="text-signal" onClick={() => setConfirm(null)}>
                Ask to move
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-3">
            <Select aria-label="Workspace" defaultValue="east">
              <option value="east">Endless Hall Records East</option>
              <option value="address">Another workspace, by its address</option>
            </Select>
            <p className="m-0 text-[13px] text-ink-2">
              A second member here approves it, and an owner or admin of that workspace accepts it,
              before anything moves. It lapses after a week.
            </p>
            <Input placeholder={`Type ${project.name} to confirm`} />
            <Input type="password" placeholder="Password" />
          </div>
        </Dialog>
      )}
      {(confirm === "archive" || confirm === "delete") && (
        <Dialog
          title={confirm === "archive" ? "Archive this project?" : "Delete this project?"}
          onClose={() => setConfirm(null)}
          width="sm"
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirm(null)}>
                Keep it
              </Button>
              <Button variant="primary" onClick={() => setConfirm(null)}>
                {confirm === "archive" ? "Archive" : "Delete"}
              </Button>
            </>
          }
        >
          <p className="text-[14px] text-ink-2">
            {confirm === "archive"
              ? "The project becomes read-only, its open reviews close, and it leaves everyone's lists. It can be unarchived."
              : "Everything in it is removed after seven days. Type the project's name to confirm."}
          </p>
          {confirm === "delete" && <Input placeholder={project.name} className={cn("mt-3")} />}
        </Dialog>
      )}
    </SettingsLayout>
  );
}

export function ProjectSettingsRoute({
  projectId,
  section,
}: {
  projectId: string;
  section?: string;
}) {
  const viewer = useViewer();
  const project = projectById(projectId);
  if (!project || !viewer.canSee(projectId)) return <Refused />;
  if (!viewer.can(projectId, "manage_roles") && !viewer.can(projectId, "edit_workflows"))
    return (
      <Refused
        title="Not for your role"
        text="Project settings are for whoever manages roles or workflows here."
      />
    );
  return <ProjectSettingsPage project={project} section={section ?? "general"} />;
}
