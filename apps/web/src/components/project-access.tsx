import {
  type AccessLevels,
  accessAreas,
  levelsOf,
  type PlayerTool,
  playerTools,
  type ToolException,
} from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useLayoutEffect, useRef, useState } from "react";
import { Loading } from "~/components/ui/states";
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
import { toolWords } from "./player-tools";
import { Row, Section } from "./settings";
import { Button } from "./ui/button";
import { Chip, ToggleChip } from "./ui/chip";
import { Checkbox } from "./ui/choice";
import { Dialog, useConfirm } from "./ui/dialog";
import { Input, Select } from "./ui/input";
import { ActionMenu, MenuList, usePopover } from "./ui/menu";
import { type Edges, edgesOf } from "./ui/sub-nav";
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
  member: "Member",
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
  editing,
  onClose,
}: {
  projectId: string;
  roles: ProjectRole[];
  taken: ToolException[];
  /** An exception whose tools are changed, in the same dialog as it was added (#585). */
  editing?: ToolException;
  onClose: () => void;
}) {
  const { data: members = [] } = useQuery(projectMembersQuery(projectId));
  const { data: guests = [] } = useQuery(projectGuestsQuery(projectId));
  const { data: groups = [] } = useQuery(projectGroupsQuery(projectId));
  const { create, update } = useToolExceptionMutations(projectId);
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
  const [tools, setTools] = useState<PlayerTool[] | null>(editing ? [...editing.tools] : null);
  const shown = tools ?? (chosen ? startFrom(chosen) : []);
  const saving = editing ? update : create;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (editing) {
      update.mutate({ id: editing.id, tools: shown }, { onSuccess: onClose });
      return;
    }
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
      title={editing ? `${editing.name}'s tools` : "Add exception"}
      description="Their tools in this project, in place of their role's. A guest keeps no tool their review leaves out."
      onClose={onClose}
      width="sm"
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        {editing ? null : choices.length === 0 ? (
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
        {(chosen || editing) && (
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
        {saving.error && <p className="m-0 text-[13px] text-signal">{saving.error.message}</p>}
        <div className="mt-1 flex justify-end gap-2">
          <Button type="button" variant="ghost" size="md" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            size="md"
            disabled={saving.isPending || (!editing && !chosen)}
          >
            {editing ? "Save" : "Add exception"}
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
  // On a phone (#673) its role column stays put and the far edge fades while more lies beyond.
  const scroller = useRef<HTMLElement>(null);
  const [edges, setEdges] = useState<Edges>({ start: false, end: false });
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const update = () => setEdges(edgesOf(el.scrollLeft, el.clientWidth, el.scrollWidth));
    update();
    el.addEventListener("scroll", update, { passive: true });
    const watch = new ResizeObserver(update);
    watch.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      watch.disconnect();
    };
  }, []);
  return (
    <Dialog
      title="Compare roles"
      description="Every role's level in each area, and how many player tools it has."
      onClose={onClose}
      width="xl"
    >
      {/* Scrolled from the keyboard too, where a phone is narrower than its nine areas. */}
      <section
        ref={scroller}
        aria-label="Every role's levels"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a region that scrolls must take focus to scroll from the keyboard.
        tabIndex={0}
        className="scroll-quiet overflow-x-auto rounded-control focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink-3"
        style={
          edges.end
            ? {
                maskImage: "linear-gradient(to right, black calc(100% - 32px), transparent)",
                WebkitMaskImage: "linear-gradient(to right, black calc(100% - 32px), transparent)",
              }
            : undefined
        }
      >
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr>
              <th className="label sticky left-0 z-10 bg-overlay px-2 py-2 text-left font-normal">
                Role
              </th>
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
                  className={cn(
                    "sticky left-0 z-10 bg-overlay px-2 py-2 text-left font-normal whitespace-nowrap text-ink",
                    edges.start && "shadow-[1px_0_0_var(--hk-line)]",
                  )}
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
 * header setting every row in it at once, then its player tools; the exceptions to the
 * tools (decision 258), listed apart above them (#585). Past six roles a choice of role
 * replaces the chips (#673), so the chrome stays one line. Those who manage roles
 * change them here.
 */
function Roles({ projectId, manage }: { projectId: string; manage: boolean }) {
  const { data: roles } = useQuery(projectRolesQuery(projectId));
  const { createRole, updateRole, deleteRole } = useProjectAccessMutations(projectId);
  const { data: exceptions = [] } = useQuery(projectToolExceptionsQuery(projectId));
  const excepting = useToolExceptionMutations(projectId);
  const [confirm, confirmation] = useConfirm();
  const [dialog, setDialog] = useState<"new" | "rename" | "copy" | "compare" | "exception" | null>(
    null,
  );
  const [shown, setShown] = useState<string | null>(null);
  // The exception whose tools are being changed, in the dialog that added it (#585).
  const [changing, setChanging] = useState<ToolException | null>(null);
  if (!roles) return <Loading size="panel" className="px-0" />;
  const role = roles.find((r) => r.id === shown) ?? roles[0];
  if (!role) return <p className="m-0 text-[13px] text-ink-3">This project has no roles.</p>;
  const error = updateRole.error ?? deleteRole.error ?? createRole.error;
  const exceptionError = excepting.remove.error;
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

  return (
    <>
      {/* The exceptions (decision 258, #585): apart from any role, as each replaces a role's
          tools for one person or group, a row each, captioned by what they are. */}
      <Section
        title="Exceptions"
        intro={
          exceptions.length === 0
            ? "None: everyone has their role's tools, and a guest their review's."
            : "An exception's tools replace the role's for that person or group; a guest's stay within their review's."
        }
        action={
          manage ? (
            <Button variant="secondary" size="md" onClick={() => setDialog("exception")}>
              <Icon name="plus" size={14} />
              Add exception
            </Button>
          ) : undefined
        }
      >
        {exceptions.length > 0
          ? exceptions.map((e) => (
              <Row
                key={e.id}
                inline
                name={
                  <span className="flex flex-wrap items-baseline gap-x-2">
                    {e.name}
                    <span className="text-[12px] text-ink-3">{kindWords[e.kind]}</span>
                  </span>
                }
                hint={
                  e.tools.length === 0 ? (
                    "No player tools"
                  ) : (
                    <span className="mt-1 flex flex-wrap gap-1">
                      {playerTools
                        .filter((t) => e.tools.includes(t))
                        .map((t) => (
                          <Chip key={t}>{toolWords[t].label}</Chip>
                        ))}
                    </span>
                  )
                }
              >
                {manage && (
                  <ActionMenu
                    label={e.name}
                    always
                    actions={[
                      { label: "Change tools…", onSelect: () => setChanging(e) },
                      "divider",
                      {
                        label: "Remove exception…",
                        danger: true,
                        onSelect: () =>
                          confirm({
                            title: `Remove ${e.name}'s exception?`,
                            description: "They have their role's tools in this project again.",
                            action: "Remove exception",
                            onConfirm: () => excepting.remove.mutateAsync(e.id),
                          }),
                      },
                    ]}
                  />
                )}
              </Row>
            ))
          : null}
      </Section>
      {exceptionError && <p className="-mt-6 text-[13px] text-signal">{exceptionError.message}</p>}

      <div className="flex flex-col gap-6">
        {/* One line of role chrome however many roles (#673): chips while they fit, past six a
            choice of role, as Discord's role settings list them. */}
        <div className="flex flex-wrap items-center gap-1.5">
          {roles.length > 6 ? (
            <Select
              aria-label="Role"
              value={role.id}
              onChange={(event) => setShown(event.target.value)}
              className="w-full max-w-64 @3xl/app:w-64"
            >
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </Select>
          ) : (
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
          )}
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
                        label: "Delete…",
                        hint: "In use: give its people another role first",
                        disabled: true,
                        onSelect: () => {},
                      }
                    : {
                        label: "Delete…",
                        danger: true,
                        onSelect: () =>
                          confirm({
                            title: `Delete the role ${role.name}?`,
                            description:
                              "Nobody holds it, so nobody loses access; it goes from the project's roles.",
                            action: "Delete role",
                            onConfirm: () =>
                              deleteRole.mutateAsync(role.id).then(() => setShown(null)),
                          }),
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
        intro={`Which tools ${role.name} sees in the player. QA, meters and the spectrogram are refused by the server too. Workspace owners and admins have them all.`}
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

      {dialog === "exception" && (
        <ExceptionDialog projectId={projectId} roles={roles} taken={exceptions} onClose={close} />
      )}
      {changing && (
        <ExceptionDialog
          projectId={projectId}
          roles={roles}
          taken={exceptions}
          editing={changing}
          onClose={() => setChanging(null)}
        />
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
      {confirmation}
    </>
  );
}

/** The project's roles and their levels, as its settings show them. */
export function ProjectRoles({ projectId }: { projectId: string }) {
  const can = useProjectCan(projectId);
  return <Roles projectId={projectId} manage={can("manage_roles")} />;
}
