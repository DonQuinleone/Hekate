import {
  type AssetPolicy,
  assetSecurityLayout,
  capital,
  customRef,
  type DeletionPolicy,
  type DownloadPolicy,
  defaultAssetPolicy,
  defaultReferences,
  defaultWatermark,
  defaultWorkflowNotices,
  deletionPolicies,
  deletionPolicyWords,
  downloadPolicies,
  downloadPolicyWords,
  formatBytes,
  handlingWords,
  itemWords,
  type NormalisationMode,
  normalisationModes,
  normalisationWords,
  type OriginalPolicy,
  originalPolicies,
  originalPolicyWords,
  type ProfileRef,
  type ProjectPermission,
  type ProjectProfile,
  type ProtectionSection,
  profileFor,
  profiles,
  protectionLayout,
  referenceSetOf,
  referenceSets,
  type WatermarkPosition,
  type WatermarkScope,
  type WatermarkSettings,
  type WorkflowNotices,
  watermarkPositions,
  watermarkPositionWords,
  watermarkScopes,
  watermarkScopeWords,
  watermarkSummary,
  watermarkText,
} from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useState } from "react";
import { AssignmentPicker } from "~/components/assignment-picker";
import { CategoryDialog } from "~/components/category-dialog";
import {
  deliveryHint,
  ProfileEditor,
  ProfileOptions,
  useWorkspaceAdmin,
} from "~/components/delivery-profiles";
import { Empty } from "~/components/empty";
import { Icon } from "~/components/icons";
import { Page } from "~/components/page";
import { VideoMark } from "~/components/player";
import { ProjectRoles } from "~/components/project-access";
import { ConfirmStep, TransferProject } from "~/components/project-transfer";
import { QaRules } from "~/components/qa-rules";
import {
  Danger,
  FoldingSection,
  Row,
  Section,
  SettingsLayout,
  SwitchRow,
} from "~/components/settings";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import { Field } from "~/components/ui/field";
import { Input, Select, Textarea } from "~/components/ui/input";
import { ActionMenu } from "~/components/ui/menu";
import { Loading } from "~/components/ui/states";
import { WorkflowState } from "~/components/workflow-state";
import { cn } from "~/lib/cn";
import { categoryTone } from "~/lib/comments";
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
  type Track,
  useArchiveProject,
  useCategoryMutations,
  useProjectCan,
  useProjectDeletion,
  useProjectStorage,
  useTemplateMutations,
  useTrackCommentAssignment,
  useTrackDeliveryProfile,
  useTrackNormalisation,
  useTrackReferences,
  useUpdateProject,
  workspaceSettingsQuery,
} from "~/lib/queries";
import { storageName } from "~/lib/storage-names";
import { problemsOf, stepsOf } from "~/lib/workflow-summary";
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
    intro:
      "What comments may refer to, how they are categorised and carried between versions, and whom new ones are given to.",
  },
  {
    id: "roles",
    label: "Roles and access",
    group: "Project",
    intro:
      "Who may do what, one role at a time: a level in each area, each including the ones before it, and the tools it is given.",
  },
  {
    id: "workflow",
    label: "Workflow",
    group: "Project",
    intro: "Its workflows, and who they tell.",
  },
  {
    id: "watermarks",
    label: "Watermarks and downloads",
    group: "Protection",
    intro:
      "How each kind of file names whoever has it, and who may take files away or delete them.",
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
    intro:
      "What QA measures every recording against, and plays it back level with: loudness, peaks and formats. Anything in the project can have its own; without any, each file is measured against the profile its channels suggest.",
  },
  {
    id: "qa",
    label: "QA rules",
    group: "Quality assurance",
    intro:
      "Every check that runs on a recording or a video, by category, and what a new version must pass before it lands.",
  },
] as const;
export type ProjectSettingsSection = (typeof sections)[number]["id"];
export const projectSettingsSections = sections.map((s) => s.id);
/** Sections' old names in links people kept, and where each now is (#580). */
export const projectSettingsMoved: Record<string, ProjectSettingsSection> = {
  security: "watermarks",
};

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
            {current.id === "watermarks" && <Watermarks project={project} />}
            {current.id === "storage" && <ProjectStorageSection project={project} />}
            {current.id === "delivery" && <Delivery project={project} />}
            {current.id === "qa" && <QaRulesPage project={project} />}
          </SettingsLayout>
        )
      }
    </ProjectFrame>
  );
}

