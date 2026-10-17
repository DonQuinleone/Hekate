import { type AccessArea, type AccessLevels, accessAreas, levelsOf } from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { type CSSProperties, type FormEvent, useState } from "react";
import { cn } from "~/lib/cn";
import {
  membersQuery,
  type ProjectRole,
  projectMembersQuery,
  projectRolesQuery,
  useProjectAccessMutations,
  useProjectCan,
} from "~/lib/queries";
import { Icon } from "./icons";
import { Row, Section } from "./settings";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { Input, Select } from "./ui/input";
import { ActionMenu } from "./ui/menu";

/** Who works on the project, and their role. Organisation owners and admins need none. */
function Members({ projectId, manage }: { projectId: string; manage: boolean }) {
  const { data: people } = useQuery(membersQuery);
  const { data: holders } = useQuery(projectMembersQuery(projectId));
  const { data: roles } = useQuery(projectRolesQuery(projectId));
  const { assign, remove } = useProjectAccessMutations(projectId);
  const error = assign.error ?? remove.error;
  if (!people || !holders || !roles) return <p className="m-0 text-[13px] text-ink-3">Loading</p>;
  const roleOf = (userId: string) => holders.find((h) => h.userId === userId)?.roleId ?? "";
  return (
    <section aria-label="Members" className="flex flex-col gap-3">
      <h2 className="m-0 text-[15px] font-medium">Members</h2>
      <p className="m-0 text-[13px] text-ink-3">
        Workspace owners and admins can do everything in every project. Everyone else sees this
        project only with a role in it.
      </p>
      {error && <p className="m-0 text-xs text-signal">{error.message}</p>}
      <ul className="m-0 flex list-none flex-col border-t border-hairline p-0">
        {people.map((person) => {
          const everything = person.role === "owner" || person.role === "admin";
          const current = roleOf(person.userId);
          return (
            <li
              key={person.userId}
              className="grid min-h-12 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-hairline py-2"
            >
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-sm text-ink">{person.name}</span>
                <span className="truncate text-xs text-ink-3">{person.email}</span>
              </span>
              {manage ? (
                <Select
                  size="sm"
                  className="w-auto"
                  aria-label={`Role of ${person.name}`}
                  value={current}
                  onChange={(event) =>
                    event.target.value
                      ? assign.mutate({ userId: person.userId, roleId: event.target.value })
                      : remove.mutate(person.userId)
                  }
                >
                  <option value="">{everything ? "No role (workspace admin)" : "No access"}</option>
                  {roles.map((role) => (
                    <option key={role.id} value={role.id}>
                      {role.name}
                    </option>
                  ))}
                </Select>
              ) : (
                <span className="text-xs text-ink-2">
                  {roles.find((r) => r.id === current)?.name ??
                    (everything ? "Workspace admin" : "No access")}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

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

/** Who is in the project: editable with "Manage" in roles and people, else read-only. */
export function ProjectMembers({ projectId }: { projectId: string }) {
  const can = useProjectCan(projectId);
  return <Members projectId={projectId} manage={can("manage_roles")} />;
}

/** The project's roles and their levels, as its settings show them. */
export function ProjectRoles({ projectId }: { projectId: string }) {
  const can = useProjectCan(projectId);
  return <Roles projectId={projectId} manage={can("manage_roles")} />;
}
