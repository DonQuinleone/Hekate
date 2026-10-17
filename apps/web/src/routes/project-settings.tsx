import {
  type CategoryHandling,
  categoryHandlings,
  customRef,
  handlingWords,
  type ProfileRef,
  type ProjectPermission,
  type ProjectProfile,
  profileFor,
  profiles,
} from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
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
import { ProjectRoles } from "~/components/project-access";
import { QaRules } from "~/components/qa-rules";
import { Danger, Row, Section, SettingsLayout, SwitchRow } from "~/components/settings";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import { Input, Select } from "~/components/ui/input";
import { ActionMenu } from "~/components/ui/menu";
import {
  type CommentCategory,
  categoriesQuery,
  customProfilesQuery,
  type Project,
  projectTracksQuery,
  useArchiveProject,
  useCategoryMutations,
  useProjectCan,
  useTrackDeliveryProfile,
  useUpdateProject,
  workspaceSettingsQuery,
} from "~/lib/queries";
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
    intro: "How comments are categorised and carried between versions.",
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
  const current = sections.find((s) => s.id === section) ?? sections[0];
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
            sections={[...sections]}
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
      {project.mayArchive && !project.archivedAt && (
        <Danger>
          <Row
            name="Archive this project"
            hint="Read-only for everyone; its open reviews close; it leaves the lists. Everything is kept, and it can be unarchived."
          >
            <Button variant="secondary" size="md" onClick={() => setConfirm(true)}>
              Archive…
            </Button>
          </Row>
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

function Comments({ project }: { project: Project }) {
  const can = useProjectCan(project.id);
  const update = useUpdateProject(project.id);
  const { data: categories } = useQuery(categoriesQuery(project.id));
  const { remove } = useCategoryMutations(project.id);
  const [editing, setEditing] = useState<CommentCategory | "new" | null>(null);
  const [deleting, setDeleting] = useState<CommentCategory | null>(null);
  const shape = can("edit_workflows");
  return (
    <>
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
      </Section>
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

function Workflow({ project }: { project: Project }) {
  const can = useProjectCan(project.id);
  const update = useUpdateProject(project.id);
  const edit = can("edit_workflows");
  const { effective } = useProjectProfile(project);
  return (
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
        hint="The EDL the version was made from, uploaded beside it."
        checked={project.requireEdl ?? false}
        disabled={!edit}
        onChange={(requireEdl) => update.mutate({ requireEdl })}
      />
    </Section>
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
