import { type ProjectPermission, permissionNames, projectPermissions } from "@hekate/shared";
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
import { Button } from "./ui/button";
import { Checkbox } from "./ui/choice";
import { InlineInput, Input, Select } from "./ui/input";

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

/** A role's name, edited in place by those who manage roles. */
function RoleName({
  role,
  manage,
  onRename,
}: {
  role: ProjectRole;
  manage: boolean;
  onRename: (name: string) => void;
}) {
  const [name, setName] = useState(role.name);
  if (!manage) return <span className="text-xs font-medium text-ink">{role.name}</span>;
  return (
    <InlineInput
      value={name}
      aria-label={`Name of the ${role.name} role`}
      onChange={(event) => setName(event.target.value)}
      onBlur={() => {
        if (name.trim() && name.trim() !== role.name) onRename(name.trim());
        else setName(role.name);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
      className="w-24 text-center text-xs font-medium"
    />
  );
}

/** Every role against every permission. Those who manage roles change them here. */
function Roles({ projectId, manage }: { projectId: string; manage: boolean }) {
  const { data: roles } = useQuery(projectRolesQuery(projectId));
  const { createRole, updateRole, deleteRole } = useProjectAccessMutations(projectId);
  const [name, setName] = useState("");
  // On a phone one role is shown at a time, chosen above the table; a wide screen shows them all.
  const [shown, setShown] = useState<string | null>(null);
  const error = createRole.error ?? updateRole.error ?? deleteRole.error;
  if (!roles) return <p className="m-0 text-[13px] text-ink-3">Loading</p>;
  const focus = roles.find((r) => r.id === shown)?.id ?? roles[0]?.id;
  const column = (roleId: string) => (roleId === focus ? "" : "hidden @3xl/app:table-cell");

  const toggle = (role: ProjectRole, permission: ProjectPermission) => {
    const has = role.permissions.includes(permission);
    updateRole.mutate({
      id: role.id,
      name: role.name,
      permissions: has
        ? role.permissions.filter((p) => p !== permission)
        : [...role.permissions, permission],
    });
  };
  const add = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    createRole.mutate({ name, permissions: ["view"] }, { onSuccess: () => setName("") });
  };

  return (
    <section aria-label="Roles" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="m-0 text-[15px] font-medium">Roles</h2>
        {manage && (
          <form onSubmit={add} className="flex items-center gap-2">
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="New role, for example Mixer"
              aria-label="New role name"
              className="h-8 w-56 max-w-full text-[13px]"
            />
            <Button type="submit" size="md" disabled={!name.trim() || createRole.isPending}>
              Add role
            </Button>
          </form>
        )}
      </div>
      {error && <p className="m-0 text-xs text-signal">{error.message}</p>}
      {roles.length > 1 && (
        <div className="flex items-center gap-2 text-[13px] text-ink-3 @3xl/app:hidden">
          <label htmlFor="role-shown">Role</label>
          <Select
            id="role-shown"
            value={focus}
            onChange={(event) => setShown(event.target.value)}
            className="h-8 w-auto flex-1"
          >
            {roles.map((role) => (
              <option key={role.id} value={role.id}>
                {role.name}
              </option>
            ))}
          </Select>
        </div>
      )}
      <div className="@3xl/app:overflow-x-auto">
        {/* Each role needs room for its name, its count and its actions. */}
        <table
          className="w-full border-collapse text-[13px] @3xl/app:min-w-[var(--roles-width)]"
          style={{ "--roles-width": `${220 + roles.length * 112}px` } as CSSProperties}
        >
          <thead>
            <tr>
              <th className="label border-b border-hairline py-2 text-left font-normal">
                Permission
              </th>
              {roles.map((role) => (
                <th
                  key={role.id}
                  className={cn(
                    "w-[112px] border-b border-hairline px-1 py-2 font-normal",
                    column(role.id),
                  )}
                >
                  <div className="flex flex-col items-center gap-0.5">
                    <RoleName
                      key={role.name}
                      role={role}
                      manage={manage}
                      onRename={(next) =>
                        updateRole.mutate({
                          id: role.id,
                          name: next,
                          permissions: role.permissions,
                        })
                      }
                    />
                    <span className="tabular text-[10px] text-ink-3">
                      {role.members === 1 ? "1 member" : `${role.members} members`}
                    </span>
                    {manage && (
                      <button
                        type="button"
                        disabled={role.members > 0}
                        title={
                          role.members > 0
                            ? "Give its members another role first"
                            : `Delete the ${role.name} role`
                        }
                        onClick={() => deleteRole.mutate(role.id)}
                        className="cursor-pointer border-0 bg-transparent p-0 text-[10px] text-ink-3 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {projectPermissions.map((permission) => (
              <tr key={permission}>
                <td className="border-b border-hairline py-2 pr-4 text-ink-2">
                  {permissionNames[permission]}
                </td>
                {roles.map((role) => {
                  const on = role.permissions.includes(permission);
                  return (
                    <td
                      key={role.id}
                      className={cn("border-b border-hairline text-center", column(role.id))}
                    >
                      {manage ? (
                        <Checkbox
                          checked={on}
                          aria-label={`${role.name}: ${permissionNames[permission]}`}
                          onChange={() => toggle(role, permission)}
                          className="align-middle"
                        />
                      ) : (
                        <>
                          <span className={on ? "text-ink" : "text-edge"} aria-hidden="true">
                            {on ? "✓" : "·"}
                          </span>
                          <span className="sr-only">{on ? "Yes" : "No"}</span>
                        </>
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
  );
}

/** The project's roles and members: editable with "Manage roles and members", else read-only. */
export function ProjectAccess({ projectId }: { projectId: string }) {
  const can = useProjectCan(projectId);
  const manage = can("manage_roles");
  return (
    <div className="flex flex-col gap-8">
      <Members projectId={projectId} manage={manage} />
      <Roles projectId={projectId} manage={manage} />
    </div>
  );
}
