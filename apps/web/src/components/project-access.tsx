import {
  type AccessArea,
  type AccessLevels,
  accessAreas,
  levelsOf,
  type PlayerTool,
  playerTools,
  type ToolException,
} from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { type CSSProperties, type FormEvent, useState } from "react";
import { cn } from "~/lib/cn";
import {
  type ProjectRole,
  projectGroupsQuery,
  projectGuestsQuery,
  projectMembersQuery,
  projectRolesQuery,
  projectToolExceptionsQuery,
  useProjectAccessMutations,
  useProjectCan,
  useToolExceptionMutations,
} from "~/lib/queries";
import { Icon } from "./icons";
import { PlayerToolsTable, type ToolColumn, toolWords } from "./player-tools";
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

const kindWords: Record<ToolException["kind"], string> = {
  member: "Exception",
  guest: "Guest",
  group: "Group",
};

/**
 * A new exception to the player tools (decision 258): one of the project's people, a guest its
 * reviews or groups have asked, or one of its groups, and the tools they have here instead.
 */
function ExceptionDialog({
  projectId,
  roles,
  taken,
  onClose,
}: {
  projectId: string;
  roles: ProjectRole[];
  taken: ToolException[];
  onClose: () => void;
}) {
  const { data: members = [] } = useQuery(projectMembersQuery(projectId));
  const { data: guests = [] } = useQuery(projectGuestsQuery(projectId));
  const { data: groups = [] } = useQuery(projectGroupsQuery(projectId));
  const { create } = useToolExceptionMutations(projectId);
  const has = (kind: ToolException["kind"], id: string) =>
    taken.some((e) => e.kind === kind && e.subjectId === id);
  const choices = [
    // Not the workspace's owners and admins: they keep every tool, so an exception would do nothing.
    ...members
      .filter((m) => m.workspaceRole === "member" && !has("member", m.userId))
      .map((m) => ({ value: `member:${m.userId}`, label: m.name, group: "People" })),
    ...guests
      .filter((g) => !has("guest", g.id))
      .map((g) => ({ value: `guest:${g.id}`, label: g.name, group: "Guests" })),
    ...groups
      .filter((g) => !has("group", g.id))
      .map((g) => ({ value: `group:${g.id}`, label: g.name, group: "Groups" })),
  ];
  const [subject, setSubject] = useState("");
  const chosen = subject || choices[0]?.value || "";
  // They start from what they have now: a member, their role's tools; anyone else, every tool.
  const startFrom = (value: string): PlayerTool[] => {
    const [kind, id] = value.split(":");
    const role =
      kind === "member"
        ? roles.find((r) => r.id === members.find((m) => m.userId === id)?.roleId)
        : null;
    return role ? [...role.tools] : [...playerTools];
  };
  const [tools, setTools] = useState<PlayerTool[] | null>(null);
  const shown = tools ?? (chosen ? startFrom(chosen) : []);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const [kind, id] = chosen.split(":");
    if (!id) return;
    create.mutate(
      {
        ...(kind === "member"
          ? { userId: id }
          : kind === "guest"
            ? { guestId: id }
            : { groupId: id }),
        tools: shown,
      },
      { onSuccess: onClose },
    );
  };
  return (
    <Dialog
      title="Add an exception"
      description="Their tools in this project, in place of their role's. A guest keeps no tool their review leaves out."
      onClose={onClose}
      width="sm"
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        {choices.length === 0 ? (
          <p className="m-0 text-[13px] text-ink-3">
            Everyone in the project, every guest its reviews have asked and every group already has
            an exception.
          </p>
        ) : (
          <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
            For
            <Select
              value={chosen}
              onChange={(event) => {
                setSubject(event.target.value);
                setTools(null);
              }}
            >
              {(["People", "Guests", "Groups"] as const).map((group) => {
                const here = choices.filter((c) => c.group === group);
                return here.length === 0 ? null : (
                  <optgroup key={group} label={group}>
                    {here.map((c) => (
                      <option key={c.value} value={c.value}>
                        {c.label}
                      </option>
                    ))}
                  </optgroup>
                );
              })}
            </Select>
          </label>
        )}
        {chosen && (
          <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
            <legend className="mb-1.5 p-0 text-[13px] text-ink-2">Tools</legend>
            {playerTools.map((tool) => (
              <label key={tool} className="flex items-center gap-2.5 text-[13px] text-ink">
                <Checkbox
                  checked={shown.includes(tool)}
                  onChange={(event) =>
                    setTools(
                      event.target.checked
                        ? playerTools.filter((t) => t === tool || shown.includes(t))
                        : shown.filter((t) => t !== tool),
                    )
                  }
                />
                {toolWords[tool].label}
              </label>
            ))}
          </fieldset>
        )}
        {create.error && <p className="m-0 text-[13px] text-signal">{create.error.message}</p>}
        <div className="mt-1 flex justify-end gap-2">
          <Button type="button" variant="ghost" size="md" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" size="md" disabled={create.isPending || !chosen}>
            Add exception
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
function Roles({ projectId, manage }: { projectId: string; manage: boolean }) {
  const { data: roles } = useQuery(projectRolesQuery(projectId));
  const { createRole, updateRole, deleteRole } = useProjectAccessMutations(projectId);
  const { data: exceptions = [] } = useQuery(projectToolExceptionsQuery(projectId));
  const excepting = useToolExceptionMutations(projectId);
  const [dialog, setDialog] = useState<ProjectRole | "new" | "exception" | null>(null);
  // The player tools on a phone: one column at a time, a role's or an exception's.
  const [toolShown, setToolShown] = useState<string | null>(null);
  // On a phone one role is shown at a time, chosen above the table; a wide screen shows them all.
  const [shown, setShown] = useState<string | null>(null);
  const error = updateRole.error ?? deleteRole.error ?? createRole.error;
  const exceptionError = excepting.update.error ?? excepting.remove.error;
  if (!roles) return <p className="m-0 text-[13px] text-ink-3">Loading</p>;
  const focus = roles.find((r) => r.id === shown)?.id ?? roles[0]?.id;
  const column = (roleId: string) => (roleId === focus ? "" : "hidden @3xl/app:table-cell");
  const toolColumns: ToolColumn[] = [
    ...roles,
    ...exceptions.map((e) => ({
      id: e.id,
      name: e.name,
      tools: e.tools,
      caption: kindWords[e.kind],
      actions: manage ? (
        <ActionMenu
          label={e.name}
          always
          actions={[
            {
              label: "Remove exception",
              hint: "They have their role's tools again",
              danger: true,
              onSelect: () => excepting.remove.mutate(e.id),
            },
          ]}
        />
      ) : undefined,
    })),
  ];
  const toolFocus = toolColumns.find((c) => c.id === toolShown)?.id ?? toolColumns[0]?.id;

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
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-[16px] font-medium text-ink">Player tools</h2>
            <p className="mt-0.5 max-w-[620px] text-[13px] text-ink-3">
              Which tools each role sees on the recording page. QA, meters and the spectrogram are
              refused by the server too. Workspace owners and admins have them all.
            </p>
          </div>
          {toolColumns.length > 1 && (
            <div className="flex items-center gap-2 text-[13px] text-ink-3 @3xl/app:hidden">
              <label htmlFor="tools-shown">Shown</label>
              <Select
                id="tools-shown"
                size="sm"
                value={toolFocus}
                onChange={(event) => setToolShown(event.target.value)}
                className="w-auto"
              >
                {toolColumns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.caption ? `${c.name} (${c.caption.toLowerCase()})` : c.name}
                  </option>
                ))}
              </Select>
            </div>
          )}
        </div>
        <PlayerToolsTable
          roles={toolColumns}
          manage={manage}
          column={(id) => (id === toolFocus ? "" : "hidden @3xl/app:table-cell")}
          onToggle={(id, tool, on) => {
            const role = roles.find((r) => r.id === id);
            if (role) return setTool(role, tool, on);
            const exception = exceptions.find((e) => e.id === id);
            if (exception)
              excepting.update.mutate({
                id,
                tools: on
                  ? playerTools.filter((t) => t === tool || exception.tools.includes(t))
                  : exception.tools.filter((t) => t !== tool),
              });
          }}
        />
        <div className="flex flex-col divide-y divide-line rounded-panel-lg border border-line bg-raised/25">
          <Row
            name="Exceptions"
            hint={
              exceptions.length === 0
                ? "None: everyone has their role's tools, and a guest their review's."
                : "An exception's tools replace the role's for that person or group; a guest's stay within their review's."
            }
          >
            {manage && (
              <Button variant="ghost" size="md" onClick={() => setDialog("exception")}>
                Add an exception
              </Button>
            )}
          </Row>
        </div>
        {exceptionError && <p className="m-0 text-[13px] text-signal">{exceptionError.message}</p>}
      </section>
      {dialog === "exception" && (
        <ExceptionDialog projectId={projectId} roles={roles} taken={exceptions} onClose={close} />
      )}
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
      {dialog && dialog !== "new" && dialog !== "exception" && (
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
