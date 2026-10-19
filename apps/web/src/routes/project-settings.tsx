import {
  type CategoryHandling,
  categoryHandlings,
  customRef,
  defaultReferences,
  defaultWatermark,
  formatBytes,
  handlingWords,
  type NormalisationMode,
  normalisationModes,
  normalisationWords,
  type ProfileRef,
  type ProjectPermission,
  type ProjectProfile,
  profileFor,
  profiles,
  referenceSetOf,
  referenceSets,
  type WatermarkPosition,
  type WatermarkScope,
  type WatermarkSettings,
  type WorkflowSummary,
  watermarkPositions,
  watermarkPositionWords,
  watermarkScopes,
  watermarkScopeWords,
  watermarkText,
} from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useState } from "react";
import {
  formatDb,
  ProfileEditor,
  ProfileOptions,
  profileSummary,
  useWorkspaceAdmin,
} from "~/components/delivery-profiles";
import { Empty } from "~/components/empty";
import { Icon } from "~/components/icons";
import { Page } from "~/components/page";
import { VideoMark } from "~/components/player";
import { ProjectRoles } from "~/components/project-access";
import { TransferProject } from "~/components/project-transfer";
import { QaRules } from "~/components/qa-rules";
import { Danger, Row, Section, SettingsLayout, SwitchRow } from "~/components/settings";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import { Field } from "~/components/ui/field";
import { Input, Select } from "~/components/ui/input";
import { ActionMenu } from "~/components/ui/menu";
import { formatDates } from "~/lib/locale";
import {
  type CommentCategory,
  categoriesQuery,
  customProfilesQuery,
  meQuery,
  type Project,
  projectStorageQuery,
  projectTracksQuery,
  projectWorkflowsQuery,
  templatesQuery,
  useArchiveProject,
  useCategoryMutations,
  useProjectCan,
  useProjectDeletion,
  useProjectStorage,
  useTemplateMutations,
  useTrackDeliveryProfile,
  useTrackNormalisation,
  useTrackReferences,
  useUpdateProject,
  workspaceSettingsQuery,
} from "~/lib/queries";
import { basicSteps } from "~/lib/workflow-nodes";
import { ProjectFrame } from "~/routes/project";

/** The project's settings, grouped as in the prototype; more sections arrive with their issues. */
const sections = [
  {
    id: "general",
    label: "General",
    group: "Project",
    intro: "The project's name, what it is for, and which tools it shows.",
  },
  {
    id: "comments",
    label: "Comments",
    group: "Project",
    intro: "What comments may refer to, and how they are categorised and carried between versions.",
  },
  {
    id: "roles",
    label: "Roles and access",
    group: "Project",
    intro: "Who may do what: the roles, and how far each one reaches.",
  },
  {
    id: "workflow",
    label: "Workflow",
    group: "Project",
    intro: "What a new version must pass before it lands.",
  },
  {
    id: "security",
    label: "Asset security",
    group: "Protection",
    intro:
      "How what people see carries their name, so a capture says whose it was. Downloads are always marked for the person who asked.",
  },
  {
    id: "storage",
    label: "Storage",
    group: "Protection",
    intro:
      "Where new files go. Existing files stay where they are. Everything is encrypted at rest with a key per file.",
  },
  {
    id: "delivery",
    label: "Delivery profile",
    group: "Quality assurance",
    intro: "The numbers the checks measure against: loudness, peaks and formats.",
  },
  {
    id: "qa",
    label: "QA rules",
    group: "Quality assurance",
    intro:
      "Every check that runs on a recording, by category: plain errors always on, delivery checks and your own rules as you choose.",
  },
] as const;
export type ProjectSettingsSection = (typeof sections)[number]["id"];
export const projectSettingsSections = sections.map((s) => s.id);

/** Whoever edits the project, manages its people or edits its workflow has its settings. */
export const mayOpenSettings = (can: (permission: ProjectPermission) => boolean) =>
  can("edit_project") || can("manage_roles") || can("edit_workflows");

