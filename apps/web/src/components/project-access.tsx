import {
  type AccessLevels,
  accessAreas,
  levelsOf,
  type PlayerTool,
  playerTools,
  type ToolException,
} from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
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
import {
  compareRows,
  copiedInto,
  copyOf,
  levelIndex,
  lowestLevel,
  permissionGroups,
  rowOn,
  setAreaLevel,
  setRow,
  withTool,
} from "~/lib/role-editor";
import { Icon } from "./icons";
import { PlayerToolsTable, type ToolColumn, toolWords } from "./player-tools";
import { Row, Section } from "./settings";
import { Button } from "./ui/button";
import { ToggleChip } from "./ui/chip";
import { Checkbox } from "./ui/choice";
import { Dialog } from "./ui/dialog";
import { Input, Select } from "./ui/input";
import { ActionMenu, MenuList, usePopover } from "./ui/menu";
import { Switch } from "./ui/toggle";

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
    // Not the workspace's owners and admins, nor the project's owners (decision 285): they keep
    // every tool, so an exception would do nothing.
    ...members
      .filter((m) => m.workspaceRole === "member" && !m.ownerSince && !has("member", m.userId))
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

/** "New role": a blank one, named first, or a copy of any role, made at once (two clicks). */
function NewRoleMenu({
  roles,
  onBlank,
  onCopy,
}: {
  roles: ProjectRole[];
  onBlank: () => void;
  onCopy: (role: ProjectRole) => void;
}) {
  const [open, setOpen, box] = usePopover();
  return (
    <div ref={box} className="relative">
      <Button
        variant="ghost"
        size="sm"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Icon name="plus" size={14} />
        New role
      </Button>
      {open && (
        <MenuList
          anchor={box}
          align="left"
          label="New role"
          onClose={() => setOpen(false)}
          actions={[
            { label: "Blank role…", hint: "Sees files, reads comments", onSelect: onBlank },
            "divider",
            { heading: "Copy from" },
            ...roles.map((role) => ({ label: role.name, onSelect: () => onCopy(role) })),
          ]}
        />
      )}
    </div>
  );
}

