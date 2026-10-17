import {
  type AccessArea,
  type AccessLevels,
  accessAreas,
  levelsOf,
  type PlayerTool,
  playerTools,
} from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { type CSSProperties, type FormEvent, useState } from "react";
import { cn } from "~/lib/cn";
import {
  type ProjectRole,
  projectRolesQuery,
  useProjectAccessMutations,
  useProjectCan,
} from "~/lib/queries";
import { Icon } from "./icons";
import { Row, Section } from "./settings";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/choice";
import { Dialog } from "./ui/dialog";
import { Input, Select } from "./ui/input";
import { ActionMenu } from "./ui/menu";

/** A role's name: a new role's, or one renamed. */
function RoleDialog({
  title,
  initial,
  pending,
  error,
  submitLabel,
  onSubmit,
  onClose,
}: {
  title: string;
  initial: string;
  pending: boolean;
  error: Error | null;
  submitLabel: string;
  onSubmit: (name: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim()) onSubmit(name.trim());
  };
  return (
    <Dialog title={title} onClose={onClose} width="sm">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
          Name
          <Input
            value={name}
            required
            maxLength={60}
            onChange={(event) => setName(event.target.value)}
            placeholder="For example Mixer"
          />
        </label>
        {error && <p className="text-[13px] text-signal">{error.message}</p>}
        <div className="mt-1 flex justify-end gap-2">
          <Button type="button" variant="ghost" size="md" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" size="md" disabled={pending || !name.trim()}>
            {submitLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** A name not yet taken among the roles, for a copy of one. */
const copyName = (name: string, taken: string[]) => {
  let candidate = `${name} copy`;
  for (let n = 2; taken.includes(candidate); n++) candidate = `${name} copy ${n}`;
  return candidate;
};

/**
 * The project's roles, then every role against every area at one level each (#142); a level
 * includes those before it. Those who manage roles change them here.
 */
/** Each player tool as the matrix names it (#240). */
const toolWords: Record<PlayerTool, { label: string; hint: string }> = {
  qa: { label: "QA", hint: "Findings, loudness, format and metadata" },
  meters: { label: "Meters", hint: "Loudness and peaks beside the player" },
  spectrogram: { label: "Spectrogram", hint: "Below or instead of the waveform" },
  score: { label: "Score", hint: "The linked score beside the recording" },
  compare: { label: "Compare", hint: "Versions and variations side by side" },
  loops: { label: "Loops", hint: "A passage played round, from comments too" },
};

function Roles({ projectId, manage }: { projectId: string; manage: boolean }) {
  const { data: roles } = useQuery(projectRolesQuery(projectId));
  const { createRole, updateRole, deleteRole } = useProjectAccessMutations(projectId);
  const [dialog, setDialog] = useState<ProjectRole | "new" | null>(null);
  // On a phone one role is shown at a time, chosen above the table; a wide screen shows them all.
  const [shown, setShown] = useState<string | null>(null);
  const error = updateRole.error ?? deleteRole.error ?? createRole.error;
  if (!roles) return <p className="m-0 text-[13px] text-ink-3">Loading</p>;
  const focus = roles.find((r) => r.id === shown)?.id ?? roles[0]?.id;
  const column = (roleId: string) => (roleId === focus ? "" : "hidden @3xl/app:table-cell");

  const setLevel = (role: ProjectRole, area: AccessArea, level: string) =>
    updateRole.mutate({
      id: role.id,
      name: role.name,
      levels: { ...role.levels, [area]: level } as AccessLevels,
    });
  const setTool = (role: ProjectRole, tool: PlayerTool, on: boolean) =>
    updateRole.mutate({
      id: role.id,
      name: role.name,
      levels: role.levels,
      tools: on
        ? playerTools.filter((t) => t === tool || role.tools.includes(t))
        : role.tools.filter((t) => t !== tool),
    });
  // The one role left that manages people keeps that level, so the project is never left
  // without someone to run it.
  const managers = roles.filter((r) => r.levels.people === "manage");
  const close = () => setDialog(null);

  return (
    <>
      <Section
        title="Roles"
        intro="Every project starts with Producer, Engineer, Editor, Reviewer and Viewer. Rename them or add your own."
        action={
          manage ? (
            <Button variant="secondary" size="md" onClick={() => setDialog("new")}>
              <Icon name="plus" size={14} />
              Role
            </Button>
          ) : undefined
        }
      >
        {roles.map((role) => (
          <Row
            key={role.id}
            name={role.name}
            inline
            hint={role.members === 1 ? "1 person" : `${role.members} people`}
          >
            {manage && (
              <ActionMenu
                always
                label={role.name}
                actions={[
                  { label: "Rename…", onSelect: () => setDialog(role) },
                  {
                    label: "Duplicate",
                    onSelect: () =>
                      createRole.mutate({
                        name: copyName(
                          role.name,
                          roles.map((r) => r.name),
                        ),
                        levels: role.levels,
                        tools: [...role.tools],
                      }),
                  },
                  "divider",
                  role.members > 0
                    ? {
                        label: "In use: cannot delete",
                        hint: "Give its people another role first",
                        onSelect: () => {},
                      }
                    : { label: "Delete", danger: true, onSelect: () => deleteRole.mutate(role.id) },
                ]}
              />
            )}
          </Row>
        ))}
      </Section>
      {error && !dialog && <p className="-mt-6 text-[13px] text-signal">{error.message}</p>}
      <section aria-label="Access permissions" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-[16px] font-medium text-ink">Access permissions</h2>
            <p className="mt-0.5 max-w-[620px] text-[13px] text-ink-3">
              How far each role reaches in each area. A level includes the ones before it.
            </p>
          </div>
          {roles.length > 1 && (
            <div className="flex items-center gap-2 text-[13px] text-ink-3 @3xl/app:hidden">
              <label htmlFor="role-shown">Role</label>
              <Select
                id="role-shown"
                size="sm"
                value={focus}
                onChange={(event) => setShown(event.target.value)}
                className="w-auto"
              >
                {roles.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.name}
                  </option>
                ))}
              </Select>
            </div>
          )}
        </div>
        <div className="rounded-panel-lg border border-line bg-raised/25 shadow-1 @3xl/app:overflow-x-auto">
          <table
            className="w-full border-collapse text-[13px] @3xl/app:min-w-[var(--roles-width)]"
            style={{ "--roles-width": `${220 + roles.length * 120}px` } as CSSProperties}
          >
            <thead>
              <tr>
                <th className="label px-4 py-2 text-left font-normal">Area</th>
                {roles.map((role) => (
                  <th
                    key={role.id}
                    className={cn(
                      "w-[120px] px-1 py-2 text-left font-normal last:pr-4",
                      column(role.id),
                    )}
                  >
                    <span className="label block truncate px-2">{role.name}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {accessAreas.map((area) => (
                <tr key={area.id} className="border-t border-line">
                  <td className="px-4 py-2">
                    <div className="text-ink">{area.label}</div>
                    <div className="text-[12px] text-ink-3">{area.hint}</div>
                  </td>
                  {roles.map((role) => {
                    const level = role.levels[area.id];
                    const label = area.levels.find((l) => l.id === level)?.label ?? level;
                    const locked =
                      area.id === "people" && level === "manage" && managers.length === 1;
                    return (
                      <td key={role.id} className={cn("px-1 py-1.5 last:pr-4", column(role.id))}>
                        {manage ? (
                          <Select
                            size="sm"
                            value={level}
                            aria-label={`${area.label} for ${role.name}`}
                            disabled={locked}
                            title={locked ? "Another role must manage people first" : undefined}
                            onChange={(event) => setLevel(role, area.id, event.target.value)}
                            className={cn(level === "none" && "text-ink-3")}
                          >
                            {area.levels.map((l) => (
                              <option key={l.id} value={l.id}>
                                {l.label}
                              </option>
                            ))}
                          </Select>
                        ) : (
                          <span
                            className={cn("px-2", level === "none" ? "text-ink-3" : "text-ink")}
                          >
                            {label}
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section aria-label="Player tools" className="flex flex-col gap-3">
        <div className="min-w-0">
          <h2 className="text-[16px] font-medium text-ink">Player tools</h2>
          <p className="mt-0.5 max-w-[620px] text-[13px] text-ink-3">
            Which tools each role sees on the recording page. QA, meters and the spectrogram are
            refused by the server too. Workspace owners and admins have them all.
          </p>
        </div>
        <div className="rounded-panel-lg border border-line bg-raised/25 shadow-1 @3xl/app:overflow-x-auto">
          <table
            className="w-full border-collapse text-[13px] @3xl/app:min-w-[var(--roles-width)]"
            style={{ "--roles-width": `${220 + roles.length * 120}px` } as CSSProperties}
          >
            <thead>
              <tr>
                <th className="label px-4 py-2 text-left font-normal">Tool</th>
                {roles.map((role) => (
                  <th
                    key={role.id}
                    className={cn(
                      "w-[120px] px-1 py-2 text-left font-normal last:pr-4",
                      column(role.id),
                    )}
                  >
                    <span className="label block truncate px-2">{role.name}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {playerTools.map((tool) => (
                <tr key={tool} className="border-t border-line">
                  <td className="px-4 py-2">
                    <div className="text-ink">{toolWords[tool].label}</div>
                    <div className="text-[12px] text-ink-3">{toolWords[tool].hint}</div>
                  </td>
                  {roles.map((role) => {
                    const on = role.tools.includes(tool);
                    return (
                      <td key={role.id} className={cn("px-1 py-1.5 last:pr-4", column(role.id))}>
                        <span className="flex h-8 items-center px-2">
                          <Checkbox
                            checked={on}
                            disabled={!manage}
                            aria-label={`${toolWords[tool].label} for ${role.name}`}
                            onChange={() => setTool(role, tool, !on)}
                          />
                        </span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {dialog === "new" && (
        <RoleDialog
          title="New role"
          initial=""
          submitLabel="Add role"
          pending={createRole.isPending}
          error={createRole.error}
          // A new role starts by looking: it sees the files and reads the comments.
          onSubmit={(name) =>
            createRole.mutate(
              { name, levels: levelsOf(["view", "read_comments"]) },
              { onSuccess: close },
            )
          }
          onClose={close}
        />
      )}
      {dialog && dialog !== "new" && (
        <RoleDialog
          title={`Rename ${dialog.name}`}
          initial={dialog.name}
          submitLabel="Rename"
          pending={updateRole.isPending}
          error={updateRole.error}
          onSubmit={(name) =>
            updateRole.mutate({ id: dialog.id, name, levels: dialog.levels }, { onSuccess: close })
          }
          onClose={close}
        />
      )}
    </>
  );
}

/** The project's roles and their levels, as its settings show them. */
export function ProjectRoles({ projectId }: { projectId: string }) {
  const can = useProjectCan(projectId);
  return <Roles projectId={projectId} manage={can("manage_roles")} />;
}