export function ProjectSettingsPage({
  projectId,
  section = "general",
}: {
  projectId: string;
  section?: ProjectSettingsSection;
}) {
  const can = useProjectCan(projectId);
  // Storage is the workspace's business: its admins see it (#240).
  const admin = useWorkspaceAdmin();
  const shown = sections.filter((s) => s.id !== "storage" || admin);
  const current = shown.find((s) => s.id === section) ?? shown[0] ?? sections[0];
  return (
    <ProjectFrame projectId={projectId} title="Settings">
      {(project) =>
        !mayOpenSettings(can) ? (
          <Page>
            <Empty
              title="Not for your role"
              text="Project settings are for whoever edits the project, manages its people or edits its workflow."
            />
          </Page>
        ) : (
          <SettingsLayout
            sections={shown}
            current={current.id}
            base="/projects/$projectId/settings"
            param="section"
            search
            title={current.label}
            intro={current.intro}
          >
            {current.id === "general" && <General project={project} />}
            {current.id === "comments" && <Comments project={project} />}
            {current.id === "roles" && <ProjectRoles projectId={project.id} />}
            {current.id === "workflow" && <Workflow project={project} />}
            {current.id === "security" && <AssetSecurity project={project} />}
            {current.id === "storage" && <ProjectStorageSection project={project} />}
            {current.id === "delivery" && <Delivery project={project} />}
            {current.id === "qa" && <QaRules project={project} />}
          </SettingsLayout>
        )
      }
    </ProjectFrame>
  );
}

/** A text setting saved when it loses focus, or on Enter; Escape puts it back. */
function SavedInput({
  value,
  label,
  disabled,
  required = false,
  className,
  onSave,
}: {
  value: string;
  label: string;
  disabled: boolean;
  required?: boolean;
  className?: string;
  onSave: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const save = () => {
    const next = draft.trim();
    if (next === value || (required && !next)) setDraft(value);
    else onSave(next);
  };
  return (
    <Input
      key={value}
      value={draft}
      aria-label={label}
      disabled={disabled}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={save}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          setDraft(value);
          event.currentTarget.blur();
        }
      }}
      className={className}
    />
  );
}

/**
 * Saving the project's set-up as a template (#240), and the workspace's templates: each a
 * copy, so changing this project afterwards leaves them as they were.
 */
