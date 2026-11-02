import { Link, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { Icon } from "~/components/icons";
import { usePageHeader } from "~/components/page-header";
import { RolesAndAccess } from "~/components/role-editor";
import {
  Danger,
  FoldingSection,
  Row,
  Section,
  SettingsLayout,
  SwitchRow,
} from "~/components/settings";
import { Dot } from "~/components/status";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import { Input, Select, Textarea } from "~/components/ui/input";
import { ActionMenu } from "~/components/ui/menu";
import { Switch } from "~/components/ui/toggle";
import {
  categories,
  customRules,
  deliveryProfiles,
  files,
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
  type Track,
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
  { id: "watermarks", label: "Watermarks and downloads", group: "Protection" },
  { id: "storage", label: "Storage", group: "Protection" },
  { id: "delivery", label: "Delivery profile", group: "Quality assurance" },
  { id: "qa", label: "QA rules", group: "Quality assurance" },
];

const intros: Record<string, string> = {
  general: "The project's name, what it is for, and what new projects copy from it.",
  comments:
    "What comments may refer to, how they are categorised and carried between versions, and whom new ones are given to.",
  roles:
    "Who may do what, one role at a time: a level in each area, each including the ones before it, and the tools it is given.",
  workflow: "Its workflows, and who they tell.",
  watermarks:
    "How each kind of file names whoever has it, and who may take files away or delete them.",
  storage:
    "Where new files go. Existing files stay where they are. Everything is encrypted at rest with a key per file.",
  delivery:
    "What QA measures every recording against, and plays it back level with: loudness, peaks, formats and lengths. The project default applies to every track and file unless one has its own.",
  qa: "Every check that runs on a file, by category, and what a new version must pass before it lands.",
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

const categoryTones = [
  "bg-category-1",
  "bg-category-2",
  "bg-category-3",
  "bg-category-4",
  "bg-category-5",
  "bg-category-6",
];

const severityLabel: Record<QaRule["severity"], string> = {
  fail: "Issue",
  warn: "Warning",
  info: "Advisory",
};

/**
 * One rule in a category (#584): its name and what it checks, whole at every width; how hard it
 * bites; On upload where it can be known as a version arrives (the true peak, and your own
 * rules); on or off, or always on with a fixed switch. On a phone the controls take a second line.
 */
function RuleRow({ rule, fixed = false }: { rule: QaRule; fixed?: boolean }) {
  const [on, setOn] = useState(rule.on);
  const [upload, setUpload] = useState(rule.onUpload);
  const uploadable = rule.id === "tp" || rule.id.startsWith("custom-");
  return (
    <div className="flex flex-col gap-2 px-4 py-2.5 @3xl/app:flex-row @3xl/app:items-center @3xl/app:gap-3">
      <div className="min-w-0 flex-1">
        <div className={cn("text-[13px]", on ? "text-ink" : "text-ink-3")}>{rule.name}</div>
        {rule.hint && <div className="text-[12px] text-ink-3">{rule.hint}</div>}
      </div>
      <div className="flex items-center gap-3">
        <Select
          defaultValue={fixed ? "" : rule.severity}
          aria-label={`Severity of ${rule.name}`}
          className="h-7 w-40 text-[12px]"
          disabled={!on}
        >
          {fixed && <option value="">Default (as found)</option>}
          {(Object.keys(severityLabel) as QaRule["severity"][]).map((sv) => (
            <option key={sv} value={sv}>
              {severityLabel[sv]}
            </option>
          ))}
        </Select>
        {uploadable ? (
          <button
            type="button"
            aria-pressed={upload && on}
            aria-label={`${rule.name}: checked on upload`}
            title="Checked as a new version arrives: one that fails is held back, saying why."
            disabled={!on}
            onClick={() => setUpload(!upload)}
            className={cn(
              "inline-flex h-7 w-[6.5rem] shrink-0 items-center justify-center gap-1 rounded-chip border text-[13px] transition-colors disabled:opacity-50",
              upload && on
                ? "border-edge-strong bg-raised text-ink"
                : "border-line text-ink-3 hover:border-edge hover:text-ink",
            )}
          >
            {upload && on && <Icon name="check" size={13} />}
            On upload
          </button>
        ) : (
          <span aria-hidden="true" className="hidden w-[6.5rem] shrink-0 @3xl/app:block" />
        )}
        <span
          className="ml-auto @3xl/app:ml-0"
          title={fixed ? "Always runs: a plain error is never switched off." : undefined}
        >
          <Switch
            label={fixed ? `${rule.name} always runs` : rule.name}
            checked={fixed || on}
            onChange={fixed ? () => {} : setOn}
            disabled={fixed}
          />
        </span>
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

/**
 * The tracks that differ from the project in one setting (#671), listed only where they do,
 * under a heading naming the setting, with "Override for a track…" to give another its own.
 */
function TrackOverrides({
  title,
  tracks: listed,
  control,
}: {
  title: string;
  tracks: Track[];
  control: (track: Track) => ReactNode;
}) {
  return (
    <Section
      title={title}
      intro={listed.length === 0 ? "Every track follows the project's choice." : undefined}
      action={
        <Button variant="secondary" size="md">
          Override for a track…
        </Button>
      }
    >
      {listed.length > 0
        ? listed.map((t) => (
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
              {control(t)}
            </Row>
          ))
        : null}
    </Section>
  );
}

type ProtectionSection = "audio" | "watermark";

/**
 * Watermarks and downloads (#509, #580): the inaudible mark on recordings' downloads, and the
 * visible watermark, one setting for video, pictures and documents, so one section with its
 * fields labelled and its preview beside them (#674). The profile decides which comes first
 * (music: audio; video and general: the watermark), and the watermark folds to its summary in a
 * project with no video, pictures or documents. The product orders them with
 * `protectionLayout` in packages/shared.
 */
function Watermarks({ project }: { project: Project }) {
  const order: ProtectionSection[] =
    project.profile === "music" ? ["audio", "watermark"] : ["watermark", "audio"];
  const holds = new Set(files.filter((f) => f.projectId === project.id).map((f) => f.kind));
  const [open, setOpen] = useState(
    project.profile !== "music" ||
      holds.has("video") ||
      holds.has("document") ||
      holds.has("image"),
  );
  const sections: Record<ProtectionSection, ReactNode> = {
    audio: (
      <Section
        key="audio"
        title="Audio"
        intro="An inaudible mark, made for each person, in every download of a recording."
      >
        <SwitchRow
          name="Forensic mark on downloads"
          hint="If a copy leaks, a workspace owner traces it under Leak tracing to whoever received it."
          checked
        />
      </Section>
    ),
    watermark: (
      <FoldingSection
        key="watermark"
        id="visible-watermark"
        title="Visible watermark"
        intro="Over video in the player, and burned into each page, picture and download, in the viewer's name."
        summary="Guests only · Bottom right · 35%"
        open={open}
        onToggle={() => setOpen(!open)}
      >
        <div className="grid gap-5 px-4 py-4 @3xl/app:grid-cols-[minmax(0,1fr)_200px] @3xl/app:gap-6">
          <div className="grid min-w-0 content-start gap-4 @xl/app:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_6rem]">
            <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
              Who it marks
              <Select defaultValue="guests">
                <option value="off">Off</option>
                <option value="guests">Guests only</option>
                <option value="everyone">Everyone</option>
              </Select>
            </label>
            <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
              Position
              <Select defaultValue="br">
                <option value="br">Bottom right</option>
                <option value="c">Centre</option>
                <option value="tile">Tiled</option>
              </Select>
            </label>
            <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
              Strength
              <Input defaultValue="35%" className="w-24" />
            </label>
            <p className="text-[12px] text-ink-3 @xl/app:col-span-3">
              Strength runs from 10 to 80 per cent: faint enough to watch through.
            </p>
          </div>
          <figure className="m-0 flex min-w-0 flex-col gap-1.5">
            <figcaption className="text-[13px] text-ink-2">Preview</figcaption>
            <div className="relative aspect-video w-full max-w-[320px] overflow-hidden rounded-panel bg-sunken">
              <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_40%_30%,#3a2a24,#0b0b0d_70%)]" />
              <span className="absolute right-2 bottom-1.5 text-[10px] tracking-[0.1em] text-paper/40">
                Mira Solberg · Endless Hall Records
              </span>
            </div>
          </figure>
        </div>
      </FoldingSection>
    ),
  };
  return (
    <>
      {order.map((s) => sections[s])}
      <Section
        title="Downloads and deletion"
        intro="Each narrows what the roles and reviews allow; a download is still marked and logged."
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
  );
}

export function ProjectSettingsPage({ project, section }: { project: Project; section: string }) {
  const viewer = useViewer();
  const navigate = useNavigate();
  const [profileOpen, setProfileOpen] = useState(false);
  const [ruleOpen, setRuleOpen] = useState(false);
  const [packsOn, setPacksOn] = useState<Set<string>>(new Set(projectPacks[project.id] ?? []));
  const [opened, setOpened] = useState<Set<QaRuleKind>>(new Set(["naming", "metadata"]));
  const [folded, setFolded] = useState<Set<QaRuleKind>>(new Set());
  const [confirm, setConfirm] = useState<"archive" | "delete" | "move" | null>(null);
  const canRoles = viewer.can(project.id, "manage_roles");
  const canWorkflows = viewer.can(project.id, "edit_workflows");
  const workflow = workflows.find((w) => w.id === project.workflowId);
  usePageHeader({
    crumbs: [{ label: project.name, to: `/projects/${project.id}` }],
    title: "Settings",
  });
  const sec =
    section === "tools"
      ? "roles"
      : // Its old name (#580) still opens it.
        section === "security"
        ? "watermarks"
        : sections.some((s) => s.id === section)
          ? section
          : "general";
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
              <Input defaultValue={project.name} className="w-full @3xl/app:w-72" />
            </Row>
            <Row
              name="Profile"
              hint="Only decides which tools appear; files of any kind are welcome in any project."
            >
              <Select defaultValue={project.profile} className="w-full @3xl/app:w-72">
                <option value="music">Music</option>
                <option value="video">Video</option>
                <option value="general">General</option>
              </Select>
            </Row>
            <Row name="Description">
              <Textarea
                defaultValue={project.description}
                rows={2}
                className="w-full @3xl/app:w-72"
              />
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
          {/* One intro, the page's own; Custom… is the select's last choice (#672). */}
          <Section>
            <Row name="Project default">
              <Select
                defaultValue={project.deliveryProfile ?? ""}
                className="w-56"
                onChange={(e) => {
                  if (e.target.value === "custom") setProfileOpen(true);
                }}
              >
                <option value="">Workspace default</option>
                {deliveryProfiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
                <option value="custom">Custom…</option>
              </Select>
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
          <TrackOverrides
            title="Tracks with their own profile"
            tracks={tracks
              .filter((t) => t.projectId === project.id)
              .filter((t) => t.deliveryProfile)}
            control={(t) => (
              <Select defaultValue={t.deliveryProfile ?? ""} className="w-56">
                <option value="">Project default</option>
                {deliveryProfiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            )}
          />
          {/* A listening setting, matched to this profile's target (moved from Comments, #672). */}
          <Section title="Playback">
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
          <TrackOverrides
            title="Tracks with their own normalisation"
            tracks={[]}
            control={() => (
              <Select defaultValue="" className="w-56">
                <option value="">Project default</option>
                <option value="off">Off</option>
                <option value="optional">Each person's choice</option>
                <option value="forced">Always</option>
              </Select>
            )}
          />
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
          <TrackOverrides
            title="Tracks with their own references"
            tracks={[]}
            control={() => (
              <Select defaultValue="" className="w-56">
                <option value="">Project default</option>
                <option value="none">None</option>
                <option value="bars">Bars</option>
                <option value="bars-beats">Bars and beats</option>
                <option value="pages-bars">Pages and bars</option>
                <option value="pages-bars-beats">Pages, bars and beats</option>
              </Select>
            )}
          />
          <Section
            title="Categories"
            intro="Producers mark comments so each kind goes where it belongs."
            action={
              <Button variant="secondary" size="md">
                <Icon name="plus" size={14} />
                New category
              </Button>
            }
          >
            {categories.map((c, i) => (
              // Each in its colour, by its place among the categories (#706): the bar a thread
              // carries at its left edge.
              <div key={c.id} className="relative">
                <span
                  aria-hidden="true"
                  className={cn(
                    "absolute inset-y-2.5 left-0 w-[3px] rounded-r-full",
                    categoryTones[i % categoryTones.length],
                  )}
                />
                <Row
                  name={
                    <span className="flex items-center gap-2">
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
                      { label: "Delete…", danger: true, onSelect: () => {} },
                    ]}
                  />
                </Row>
              </div>
            ))}
          </Section>
          <Section title="Versions">
            <SwitchRow
              name="Carried comments shown on the new version"
              hint="Open comments travel to the next version with their anchors mapped; off keeps them until triage shows them."
              checked={project.carriedCommentsShown}
            />
          </Section>
          {/* Whom new comments are for (moved here from Workflow, #672). */}
          <Section
            title="New comments"
            intro="Whom a comment is given to as it is opened, unless the step the track waits at says otherwise. They are told, as of comments sent to them."
          >
            <Row
              name="Assign new comments to"
              hint="A member, or whoever has held a role the longest"
            >
              <AssigneeSelect project={project} />
            </Row>
          </Section>
          <TrackOverrides
            title="Tracks whose new comments go to someone else"
            tracks={[]}
            control={() => <AssigneeSelect project={project} inherits="Project default" />}
          />
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
        </>
      )}
      {sec === "qa" && (
        <>
          <Section
            title="Rules"
            intro="Plain errors always run: choose how hard each bites. Delivery checks and your own rules switch off one by one."
            action={
              <Button variant="secondary" size="md" onClick={() => setRuleOpen(true)}>
                <Icon name="plus" size={14} />
                New rule
              </Button>
            }
          >
            <SwitchRow
              name="Delivery checks"
              hint="What distributors and aggregators refuse or query at delivery, against the delivery profile."
              checked={packsOn.has("delivery")}
              onChange={(v) => {
                const next = new Set(packsOn);
                if (v) next.add("delivery");
                else next.delete("delivery");
                setPacksOn(next);
              }}
            />
            {(Object.keys(kindCopy) as QaRuleKind[]).map((kind) => {
              const errors = qaRules.filter((r) => r.kind === kind);
              const delivery = packsOn.has("delivery")
                ? rulePacks.flatMap((pk) => pk.rules).filter((r) => r.kind === kind)
                : [];
              const custom = customRules.filter((r) => r.kind === kind);
              const count = errors.length + delivery.length + custom.length;
              if (count === 0) return null;
              // The kinds the profile does not use are folded (#584), a click away.
              const open = folded.has(kind)
                ? false
                : opened.has(kind) ||
                  (project.profile === "video" ? kind === "video" : kind === "audio");
              return (
                <div key={kind} className="flex flex-col">
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => {
                      const next = new Set(folded);
                      const was = new Set(opened);
                      if (open) {
                        next.add(kind);
                        was.delete(kind);
                      } else {
                        next.delete(kind);
                        was.add(kind);
                      }
                      setFolded(next);
                      setOpened(was);
                    }}
                    className="flex items-baseline gap-2 bg-raised/30 px-4 py-1.5 text-left hover:bg-raised/60"
                  >
                    <Icon
                      name="chevronRight"
                      size={12}
                      className={cn(
                        "shrink-0 self-center text-ink-3 transition-transform",
                        open && "rotate-90",
                      )}
                    />
                    <span className="text-[13px] font-medium text-ink">{kindCopy[kind].label}</span>
                    <span className="hidden text-[12px] text-ink-3 @3xl/app:inline">
                      {kindCopy[kind].hint}
                    </span>
                    <span className="tabular ml-auto text-[12px] text-ink-3">{count}</span>
                  </button>
                  {open && (
                    <div className="flex flex-col divide-y divide-line/60">
                      {errors.map((r) => (
                        <RuleRow key={r.id} rule={r} fixed={r.id !== "tp"} />
                      ))}
                      {delivery.length > 0 && (
                        <>
                          <div className="px-4 pt-2.5 pb-0.5 text-[12px] text-ink-3">Delivery</div>
                          {delivery.map((r) => (
                            <RuleRow key={r.id} rule={r} />
                          ))}
                        </>
                      )}
                      {custom.length > 0 && (
                        <>
                          <div className="px-4 pt-2.5 pb-0.5 text-[12px] text-ink-3">
                            Your rules
                          </div>
                          {custom.map((r) => (
                            <RuleRow
                              key={r.id}
                              rule={{ ...r, hint: `${r.measure} ${r.operator} ${r.value}` }}
                            />
                          ))}
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </Section>
          {/* What a new version must pass (moved here from Workflow, #672). */}
          <Section
            title="Checks on a new version"
            intro="A version whose files fail a rule marked On upload is refused, saying why; whoever edits the workflow can let it through, on the record. The other rules are measured once a file has landed."
          >
            <SwitchRow
              name="An edit decision list with every version"
              hint="The EDL the version was made from, uploaded beside it: it must hold edits, and end within the version."
              checked={false}
            />
          </Section>
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
      {sec === "watermarks" && <Watermarks project={project} />}
      {sec === "storage" && (
        <Section>
          <Row name="Where new files are stored">
            <Select defaultValue="s3" className="w-64">
              <option value="">As the workspace: Instance storage</option>
              <option value="local">Instance storage</option>
              <option value="s3">Your S3 bucket</option>
            </Select>
          </Row>
          <Row name="Used by this project" hint="Originals, proxies, rendered pages and waveforms">
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
              <Button variant="secondary" onClick={() => setConfirm(null)}>
                Cancel
              </Button>
              <Button variant="danger" onClick={() => setConfirm(null)}>
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
              <Button variant="secondary" onClick={() => setConfirm(null)}>
                Cancel
              </Button>
              <Button
                variant={confirm === "archive" ? "primary" : "danger"}
                onClick={() => setConfirm(null)}
              >
                {confirm === "archive" ? "Archive" : "Delete project"}
              </Button>
            </>
          }
        >
          <p className="text-[14px] text-ink-2">
            {confirm === "archive"
              ? "The project becomes read-only, its open reviews close, and it leaves everyone's lists. It can be unarchived."
              : "Once you confirm, it is archived, and everything in it is removed seven days later; until then it can be kept."}
          </p>
          {/* The same proof as moving it (#676): its name and the password. */}
          {confirm === "delete" && (
            <div className="mt-3 flex flex-col gap-3">
              <Input placeholder={`Type ${project.name} to confirm`} />
              <Input type="password" placeholder="Password" />
            </div>
          )}
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