/**
 * A text setting saved when it loses focus, or on Enter; Escape puts it back. Two lines tall
 * where its words run longer than a name (#706), Shift and Enter starting a new line.
 */
function SavedInput({
  value,
  label,
  disabled,
  required = false,
  multiline = false,
  className,
  onSave,
}: {
  value: string;
  label: string;
  disabled: boolean;
  required?: boolean;
  multiline?: boolean;
  className?: string;
  onSave: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const save = () => {
    const next = draft.trim();
    if (next === value || (required && !next)) setDraft(value);
    else onSave(next);
  };
  const keys = (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.blur();
    }
    if (event.key === "Escape") {
      setDraft(value);
      event.currentTarget.blur();
    }
  };
  const shared = {
    value: draft,
    "aria-label": label,
    disabled,
    onBlur: save,
    onKeyDown: keys,
    className,
  };
  return multiline ? (
    <Textarea key={value} rows={2} {...shared} onChange={(event) => setDraft(event.target.value)} />
  ) : (
    <Input key={value} {...shared} onChange={(event) => setDraft(event.target.value)} />
  );
}

/**
 * Saving the project's set-up as a template (#240): a copy, so changing this project afterwards
 * leaves it as it was. The workspace's templates are listed, and removed, in its settings,
 * Defaults (#679): they are the workspace's, not this project's.
 */