function Templates({ project, canSave }: { project: Project; canSave: boolean }) {
  const { data: templates = [] } = useQuery(templatesQuery);
  const { save, remove } = useTemplateMutations();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState(project.name);
  if (!canSave && templates.length === 0) return null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate(
      { projectId: project.id, name },
      {
        onSuccess: () => setNaming(false),
      },
    );
  };
  return (
    <Section title="Templates">
      {canSave && (
        <Row
          name="Save as a template"
          hint="Roles, categories, delivery profile, QA rules and version checks, without the files."
        >
          <Button
            variant="secondary"
            size="md"
            onClick={() => {
              save.reset();
              setName(project.name);
              setNaming(true);
            }}
          >
            Save template…
          </Button>
        </Row>
      )}
      {templates.map((t) => (
        <Row
          key={t.id}
          inline
          name={t.name}
          hint={[
            t.fromProject ? `From ${t.fromProject}` : null,
            `${t.roles.length} ${t.roles.length === 1 ? "role" : "roles"}`,
            `${t.categories} ${t.categories === 1 ? "category" : "categories"}`,
            t.createdByName ? `saved by ${t.createdByName}` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        >
          {t.removable && (
            <ActionMenu
              label={t.name}
              always
              actions={[
                { label: "Remove template", danger: true, onSelect: () => remove.mutate(t.id) },
              ]}
            />
          )}
        </Row>
      ))}
      {remove.error && (
        <p role="alert" className="px-4 pb-3 text-[13px] text-signal">
          {remove.error.message}
        </p>
      )}
      {naming && (
        <Dialog
          title="Save as a template"
          description="New projects can start from it. Files, people and reviews stay here."
          onClose={() => setNaming(false)}
          width="sm"
          footer={
            <>
              <Button variant="ghost" onClick={() => setNaming(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                type="submit"
                form="save-template"
                disabled={save.isPending || !name.trim()}
              >
                Save template
              </Button>
            </>
          }
        >
          <form id="save-template" onSubmit={submit} className="flex flex-col gap-3">
            <Field label="Name" error={save.error?.message}>
              <Input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
            </Field>
          </form>
        </Dialog>
      )}
    </Section>
  );
}

function General({ project }: { project: Project }) {
  const can = useProjectCan(project.id);
  const update = useUpdateProject(project.id);
  const archive = useArchiveProject();
  const [confirm, setConfirm] = useState(false);
  const edit = can("edit_project");
  return (
    <>
      <Section title="Project">
        <Row name="Name">
          <SavedInput
            key={project.name}
            value={project.name}
            label="Name"
            required
            disabled={!edit}
            onSave={(name) => update.mutate({ name })}
            className="w-full @3xl/app:w-64"
          />
        </Row>
        <Row
          name="Profile"
          hint="Only decides which tools appear; files of any kind are welcome in any project."
        >
          <Select
            value={project.profile}
            aria-label="Profile"
            disabled={!edit}
            onChange={(event) => update.mutate({ profile: event.target.value as ProjectProfile })}
            className="w-full @3xl/app:w-40"
          >
            {(Object.keys(profiles) as ProjectProfile[]).map((p) => (
              <option key={p} value={p}>
                {profiles[p].label}
              </option>
            ))}
          </Select>
        </Row>
        <Row name="Description">
          <SavedInput
            key={project.description ?? ""}
            value={project.description ?? ""}
            label="Description"
            disabled={!edit}
            onSave={(description) => update.mutate({ description: description || null })}
            className="w-full @3xl/app:w-80"
          />
        </Row>
      </Section>
      {update.error && <p className="-mt-6 text-[13px] text-signal">{update.error.message}</p>}
      <Templates project={project} canSave={edit} />
      {(project.mayArchive || project.deletion?.mayConfirm || project.deletion?.mayCancel) && (
        <Danger>
          {project.mayArchive && !project.archivedAt && (
            <Row
              name="Archive this project"
              hint="Read-only for everyone; its open reviews close; it leaves the lists. Everything is kept, and it can be unarchived."
            >
              <Button variant="secondary" size="md" onClick={() => setConfirm(true)}>
                Archive…
              </Button>
            </Row>
          )}
          <DeleteProject project={project} />
          {!project.archivedAt && !project.deletion && (
            <TransferProject project={project} mayMove={project.mayArchive ?? false} />
          )}
        </Danger>
      )}
      {confirm && (
        <Dialog
          title={`Archive ${project.name}?`}
          description="It becomes read-only for everyone and its open reviews close. Everything is kept."
          onClose={() => setConfirm(false)}
          width="sm"
          footer={
            <>
              <Button variant="ghost" size="md" onClick={() => setConfirm(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                size="md"
                disabled={archive.isPending}
                onClick={() =>
                  archive.mutate(
                    { id: project.id, archive: true },
                    { onSuccess: () => setConfirm(false) },
                  )
                }
              >
                Archive
              </Button>
            </>
          }
        >
          {archive.error && <p className="text-[13px] text-signal">{archive.error.message}</p>}
        </Dialog>
      )}
    </>
  );
}

const momentFormat = formatDates({
  day: "numeric",
  month: "long",
  hour: "2-digit",
  minute: "2-digit",
});

/**
 * Deleting a project (#240): someone whose role may delete it asks; a workspace owner other
 * than them confirms, typing the project's name. It is then archived and goes for good seven
 * days later, unless someone keeps it.
 */
function DeleteProject({ project }: { project: Project }) {
  const deletion = project.deletion ?? null;
  const { request, cancel, confirm } = useProjectDeletion(project.id);
  const [dialog, setDialog] = useState<"ask" | "confirm" | null>(null);
  const [typed, setTyped] = useState("");
  const close = () => {
    setDialog(null);
    setTyped("");
  };
  const error = request.error ?? cancel.error;
  let row: ReactNode;
  if (deletion?.deleteAfter) {
    row = (
      <Row
        name="To be deleted"
        hint={`It goes for good on ${momentFormat.format(new Date(deletion.deleteAfter))}, files, comments and reviews with it. Archived and read-only until then.`}
      >
        {deletion.mayCancel && (
          <Button
            variant="secondary"
            size="md"
            disabled={cancel.isPending}
            onClick={() => cancel.mutate()}
          >
            Keep it
          </Button>
        )}
      </Row>
    );
  } else if (deletion) {
    const status = deletion.mayConfirm
      ? "Confirm it to delete the project."
      : deletion.confirmableAt
        ? `As the only owner, you can confirm it from ${momentFormat.format(new Date(deletion.confirmableAt))}.`
        : "Waiting for a workspace owner to confirm.";
    row = (
      <Row
        name="Deletion asked for"
        hint={`${deletion.requestedBy ?? "Someone"} asked on ${momentFormat.format(new Date(deletion.requestedAt))}. ${status}`}
      >
        <span className="flex gap-2">
          {deletion.mayCancel && (
            <Button
              variant="ghost"
              size="md"
              disabled={cancel.isPending}
              onClick={() => cancel.mutate()}
            >
              Withdraw
            </Button>
          )}
          {deletion.mayConfirm && (
            <Button
              variant="secondary"
              size="md"
              className="text-signal"
              onClick={() => setDialog("confirm")}
            >
              Delete…
            </Button>
          )}
        </span>
      </Row>
    );
  } else if (project.mayArchive) {
    row = (
      <Row
        name="Delete this project"
        hint="Files, comments and reviews go with it. Needs the delete permission and a second owner's confirmation."
      >
        <Button
          variant="secondary"
          size="md"
          className="text-signal"
          onClick={() => setDialog("ask")}
        >
          Delete…
        </Button>
      </Row>
    );
  }
  return (
    <>
      {row}
      {error && <p className="px-4 pb-3 text-[13px] text-signal">{error.message}</p>}
      {dialog === "ask" && (
        <Dialog
          title={`Delete ${project.name}?`}
          description="A workspace owner other than you confirms before anything happens; a workspace with one owner confirms a day later. It is then archived, and everything in it is removed after seven days."
          onClose={close}
          width="sm"
          footer={
            <>
              <Button variant="ghost" size="md" onClick={close}>
                Keep it
              </Button>
              <Button
                variant="primary"
                size="md"
                disabled={request.isPending}
                onClick={() => request.mutate(undefined, { onSuccess: close })}
              >
                Ask to delete
              </Button>
            </>
          }
        >
          {request.error && <p className="text-[13px] text-signal">{request.error.message}</p>}
        </Dialog>
      )}
      {dialog === "confirm" && (
        <Dialog
          title="Delete this project?"
          description="It is archived now, and everything in it is removed after seven days; until then it can be kept. Type the project's name to confirm."
          onClose={close}
          width="sm"
          footer={
            <>
              <Button variant="ghost" size="md" onClick={close}>
                Keep it
              </Button>
              <Button
                variant="primary"
                size="md"
                disabled={confirm.isPending || typed.trim() !== project.name}
                onClick={() => confirm.mutate(undefined, { onSuccess: close })}
              >
                Delete
              </Button>
            </>
          }
        >
          <Field label="Project name" error={confirm.error?.message}>
            <Input
              value={typed}
              placeholder={project.name}
              autoComplete="off"
              onChange={(e) => setTyped(e.target.value)}
            />
          </Field>
        </Dialog>
      )}
    </>
  );
}

/** Where the project's new files go, and how much it keeps (#240). Owners choose. */
function ProjectStorageSection({ project }: { project: Project }) {
  const { data } = useQuery(projectStorageQuery(project.id));
  const { data: me } = useQuery(meQuery);
  const owner = me?.organisations.find((o) => o.id === me.activeOrganisationId)?.role === "owner";
  const choose = useProjectStorage(project.id);
  if (!data) return null;
  return (
    <>
      <Section title="Backend">
        <Row
          name="Backend for new files"
          hint={owner ? undefined : "Only a workspace owner can change it."}
        >
          {owner ? (
            <Select
              aria-label="Backend for new files"
              value={data.backend ?? ""}
              onChange={(e) => choose.mutate(e.target.value || null)}
              className="w-full @3xl/app:w-64"
            >
              <option value="">Workspace default ({data.workspaceBackend})</option>
              {data.available.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </Select>
          ) : (
            <span className="text-[14px] text-ink-2">{data.backend ?? data.workspaceBackend}</span>
          )}
        </Row>
        <Row name="Used by this project" hint="Originals, renditions, pages and peaks">
          <span className="tabular text-[14px] text-ink">{formatBytes(data.bytes)}</span>
        </Row>
      </Section>
      {choose.error && <p className="-mt-6 text-[13px] text-signal">{choose.error.message}</p>}
    </>
  );
}

/**
 * The visible watermark (#31): whom it marks, where and how strongly, with a preview in the
 * viewer's own name. Burned into pages and pictures, laid over video.
 */
function AssetSecurity({ project }: { project: Project }) {
  const can = useProjectCan(project.id);
  const update = useUpdateProject(project.id);
  const { data: me } = useQuery(meQuery);
  const settings = project.watermark ?? defaultWatermark;
  // One change at a time: each sends the whole setting, so a second waits for the first.
  const edit = can("edit_project") && !update.isPending;
  const change = (next: Partial<WatermarkSettings>) =>
    update.mutate({ watermark: { ...settings, ...next } });
  const workspace = me?.organisations.find((o) => o.id === me.activeOrganisationId)?.name ?? "";
  const sample = watermarkText(
    { name: me?.user?.name ?? "", email: me?.user?.email ?? "" },
    workspace,
    new Date(),
  );
  return (
    <>
      <Section
        title="Visible watermark"
        intro="Burned into pages and pictures, and laid over video, for guests, and for members when you choose."
      >
        <Row name="Scope">
          <Select
            value={settings.scope}
            aria-label="Scope"
            disabled={!edit}
            onChange={(e) => change({ scope: e.target.value as WatermarkScope })}
            className="w-full @3xl/app:w-56"
          >
            {watermarkScopes.map((scope) => (
              <option key={scope} value={scope}>
                {watermarkScopeWords[scope]}
              </option>
            ))}
          </Select>
        </Row>
        <Row name="Position and opacity" hint="Opacity from 10 to 80 per cent.">
          <span className="flex gap-2">
            <Select
              value={settings.position}
              aria-label="Position"
              disabled={!edit || settings.scope === "off"}
              onChange={(e) => change({ position: e.target.value as WatermarkPosition })}
              className="w-40"
            >
              {watermarkPositions.map((position) => (
                <option key={position} value={position}>
                  {watermarkPositionWords[position]}
                </option>
              ))}
            </Select>
            <SavedInput
              key={settings.opacity}
              value={`${settings.opacity}%`}
              label="Opacity"
              disabled={!edit || settings.scope === "off"}
              onSave={(typed) => {
                const opacity = Number.parseInt(typed, 10);
                if (Number.isInteger(opacity))
                  change({ opacity: Math.min(80, Math.max(10, opacity)) });
              }}
              className="tabular w-20"
            />
          </span>
        </Row>
        {settings.scope !== "off" && (
          <Row name="Preview" stacked>
            {/* A frame stands in for the picture: dark in either theme, as a video is. */}
            <div
              className="relative aspect-video w-full max-w-[420px] overflow-hidden rounded-panel"
              style={{
                background:
                  "radial-gradient(120% 90% at 30% 20%, var(--hk-cover-video-lit), var(--hk-cover-video-deep) 70%)",
              }}
            >
              <VideoMark
                mark={{ text: sample, position: settings.position, opacity: settings.opacity }}
              />
            </div>
          </Row>
        )}
      </Section>
      {update.error && <p className="-mt-6 text-[13px] text-signal">{update.error.message}</p>}
    </>
  );
}

function Comments({ project }: { project: Project }) {
  const can = useProjectCan(project.id);
  const update = useUpdateProject(project.id);
  // The profile's references until the project chooses its own (#240).
  const references = project.references ?? defaultReferences(project.profile);
  // Tracks may choose their own (#240).
  const { data: tracks } = useQuery(projectTracksQuery(project.id));
  const onTrack = useTrackReferences(project.id);
  const playsTrack = useTrackNormalisation(project.id);
  const { data: categories } = useQuery(categoriesQuery(project.id));
  const { remove } = useCategoryMutations(project.id);
  const [editing, setEditing] = useState<CommentCategory | "new" | null>(null);
  const [deleting, setDeleting] = useState<CommentCategory | null>(null);
  const shape = can("edit_workflows");
  return (
    <>
      <Section
        title="References"
        intro="What reviewers can type beside a comment, as they read it from the score or the document. Never derived from the time; never on the scrub bar. Each track can also have its own."
      >
        <SwitchRow
          name="Pages"
          checked={references.page}
          // One change at a time: each sends all three, so a second waits for the first.
          disabled={!can("edit_project") || update.isPending}
          onChange={(page) => update.mutate({ references: { ...references, page } })}
        />
        <SwitchRow
          name="Bars"
          hint="A bar or a range, such as 9–12; 0 for an upbeat"
          checked={references.bar}
          disabled={!can("edit_project") || update.isPending}
          onChange={(bar) => update.mutate({ references: { ...references, bar } })}
        />
        <SwitchRow
          name="Beats"
          checked={references.beat}
          disabled={!can("edit_project") || update.isPending}
          onChange={(beat) => update.mutate({ references: { ...references, beat } })}
        />
      </Section>
      {onTrack.error && <p className="-mt-6 text-[13px] text-signal">{onTrack.error.message}</p>}
      {tracks && tracks.length > 0 && (
        <Section title="Overrides" intro="Tracks whose comments name other references.">
          {tracks.map((t) => (
            <Row
              key={t.id}
              name={
                <Link
                  to="/tracks/$trackId"
                  params={{ trackId: t.id }}
                  className="transition-colors hover:text-signal"
                >
                  {t.name}
                </Link>
              }
            >
              <Select
                size="sm"
                value={t.commentReferences ? (referenceSetOf(t.commentReferences) ?? "") : ""}
                aria-label={`References of ${t.name}`}
                disabled={!can("edit_project")}
                onChange={(event) =>
                  onTrack.mutate({
                    trackId: t.id,
                    references:
                      referenceSets.find((set) => set.id === event.target.value)?.references ??
                      null,
                  })
                }
                className="w-full @3xl/app:w-56"
              >
                <option value="">Project default</option>
                {referenceSets.map((set) => (
                  <option key={set.id} value={set.id}>
                    {set.label}
                  </option>
                ))}
              </Select>
            </Row>
          ))}
        </Section>
      )}
      <Section
        title="Categories"
        intro="Triage marks comments with a category, so each kind goes where it belongs."
        action={
          shape ? (
            <Button variant="secondary" size="md" onClick={() => setEditing("new")}>
              <Icon name="plus" size={14} />
              Category
            </Button>
          ) : undefined
        }
      >
        {!categories && <Row name="Loading" />}
        {categories?.length === 0 && (
          <Row name="No categories" hint="Comments can still be triaged without one." />
        )}
        {categories?.map((c) => (
          <Row
            key={c.id}
            name={c.name}
            inline
            hint={
              c.handling === "deferred"
                ? `Deferred to the ${c.stage} stage`
                : handlingWords[c.handling]
            }
          >
            {shape && (
              <ActionMenu
                always
                label={c.name}
                actions={[
                  { label: "Rename or change handling…", onSelect: () => setEditing(c) },
                  "divider",
                  { label: "Delete…", danger: true, onSelect: () => setDeleting(c) },
                ]}
              />
            )}
          </Row>
        ))}
      </Section>
      <Section title="Versions">
        <SwitchRow
          name="Carried comments shown on the new version"
          hint="Open comments travel to the next version; off keeps them hidden there until someone shows them."
          checked={project.carriedCommentsShown ?? true}
          disabled={!can("edit_project")}
          onChange={(carriedCommentsShown) => update.mutate({ carriedCommentsShown })}
        />
        <Row
          name="Normalised playback"
          hint="Level-matched to the delivery profile's target, so a louder version is not mistaken for a better one."
        >
          <Select
            value={project.normalisation ?? "off"}
            aria-label="Normalised playback"
            disabled={!can("edit_project")}
            onChange={(event) =>
              update.mutate({ normalisation: event.target.value as NormalisationMode })
            }
            className="w-full @3xl/app:w-48"
          >
            {normalisationModes.map((mode) => (
              <option key={mode} value={mode}>
                {normalisationWords[mode]}
              </option>
            ))}
          </Select>
        </Row>
      </Section>
      {/* A track can play otherwise (#98), as a set heard together might. */}
      {tracks && tracks.length > 0 && (
        <Section
          title="Normalised playback by track"
          intro="Tracks that play otherwise than the project."
        >
          {tracks?.map((t) => (
            <Row
              key={t.id}
              name={
                <Link
                  to="/tracks/$trackId"
                  params={{ trackId: t.id }}
                  className="transition-colors hover:text-signal"
                >
                  {t.name}
                </Link>
              }
            >
              <Select
                size="sm"
                value={t.normalisation ?? ""}
                aria-label={`Normalised playback of ${t.name}`}
                disabled={!can("edit_project") || playsTrack.isPending}
                onChange={(event) =>
                  playsTrack.mutate({
                    trackId: t.id,
                    normalisation: (event.target.value || null) as NormalisationMode | null,
                  })
                }
                className="w-full @3xl/app:w-56"
              >
                <option value="">Project default</option>
                {normalisationModes.map((mode) => (
                  <option key={mode} value={mode}>
                    {normalisationWords[mode]}
                  </option>
                ))}
              </Select>
            </Row>
          ))}
          {playsTrack.error && (
            <p className="m-0 text-[13px] text-signal">{playsTrack.error.message}</p>
          )}
        </Section>
      )}
      {editing && (
        <CategoryDialog
          projectId={project.id}
          category={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
      {deleting && (
        <Dialog
          title={`Delete ${deleting.name}?`}
          description="Its comments keep everything else, without a category."
          onClose={() => setDeleting(null)}
          width="sm"
          footer={
            <>
              <Button variant="ghost" size="md" onClick={() => setDeleting(null)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                size="md"
                disabled={remove.isPending}
                onClick={() => remove.mutate(deleting.id, { onSuccess: () => setDeleting(null) })}
              >
                Delete
              </Button>
            </>
          }
        >
          {remove.error && <p className="text-[13px] text-signal">{remove.error.message}</p>}
        </Dialog>
      )}
    </>
  );
}

/** A new category, or one renamed or handled differently. */
function CategoryDialog({
  projectId,
  category,
  onClose,
}: {
  projectId: string;
  category: CommentCategory | null;
  onClose: () => void;
}) {
  const { create, update } = useCategoryMutations(projectId);
  const [name, setName] = useState(category?.name ?? "");
  const [handling, setHandling] = useState<CategoryHandling>(category?.handling ?? "normal");
  const [stage, setStage] = useState(category?.stage ?? "");
  const saving = category ? update : create;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const input = { name, handling, stage: handling === "deferred" ? stage : null };
    if (category) update.mutate({ id: category.id, ...input }, { onSuccess: onClose });
    else create.mutate(input, { onSuccess: onClose });
  };
  return (
    <Dialog
      title={category ? `Change ${category.name}` : "New category"}
      onClose={onClose}
      width="sm"
    >
      <form onSubmit={submit} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
          Name
          <Input
            value={name}
            required
            maxLength={40}
            onChange={(event) => setName(event.target.value)}
            placeholder="For example Noise"
          />
        </label>
        <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
          Handling
          <Select
            value={handling}
            onChange={(event) => setHandling(event.target.value as CategoryHandling)}
          >
            {categoryHandlings.map((h) => (
              <option key={h} value={h}>
                {handlingWords[h]}
              </option>
            ))}
          </Select>
        </label>
        {handling === "deferred" && (
          <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
            Stage
            <Input
              value={stage}
              required
              maxLength={80}
              onChange={(event) => setStage(event.target.value)}
              placeholder="For example Noise reduction"
            />
          </label>
        )}
        {saving.error && <p className="text-[13px] text-signal">{saving.error.message}</p>}
        <div className="mt-1 flex justify-end gap-2">
          <Button type="button" variant="ghost" size="md" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" size="md" disabled={saving.isPending}>
            {category ? "Save" : "Add category"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** The profile a project measures against unless something nearer chooses, and its name. */
function useProjectProfile(project: Project) {
  const { data: customs = [] } = useQuery(customProfilesQuery);
  const { data: workspace } = useQuery(workspaceSettingsQuery);
  const own = profileFor(project.deliveryProfile, customs);
  const inherited = profileFor(workspace?.deliveryProfile, customs);
  return { customs, own, inherited, effective: own ?? inherited };
}

/** "4 steps": the stages a workflow takes a track through, as its builder counts them. */
const stepsOf = (w: WorkflowSummary) => {
  const n = basicSteps(w.definition).steps.length;
  return `${n} ${n === 1 ? "step" : "steps"}`;
};

function Workflow({ project }: { project: Project }) {
  const can = useProjectCan(project.id);
  const update = useUpdateProject(project.id);
  const edit = can("edit_workflows");
  const { effective } = useProjectProfile(project);
  // Those who may open the builder (decision on #26): who edits workflows, or runs the roles.
  const mayBuild = edit || (can("manage_roles") && can("view_workflows"));
  const { data: workflows } = useQuery({
    ...projectWorkflowsQuery(project.id),
    enabled: mayBuild,
  });
  return (
    <>
      {mayBuild && (
        <Section
          title="Workflows"
          intro="The stages a track goes through as versions arrive, the statuses they set, and who is asked at each."
          action={
            <Button asChild variant="primary" size="md">
              <Link to="/projects/$projectId/workflow" params={{ projectId: project.id }}>
                Open the builder
              </Link>
            </Button>
          }
        >
          {workflows?.length === 0 && (
            <Row
              name="No workflow"
              hint="Tracks have no stages until one is made and switched on."
            />
          )}
          {workflows?.map((w) => (
            <Row
              key={w.id}
              name={w.name}
              hint={`${stepsOf(w)}${
                w.problems.length > 0 ? ` · ${w.problems.length} to look at` : ""
              }${w.trackId ? " · for one track" : ""}`}
              inline
            >
              <span className="text-[13px] text-ink-2">{w.active ? "Active" : "Draft"}</span>
            </Row>
          ))}
        </Section>
      )}
      <Section
        title="Checks on a new version"
        intro="A version that fails is refused, saying why; whoever edits the workflow can let it through, on the record."
      >
        <SwitchRow
          name="True peak under the delivery profile's ceiling"
          hint={
            effective
              ? `${formatDb(effective.truePeakMax)} dBTP for ${effective.label}, unless a track or file has its own`
              : "The ceiling of the profile suggested for each file"
          }
          checked={project.checkTruePeak ?? false}
          disabled={!edit}
          onChange={(checkTruePeak) => update.mutate({ checkTruePeak })}
        />
        <SwitchRow
          name="An edit decision list with every version"
          hint="The EDL the version was made from, uploaded beside it: it must hold edits, and end within the version."
          checked={project.requireEdl ?? false}
          disabled={!edit}
          onChange={(requireEdl) => update.mutate({ requireEdl })}
        />
      </Section>
    </>
  );
}

function Delivery({ project }: { project: Project }) {
  const can = useProjectCan(project.id);
  const edit = can("edit_workflows");
  const update = useUpdateProject(project.id);
  const admin = useWorkspaceAdmin();
  const { customs, own, inherited } = useProjectProfile(project);
  const { data: tracks } = useQuery({
    ...projectTracksQuery(project.id),
    enabled: project.profile === "music",
  });
  const onTrack = useTrackDeliveryProfile(project.id);
  const [editing, setEditing] = useState(false);
  const shown = own ?? inherited;
  const error = update.error ?? onTrack.error;
  return (
    <>
      <Section
        title="Delivery profile"
        intro="What QA measures every recording against. A track or a file can have its own; without any, each file is measured against the profile its channels suggest."
      >
        <Row name="Project default" hint={shown ? profileSummary(shown) : undefined}>
          <Select
            value={project.deliveryProfile ?? ""}
            aria-label="Project default"
            disabled={!edit}
            onChange={(event) =>
              update.mutate({ deliveryProfile: (event.target.value || null) as ProfileRef | null })
            }
            className="w-full @3xl/app:w-60"
          >
            <option value="">
              {inherited ? `Workspace default (${inherited.label})` : "Suggested from each file"}
            </option>
            <ProfileOptions customs={customs} />
          </Select>
          {edit && admin && (
            <Button variant="ghost" size="md" onClick={() => setEditing(true)}>
              Custom…
            </Button>
          )}
        </Row>
      </Section>
      {error && <p className="-mt-6 text-[13px] text-signal">{error.message}</p>}
      {project.profile === "music" && (
        <Section title="Overrides" intro="Tracks that measure against a different profile.">
          {!tracks && <Row name="Loading" />}
          {tracks?.length === 0 && (
            <Row name="No tracks yet" hint="Each track can measure against its own profile." />
          )}
          {tracks?.map((t) => (
            <Row
              key={t.id}
              name={
                <Link
                  to="/tracks/$trackId"
                  params={{ trackId: t.id }}
                  className="transition-colors hover:text-signal"
                >
                  {t.name}
                </Link>
              }
            >
              <Select
                size="sm"
                value={t.deliveryProfile ?? ""}
                aria-label={`Delivery profile of ${t.name}`}
                disabled={!edit}
                onChange={(event) =>
                  onTrack.mutate({
                    trackId: t.id,
                    deliveryProfile: (event.target.value || null) as ProfileRef | null,
                  })
                }
                className="w-full @3xl/app:w-56"
              >
                <option value="">Project default</option>
                <ProfileOptions customs={customs} />
              </Select>
            </Row>
          ))}
        </Section>
      )}
      {editing && (
        <ProfileEditor
          onClose={() => setEditing(false)}
          onSaved={(made) => update.mutate({ deliveryProfile: customRef(made.id) })}
        />
      )}
    </>
  );
}