/** "Copy from…" in a role's menu: another role's every level and tool, in place of its own. */
function CopyFromDialog({
  role,
  roles,
  pending,
  error,
  onCopy,
  onClose,
}: {
  role: ProjectRole;
  roles: ProjectRole[];
  pending: boolean;
  error: Error | null;
  onCopy: (source: ProjectRole) => void;
  onClose: () => void;
}) {
  const others = roles.filter((r) => r.id !== role.id);
  const [chosen, setChosen] = useState(others[0]?.id ?? "");
  const source = others.find((r) => r.id === chosen);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (source) onCopy(source);
  };
  return (
    <Dialog
      title={`Copy into ${role.name}`}
      description={`Every level and every tool of the role you choose replaces ${role.name}'s. Its name and its people stay.`}
      onClose={onClose}
      width="sm"
    >
      <form onSubmit={submit} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
          Copy from
          <Select value={chosen} onChange={(event) => setChosen(event.target.value)}>
            {others.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
        </label>
        {error && <p className="m-0 text-[13px] text-signal">{error.message}</p>}
        <div className="mt-1 flex justify-end gap-2">
          <Button type="button" variant="ghost" size="md" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" size="md" disabled={pending || !source}>
            Copy
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Every role's level in each area at once, read-only: rows are roles, so more roles never widen it. */
function CompareDialog({ roles, onClose }: { roles: ProjectRole[]; onClose: () => void }) {
  return (
    <Dialog
      title="Compare roles"
      description="Every role's level in each area, and how many player tools it has."
      onClose={onClose}
      width="xl"
    >
      {/* Scrolled from the keyboard too, where a phone is narrower than its nine areas. */}
      <section
        aria-label="Every role's levels"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a region that scrolls must take focus to scroll from the keyboard.
        tabIndex={0}
        className="scroll-quiet overflow-x-auto rounded-control focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink-3"
      >
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr>
              <th className="label px-2 py-2 text-left font-normal">Role</th>
              {accessAreas.map((area) => (
                <th key={area.id} className="label px-2 py-2 text-left font-normal">
                  {area.label}
                </th>
              ))}
              <th className="label px-2 py-2 text-right font-normal">Tools</th>
            </tr>
          </thead>
          <tbody>
            {compareRows(roles).map((row) => (
              <tr key={row.id} className="border-t border-line">
                <th
                  scope="row"
                  className="px-2 py-2 text-left font-normal whitespace-nowrap text-ink"
                >
                  {row.name}
                </th>
                {row.levels.map((cell) => (
                  <td
                    key={cell.area}
                    className={cn("px-2 py-2", cell.none ? "text-ink-3" : "text-ink-2")}
                  >
                    {cell.label}
                  </td>
                ))}
                <td className="tabular px-2 py-2 text-right text-ink-2">{row.tools}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </Dialog>
  );
}

/**
 * Roles and access, one role at a time (#506), as XenForo edits its user groups: the roles
 * across the top, then the chosen role's permissions by area, a level picker in each area's
 * header setting every row in it at once, then its player tools, then the exceptions to the
 * tools (decision 258). Twelve roles wrap rather than widen the page. Those who manage roles
 * change them here.
 */
function Roles({ projectId, manage }: { projectId: string; manage: boolean }) {
  const { data: roles } = useQuery(projectRolesQuery(projectId));
  const { createRole, updateRole, deleteRole } = useProjectAccessMutations(projectId);
  const { data: exceptions = [] } = useQuery(projectToolExceptionsQuery(projectId));
  const excepting = useToolExceptionMutations(projectId);
  const [dialog, setDialog] = useState<"new" | "rename" | "copy" | "compare" | "exception" | null>(
    null,
  );
  const [shown, setShown] = useState<string | null>(null);
  // The exceptions on a phone: one column at a time.
  const [exceptionShown, setExceptionShown] = useState<string | null>(null);
  if (!roles) return <p className="m-0 text-[13px] text-ink-3">Loading</p>;
  const role = roles.find((r) => r.id === shown) ?? roles[0];
  if (!role) return <p className="m-0 text-[13px] text-ink-3">This project has no roles.</p>;
  const error = updateRole.error ?? deleteRole.error ?? createRole.error;
  const exceptionError = excepting.update.error ?? excepting.remove.error;
  const close = () => setDialog(null);
  const save = (levels: AccessLevels, tools?: PlayerTool[]) =>
    updateRole.mutate({ id: role.id, name: role.name, levels, tools });
  const create = (input: { name: string; levels: AccessLevels; tools?: PlayerTool[] }) =>
    createRole.mutate(input, {
      onSuccess: (data) => {
        setShown(data.role.id);
        close();
      },
    });

  const exceptionColumns: ToolColumn[] = exceptions.map((e) => ({
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
  }));
  const exceptionFocus =
    exceptionColumns.find((c) => c.id === exceptionShown)?.id ?? exceptionColumns[0]?.id;

  return (
    <>
      <div className="flex flex-col gap-6">
        <div className="flex flex-wrap items-center gap-1.5">
          <fieldset className="m-0 flex min-w-0 flex-wrap items-center gap-1.5 border-0 p-0">
            <legend className="sr-only">Role</legend>
            {roles.map((r) => (
              <ToggleChip
                key={r.id}
                pressed={r.id === role.id}
                onClick={() => setShown(r.id)}
                className="max-w-[200px]"
                title={r.name}
              >
                <span className="truncate">{r.name}</span>
              </ToggleChip>
            ))}
          </fieldset>
          {manage && (
            <NewRoleMenu
              roles={roles}
              onBlank={() => setDialog("new")}
              onCopy={(source) => create(copyOf(source, roles))}
            />
          )}
          {roles.length > 1 && (
            <Button
              variant="quiet"
              size="sm"
              className="ml-auto"
              onClick={() => setDialog("compare")}
            >
              <Icon name="columns" size={14} />
              Compare
            </Button>
          )}
        </div>

        <section aria-label={role.name} className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-[16px] font-medium text-ink">{role.name}</h2>
              <p className="mt-0.5 text-[13px] text-ink-3">
                {role.members === 0
                  ? "No one has this role yet"
                  : role.members === 1
                    ? "1 person"
                    : `${role.members} people`}
              </p>
            </div>
            {manage && (
              <ActionMenu
                always
                label={role.name}
                actions={[
                  { label: "Rename…", onSelect: () => setDialog("rename") },
                  ...(roles.length > 1
                    ? [{ label: "Copy from…", onSelect: () => setDialog("copy") }]
                    : []),
                  "divider",
                  role.members > 0
                    ? {
                        label: "In use: cannot delete",
                        hint: "Give its people another role first",
                        onSelect: () => {},
                      }
                    : {
                        label: "Delete",
                        danger: true,
                        onSelect: () =>
                          deleteRole.mutate(role.id, { onSuccess: () => setShown(null) }),
                      },
                ]}
              />
            )}
          </div>
          {error && !dialog && <p className="m-0 text-[13px] text-signal">{error.message}</p>}
          <div className="flex flex-col overflow-hidden rounded-panel-lg border border-line bg-raised/25 shadow-1">
            {permissionGroups().map((area, i) => {
              const level = role.levels[area.id];
              const floor = levelIndex(area.id, lowestLevel(role, roles, area.id));
              const label = area.levels.find((l) => l.id === level)?.label ?? level;
              return (
                <div key={area.id} className={cn(i > 0 && "border-t border-line")}>
                  <div className="flex items-center gap-3 bg-raised/40 px-4 py-2.5">
                    <div className="min-w-0 flex-1">
                      <h3 className="m-0 text-[14px] font-medium text-ink">{area.label}</h3>
                      <p className="m-0 text-[12px] text-ink-3">{area.hint}</p>
                    </div>
                    {manage ? (
                      <Select
                        size="sm"
                        value={level}
                        aria-label={`${area.label} for ${role.name}`}
                        title={floor > 0 ? "Another role must manage people first" : undefined}
                        onChange={(event) =>
                          save(setAreaLevel(role.levels, area.id, event.target.value))
                        }
                        className={cn("w-32 shrink-0", level === "none" && "text-ink-3")}
                      >
                        {area.levels.map((l, at) => (
                          <option key={l.id} value={l.id} disabled={at < floor}>
                            {l.label}
                          </option>
                        ))}
                      </Select>
                    ) : (
                      <span
                        className={cn(
                          "shrink-0 text-[13px]",
                          level === "none" ? "text-ink-3" : "text-ink",
                        )}
                      >
                        {label}
                      </span>
                    )}
                  </div>
                  {area.rows.map((row) => {
                    const on = rowOn(role.levels, area.id, row.level);
                    return (
                      <div
                        key={row.permission}
                        className="flex items-center gap-3 border-t border-line py-2 pr-4 pl-6"
                      >
                        <span
                          className={cn(
                            "min-w-0 flex-1 text-[13px]",
                            on ? "text-ink-2" : "text-ink-3",
                          )}
                        >
                          {row.label}
                        </span>
                        <Switch
                          label={row.label}
                          checked={on}
                          disabled={!manage || levelIndex(area.id, row.level) <= floor}
                          onChange={(next) => save(setRow(role.levels, area.id, row.level, next))}
                        />
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </section>
      </div>

      <Section
        title="Player tools"
        intro={`Which tools ${role.name} sees on the recording page. QA, meters and the spectrogram are refused by the server too. Workspace owners and admins have them all.`}
      >
        {playerTools.map((tool) => (
          <Row key={tool} name={toolWords[tool].label} hint={toolWords[tool].hint} inline>
            <Switch
              label={toolWords[tool].label}
              checked={role.tools.includes(tool)}
              disabled={!manage}
              onChange={(on) => save(role.levels, withTool(role.tools, tool, on))}
            />
          </Row>
        ))}
      </Section>

      <section aria-label="Exceptions" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-[16px] font-medium text-ink">Exceptions</h2>
            <p className="mt-0.5 max-w-[620px] text-[13px] text-ink-3">
              {exceptions.length === 0
                ? "None: everyone has their role's tools, and a guest their review's."
                : "An exception's tools replace the role's for that person or group; a guest's stay within their review's."}
            </p>
          </div>
          {exceptionColumns.length > 1 && (
            <div className="flex items-center gap-2 text-[13px] text-ink-3 @3xl/app:hidden">
              <label htmlFor="exception-shown">Shown</label>
              <Select
                id="exception-shown"
                size="sm"
                value={exceptionFocus}
                onChange={(event) => setExceptionShown(event.target.value)}
                className="w-auto"
              >
                {exceptionColumns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.caption ? `${c.name} (${c.caption.toLowerCase()})` : c.name}
                  </option>
                ))}
              </Select>
            </div>
          )}
          {manage && (
            <Button variant="secondary" size="md" onClick={() => setDialog("exception")}>
              Add an exception
            </Button>
          )}
        </div>
        {exceptionColumns.length > 0 && (
          <PlayerToolsTable
            roles={exceptionColumns}
            manage={manage}
            column={(id) => (id === exceptionFocus ? "" : "hidden @3xl/app:table-cell")}
            onToggle={(id, tool, on) => {
              const exception = exceptions.find((e) => e.id === id);
              if (exception)
                excepting.update.mutate({ id, tools: withTool(exception.tools, tool, on) });
            }}
          />
        )}
        {exceptionError && <p className="m-0 text-[13px] text-signal">{exceptionError.message}</p>}
      </section>

      {dialog === "exception" && (
        <ExceptionDialog projectId={projectId} roles={roles} taken={exceptions} onClose={close} />
      )}
      {dialog === "compare" && <CompareDialog roles={roles} onClose={close} />}
      {dialog === "copy" && (
        <CopyFromDialog
          role={role}
          roles={roles}
          pending={updateRole.isPending}
          error={updateRole.error}
          onCopy={(source) => updateRole.mutate(copiedInto(role, source), { onSuccess: close })}
          onClose={close}
        />
      )}
      {dialog === "new" && (
        <RoleDialog
          title="New role"
          initial=""
          submitLabel="Add role"
          pending={createRole.isPending}
          error={createRole.error}
          // A new role starts by looking: it sees the files and reads the comments.
          onSubmit={(name) => create({ name, levels: levelsOf(["view", "read_comments"]) })}
          onClose={close}
        />
      )}
      {dialog === "rename" && (
        <RoleDialog
          title={`Rename ${role.name}`}
          initial={role.name}
          submitLabel="Rename"
          pending={updateRole.isPending}
          error={updateRole.error}
          onSubmit={(name) =>
            updateRole.mutate({ id: role.id, name, levels: role.levels }, { onSuccess: close })
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