function Templates({ project, canSave }: { project: Project; canSave: boolean }) {
  const { save } = useTemplateMutations();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState(project.name);
  if (!canSave) return null;
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
      <Row
        name="Save as a template"
        hint={
          save.isSuccess
            ? "Saved. The workspace's templates are listed in its settings, under Defaults."
            : "Roles, categories, delivery profile, QA rules and version checks, without the files."
        }
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
      <Section title="Details">
        <Row name="Name">
          <SavedInput
            key={project.name}
            value={project.name}
            label="Name"
            required
            disabled={!edit}
            onSave={(name) => update.mutate({ name })}
            className="w-full @3xl/app:w-72"
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
            multiline
            onSave={(description) => update.mutate({ description: description || null })}
            className="w-full @3xl/app:w-72"
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
  const close = () => setDialog(null);
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
              variant="secondary"
              size="md"
              disabled={cancel.isPending}
              onClick={() => cancel.mutate()}
            >
              Withdraw
            </Button>
          )}
          {deletion.mayConfirm && (
            <Button variant="danger" size="md" onClick={() => setDialog("confirm")}>
              Confirm deletion…
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
        <Button variant="danger" size="md" onClick={() => setDialog("ask")}>
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
          description="Nothing happens yet: a workspace owner other than you confirms first, or you a day later where the workspace has one owner. Once confirmed, it is archived, and everything in it is removed seven days later."
          onClose={close}
          width="sm"
          footer={
            <>
              <Button variant="secondary" size="md" onClick={close}>
                Cancel
              </Button>
              <Button
                variant="danger"
                size="md"
                disabled={request.isPending}
                onClick={() => request.mutate(undefined, { onSuccess: close })}
              >
                Ask to delete project
              </Button>
            </>
          }
        >
          {request.error && <p className="text-[13px] text-signal">{request.error.message}</p>}
        </Dialog>
      )}
      {dialog === "confirm" && (
        <ConfirmStep
          title={`Delete ${project.name}?`}
          description="Once you confirm, it is archived, and everything in it is removed seven days later; until then it can be kept."
          projectName={project.name}
          action="Delete project"
          pending={confirm.isPending}
          error={confirm.error}
          onClose={close}
          onConfirm={(proof) => confirm.mutate(proof, { onSuccess: close })}
        />
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
  // Each storage by its name, never its id (#586).
  const named = (backend: string) => storageName(backend, data.available);
  return (
    <>
      <Section>
        <Row
          name="Where new files are stored"
          hint={owner ? undefined : "Only a workspace owner can change it."}
        >
          {owner ? (
            <Select
              aria-label="Where new files are stored"
              value={data.backend ?? ""}
              onChange={(e) => choose.mutate(e.target.value || null)}
            >
              <option value="">As the workspace: {named(data.workspaceBackend)}</option>
              {data.available.map((b) => (
                <option key={b} value={b}>
                  {named(b)}
                </option>
              ))}
            </Select>
          ) : (
            <span className="text-[14px] text-ink-2">
              {named(data.backend ?? data.workspaceBackend)}
            </span>
          )}
        </Row>
        <Row name="Used by this project" hint="Originals, proxies, rendered pages and waveforms">
          <span className="tabular text-[14px] text-ink">{formatBytes(data.bytes)}</span>
        </Row>
      </Section>
      {choose.error && <p className="-mt-6 text-[13px] text-signal">{choose.error.message}</p>}
    </>
  );
}

/**
 * Watermarks and downloads (decision 287, #580): the inaudible mark on recordings' downloads
 * (decision 239), and the visible watermark (#31), one setting for video, pictures and documents,
 * so one section with its three fields labelled and its preview beside them (#674). Each comes
 * where the profile puts its kind of file, open where the project has that kind and folded to its
 * summary where it has none. Then who may download and delete (decision 257), whatever the kind.
 */
function Watermarks({ project }: { project: Project }) {
  // The sections opened or folded by hand, against how the page first lays them out.
  const [flipped, setFlipped] = useState<ReadonlySet<ProtectionSection>>(new Set());
  const layout = protectionLayout(assetSecurityLayout(project.profile, project.fileKinds)).map(
    (s) => ({ ...s, open: flipped.has(s.section) ? !s.open : s.open }),
  );
  const flip = (section: ProtectionSection) =>
    setFlipped((was) => {
      const next = new Set(was);
      if (!next.delete(section)) next.add(section);
      return next;
    });
  return (
    <>
      {layout.map((s) =>
        s.section === "audio" ? (
          <AudioMarking key="audio" project={project} />
        ) : (
          <VisibleWatermark
            key="watermark"
            project={project}
            open={s.open}
            onToggle={() => flip("watermark")}
          />
        ),
      )}
      <Downloads project={project} />
    </>
  );
}

/** The visible watermark (#31, #674): whom it marks, where and how strongly, and how it looks. */
function VisibleWatermark({
  project,
  open,
  onToggle,
}: {
  project: Project;
  open: boolean;
  onToggle: () => void;
}) {
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
  const off = settings.scope === "off";
  return (
    <FoldingSection
      id="visible-watermark"
      title="Visible watermark"
      intro="Over video in the player, and burned into each page, picture and download, in the viewer's name."
      summary={watermarkSummary(settings)}
      open={open}
      onToggle={onToggle}
    >
      {/* Its three fields in a row, the preview beside them as a thumbnail, as Stripe lays out a
          branding setting: compact enough for the page to lead with it. */}
      <div className="grid gap-5 px-4 py-4 @3xl/app:grid-cols-[minmax(0,1fr)_200px] @3xl/app:gap-6">
        <div className="grid min-w-0 content-start gap-4 @xl/app:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_6rem]">
          <Field label="Who it marks">
            <Select
              value={settings.scope}
              disabled={!edit}
              onChange={(e) => change({ scope: e.target.value as WatermarkScope })}
            >
              {watermarkScopes.map((scope) => (
                <option key={scope} value={scope}>
                  {watermarkScopeWords[scope]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Position">
            <Select
              value={settings.position}
              disabled={!edit || off}
              onChange={(e) => change({ position: e.target.value as WatermarkPosition })}
            >
              {watermarkPositions.map((position) => (
                <option key={position} value={position}>
                  {watermarkPositionWords[position]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Strength">
            <SavedInput
              key={settings.opacity}
              value={`${settings.opacity}%`}
              label="Strength"
              disabled={!edit || off}
              onSave={(typed) => {
                const opacity = Number.parseInt(typed, 10);
                if (Number.isInteger(opacity))
                  change({ opacity: Math.min(80, Math.max(10, opacity)) });
              }}
              className="tabular w-24"
            />
          </Field>
          <p className="m-0 text-[12px] text-ink-3 @xl/app:col-span-3">
            Strength runs from 10 to 80 per cent: faint enough to watch through.
          </p>
        </div>
        <figure className="m-0 flex min-w-0 flex-col gap-1.5">
          <figcaption className="text-[13px] text-ink-2">
            {off ? "Preview: nothing is marked" : "Preview"}
          </figcaption>
          {/* A frame stands in for the picture: dark in either theme, as a video is. */}
          <div
            className="relative aspect-video w-full max-w-[320px] overflow-hidden rounded-panel"
            style={{
              background:
                "radial-gradient(120% 90% at 30% 20%, var(--hk-cover-video-lit), var(--hk-cover-video-deep) 70%)",
            }}
          >
            {/* Laid out at twice the thumbnail's size and drawn at half, so the mark keeps the
                proportion it has over a picture in the player. */}
            {!off && (
              <div className="absolute top-0 left-0 h-[200%] w-[200%] origin-top-left scale-50">
                <VideoMark
                  mark={{ text: sample, position: settings.position, opacity: settings.opacity }}
                />
              </div>
            )}
          </div>
        </figure>
        {update.error && (
          <p role="alert" className="m-0 text-[13px] text-signal @3xl/app:col-span-2">
            {update.error.message}
          </p>
        )}
      </div>
    </FoldingSection>
  );
}

/**
 * The inaudible mark in recordings' downloads (decision 239), which this project may only
 * narrow (decision 257). Streams are not marked yet (#451), so nothing here speaks of them.
 */
function AudioMarking({ project }: { project: Project }) {
  const can = useProjectCan(project.id);
  const update = useUpdateProject(project.id);
  const { data: me } = useQuery(meQuery);
  const owner = me?.organisations.find((o) => o.id === me.activeOrganisationId)?.role === "owner";
  const policy = project.assetPolicy ?? defaultAssetPolicy;
  const edit = can("edit_project") && !update.isPending;
  const workspaceMarks = project.workspaceMarks ?? false;
  const marking = workspaceMarks && policy.forensicDownloads;
  return (
    <>
      <Section
        title="Audio"
        intro="An inaudible mark, made for each person, in every download of a recording."
      >
        <SwitchRow
          name="Forensic mark on downloads"
          hint={
            !workspaceMarks
              ? "Off for the workspace: its owners turn it on under Leak tracing."
              : !marking
                ? "This project's recordings download as they were uploaded, unmarked."
                : owner
                  ? "If a copy leaks, a workspace owner traces it under Leak tracing to whoever received it."
                  : "If a copy leaks, an owner traces it to whoever received it. Only owners can stop marking."
          }
          checked={marking}
          disabled={!edit || !workspaceMarks || (marking && !owner)}
          onChange={(forensicDownloads) =>
            update.mutate({ assetPolicy: { ...policy, forensicDownloads } })
          }
        />
      </Section>
      {update.error && <p className="-mt-6 text-[13px] text-signal">{update.error.message}</p>}
    </>
  );
}

/**
 * Downloads and deletion (decision 257). Each narrows what the roles and reviews allow; the
 * server applies it wherever they are checked.
 */
function Downloads({ project }: { project: Project }) {
  const can = useProjectCan(project.id);
  const update = useUpdateProject(project.id);
  const policy = project.assetPolicy ?? defaultAssetPolicy;
  // One change at a time: each sends the whole policy, so a second waits for the first.
  const edit = can("edit_project") && !update.isPending;
  const change = (next: Partial<AssetPolicy>) =>
    update.mutate({ assetPolicy: { ...policy, ...next } });
  return (
    <>
      <Section
        title="Downloads and deletion"
        intro="Each narrows what the roles and reviews allow; a download is still marked and logged."
      >
        <Row name="Who may download">
          <Select
            value={policy.downloads}
            aria-label="Who may download"
            disabled={!edit}
            onChange={(e) => change({ downloads: e.target.value as DownloadPolicy })}
            className="w-full @3xl/app:w-64"
          >
            {downloadPolicies.map((p) => (
              <option key={p} value={p}>
                {downloadPolicyWords[p]}
              </option>
            ))}
          </Select>
        </Row>
        <Row
          name="Originals"
          hint="A download gives the proxy unless the person may have the original."
        >
          <Select
            value={policy.originals}
            aria-label="Originals"
            disabled={!edit || policy.downloads === "nobody"}
            onChange={(e) => change({ originals: e.target.value as OriginalPolicy })}
            className="w-full @3xl/app:w-64"
          >
            {originalPolicies.map((p) => (
              <option key={p} value={p}>
                {originalPolicyWords[p]}
              </option>
            ))}
          </Select>
        </Row>
        <Row name="Who may delete">
          <Select
            value={policy.deletion}
            aria-label="Who may delete"
            disabled={!edit}
            onChange={(e) => change({ deletion: e.target.value as DeletionPolicy })}
            className="w-full @3xl/app:w-64"
          >
            {deletionPolicies.map((p) => (
              <option key={p} value={p}>
                {deletionPolicyWords[p]}
              </option>
            ))}
          </Select>
        </Row>
        <SwitchRow
          name="Files in a review cannot be deleted"
          hint="Open or closed, so what reviewers were asked about stays on the record."
          checked={policy.keepReviewed}
          disabled={!edit}
          onChange={(keepReviewed) => change({ keepReviewed })}
        />
      </Section>
      {update.error && <p className="-mt-6 text-[13px] text-signal">{update.error.message}</p>}
    </>
  );
}

/**
 * The tracks that differ from the project in one setting (#671), as Vercel lists only the values
 * an environment overrides: each with its control, choosing the project's default putting it
 * back, and "Override for a track…" to give another its own. Named for what they override.
 */
function TrackOverrides({
  project,
  title,
  tracks,
  differs,
  disabled,
  control,
}: {
  project: Project;
  /** What the tracks listed have of their own: "Tracks with their own references". */
  title: string;
  tracks: Track[] | undefined;
  differs: (track: Track) => boolean;
  disabled: boolean;
  /** A track's control, `done` once it has changed (the dialog closes). */
  control: (track: Track, done?: () => void) => ReactNode;
}) {
  const words = itemWords(project.profile);
  const [adding, setAdding] = useState(false);
  const [chosen, setChosen] = useState("");
  if (!tracks || tracks.length === 0) return null;
  const listed = tracks.filter(differs);
  const others = tracks.filter((t) => !differs(t));
  const picked = others.find((t) => t.id === chosen) ?? others[0];
  return (
    <>
      <Section
        title={title}
        count={listed.length > 0 ? listed.length : undefined}
        intro={
          listed.length === 0 ? `Every ${words.track} follows the project's choice.` : undefined
        }
        action={
          !disabled && others.length > 0 ? (
            <Button
              variant="secondary"
              size="md"
              onClick={() => {
                setChosen("");
                setAdding(true);
              }}
            >
              Override for a {words.track}…
            </Button>
          ) : undefined
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
                    className="transition-colors hover:text-signal"
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
      {adding && picked && (
        <Dialog
          title={`Override for a ${words.track}`}
          description={`The ${words.track} keeps this in place of the project's choice, until it is set back to the project default.`}
          onClose={() => setAdding(false)}
          width="sm"
          footer={
            <Button variant="secondary" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          }
        >
          <div className="flex flex-col gap-4">
            <Field label={capital(words.track)}>
              <Select value={picked.id} onChange={(e) => setChosen(e.target.value)}>
                {others.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Its own">{control(picked, () => setAdding(false))}</Field>
          </div>
        </Dialog>
      )}
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
  const assignOnTrack = useTrackCommentAssignment(project.id);
  const { data: categories } = useQuery(categoriesQuery(project.id));
  const mutations = useCategoryMutations(project.id);
  const { remove } = mutations;
  const [editing, setEditing] = useState<CommentCategory | "new" | null>(null);
  const [deleting, setDeleting] = useState<CommentCategory | null>(null);
  const shape = can("edit_workflows");
  const words = itemWords(project.profile);
  return (
    <>
      <Section
        title="References"
        intro={`What reviewers can type beside a comment, as they read it from the score or the document. Never derived from the time; never on the scrub bar. Each ${words.track} can also have its own.`}
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
      <TrackOverrides
        project={project}
        title={`${capital(words.tracks)} with their own references`}
        tracks={tracks}
        differs={(t) => t.commentReferences !== null}
        disabled={!can("edit_project")}
        control={(t, done) => (
          <Select
            value={t.commentReferences ? (referenceSetOf(t.commentReferences) ?? "") : ""}
            aria-label={`References of ${t.name}`}
            disabled={!can("edit_project")}
            onChange={(event) =>
              onTrack.mutate(
                {
                  trackId: t.id,
                  references:
                    referenceSets.find((set) => set.id === event.target.value)?.references ?? null,
                },
                { onSuccess: done },
              )
            }
          >
            <option value="">Project default</option>
            {referenceSets.map((set) => (
              <option key={set.id} value={set.id}>
                {set.label}
              </option>
            ))}
          </Select>
        )}
      />
      <Section
        title="Categories"
        intro="Triage marks comments with a category, so each kind goes where it belongs."
        action={
          shape ? (
            <Button variant="secondary" size="md" onClick={() => setEditing("new")}>
              <Icon name="plus" size={14} />
              New category
            </Button>
          ) : undefined
        }
      >
        {!categories && <Loading size="panel" />}
        {categories?.length === 0 && (
          <Row name="No categories" hint="Comments can still be triaged without one." />
        )}
        {categories?.map((c) => (
          // Each in its colour, by its place among the project's categories (#706, brand.md).
          <div key={c.id} className="relative">
            <span
              aria-hidden="true"
              className={cn(
                "absolute inset-y-2.5 left-0 w-[3px] rounded-r-full",
                categoryTone(categories, c.id),
              )}
            />
            <Row
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
          </div>
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
      </Section>
      {/* Whom new comments are for (#499, moved here from Workflow by #672). */}
      <Section
        title="New comments"
        intro={`Whom a comment is given to as it is opened, unless the step the ${words.track} waits at says otherwise. They are told, as of comments sent to them.`}
      >
        <Row name="Assign new comments to" hint="A member, or whoever has held a role the longest">
          <AssignmentPicker
            projectId={project.id}
            value={project.commentAssignment ?? { assign: null }}
            disabled={!shape || update.isPending}
            aria-label="Assign new comments to"
            onChange={(rule) => update.mutate({ commentAssignment: rule })}
          />
        </Row>
      </Section>
      {assignOnTrack.error && (
        <p className="-mt-6 text-[13px] text-signal">{assignOnTrack.error.message}</p>
      )}
      <TrackOverrides
        project={project}
        title={`${capital(words.tracks)} whose new comments go to someone else`}
        tracks={tracks}
        differs={(t) => t.commentAssignment !== null}
        disabled={!shape}
        control={(t, done) => (
          <AssignmentPicker
            projectId={project.id}
            value={t.commentAssignment}
            inherits="Project default"
            disabled={!shape}
            aria-label={`Assign new comments on ${t.name} to`}
            onChange={(assignment) =>
              assignOnTrack.mutate({ trackId: t.id, assignment }, { onSuccess: done })
            }
          />
        )}
      />
      {editing && (
        <CategoryDialog
          mutations={mutations}
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
              <Button variant="secondary" size="md" onClick={() => setDeleting(null)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                size="md"
                disabled={remove.isPending}
                onClick={() => remove.mutate(deleting.id, { onSuccess: () => setDeleting(null) })}
              >
                Delete category
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

/** The profile a project measures against unless something nearer chooses, and its name. */
function useProjectProfile(project: Project) {
  const { data: customs = [] } = useQuery(customProfilesQuery);
  const { data: workspace } = useQuery(workspaceSettingsQuery);
  const own = profileFor(project.deliveryProfile, customs);
  const inherited = profileFor(workspace?.deliveryProfile, customs);
  return { customs, own, inherited, effective: own ?? inherited };
}

function Workflow({ project }: { project: Project }) {
  const can = useProjectCan(project.id);
  const update = useUpdateProject(project.id);
  const edit = can("edit_workflows");
  const words = itemWords(project.profile);
  const notices = project.workflowNotices ?? defaultWorkflowNotices;
  // Each sends all three, so a change waits for the one before it.
  const notify = (next: Partial<WorkflowNotices>) => {
    if (!update.isPending) update.mutate({ workflowNotices: { ...notices, ...next } });
  };
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
          intro={`The steps a ${words.track} goes through as ${words.versions} arrive, the statuses they set, and who is asked at each.`}
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
              hint={`${capital(words.tracks)} have no steps until one is made and switched on.`}
            />
          )}
          {workflows?.map((w) => (
            <Row
              key={w.id}
              name={w.name}
              hint={[
                stepsOf(w.definition),
                w.problems.length > 0 ? problemsOf(w.problems) : null,
                w.trackId ? `for one ${words.track}` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
              inline
            >
              <WorkflowState active={w.active} />
            </Row>
          ))}
        </Section>
      )}
      <Section title="Notifications" intro="Who is told when a step or status is entered.">
        <SwitchRow
          name="Participants, in the app"
          hint={`Whoever a step names, and the ${words.track}'s followers on a new status.`}
          checked={notices.app}
          disabled={!edit}
          onChange={(app) => notify({ app })}
        />
        <SwitchRow
          name="Participants, by mail"
          checked={notices.mail}
          disabled={!edit}
          onChange={(mail) => notify({ mail })}
        />
        <SwitchRow
          name="Everyone in the project, on a status change"
          checked={notices.everyoneOnStatus}
          disabled={!edit}
          onChange={(everyoneOnStatus) => notify({ everyoneOnStatus })}
        />
      </Section>
    </>
  );
}

/** QA rules, with the delivery profile whose ceiling a new version's true peak is held to. */
function QaRulesPage({ project }: { project: Project }) {
  const { effective } = useProjectProfile(project);
  return <QaRules project={project} profile={effective ?? null} />;
}

function Delivery({ project }: { project: Project }) {
  const can = useProjectCan(project.id);
  const edit = can("edit_workflows");
  const update = useUpdateProject(project.id);
  const admin = useWorkspaceAdmin();
  const { customs, own, inherited } = useProjectProfile(project);
  // Tracks, and a video project's deliverables (#16), can each measure against their own.
  const withTracks = project.profile !== "general";
  const words = itemWords(project.profile);
  const { data: tracks } = useQuery(projectTracksQuery(project.id));
  const onTrack = useTrackDeliveryProfile(project.id);
  const playsTrack = useTrackNormalisation(project.id);
  const [editing, setEditing] = useState(false);
  const shown = own ?? inherited;
  const error = update.error ?? onTrack.error ?? playsTrack.error;
  // "Custom…" is the select's last choice (#672): it opens the editor, and the select keeps
  // what it showed until the new profile is saved.
  const CUSTOM = "custom-new";
  return (
    <>
      <Section>
        <Row name="Project default" hint={shown ? deliveryHint(shown) : undefined}>
          <Select
            value={project.deliveryProfile ?? ""}
            aria-label="Project default"
            disabled={!edit}
            onChange={(event) => {
              if (event.target.value === CUSTOM) {
                setEditing(true);
                return;
              }
              update.mutate({ deliveryProfile: (event.target.value || null) as ProfileRef | null });
            }}
          >
            <option value="">
              {inherited ? `Workspace default (${inherited.label})` : "Suggested from each file"}
            </option>
            <ProfileOptions customs={customs} />
            {edit && admin && <option value={CUSTOM}>Custom…</option>}
          </Select>
        </Row>
      </Section>
      {error && <p className="-mt-6 text-[13px] text-signal">{error.message}</p>}
      {withTracks && (
        <TrackOverrides
          project={project}
          title={`${capital(words.tracks)} with their own profile`}
          tracks={tracks}
          differs={(t) => t.deliveryProfile !== null}
          disabled={!edit}
          control={(t, done) => (
            <Select
              value={t.deliveryProfile ?? ""}
              aria-label={`Delivery profile of ${t.name}`}
              disabled={!edit}
              onChange={(event) =>
                onTrack.mutate(
                  {
                    trackId: t.id,
                    deliveryProfile: (event.target.value || null) as ProfileRef | null,
                  },
                  { onSuccess: done },
                )
              }
            >
              <option value="">Project default</option>
              <ProfileOptions customs={customs} />
            </Select>
          )}
        />
      )}
      {/* A listening setting, matched to this profile's target (moved here from Comments, #672). */}
      <Section title="Playback">
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
      <TrackOverrides
        project={project}
        title={`${capital(words.tracks)} with their own normalisation`}
        tracks={tracks}
        differs={(t) => t.normalisation !== null}
        disabled={!can("edit_project")}
        control={(t, done) => (
          <Select
            value={t.normalisation ?? ""}
            aria-label={`Normalised playback of ${t.name}`}
            disabled={!can("edit_project") || playsTrack.isPending}
            onChange={(event) =>
              playsTrack.mutate(
                {
                  trackId: t.id,
                  normalisation: (event.target.value || null) as NormalisationMode | null,
                },
                { onSuccess: done },
              )
            }
          >
            <option value="">Project default</option>
            {normalisationModes.map((mode) => (
              <option key={mode} value={mode}>
                {normalisationWords[mode]}
              </option>
            ))}
          </Select>
        )}
      />
      {editing && (
        <ProfileEditor
          onClose={() => setEditing(false)}
          onSaved={(made) => update.mutate({ deliveryProfile: customRef(made.id) })}
        />
      )}
    </>
  );
}
