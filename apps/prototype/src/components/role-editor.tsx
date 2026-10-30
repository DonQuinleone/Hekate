import { useState } from "react";
import { Icon } from "~/components/icons";
import { Matrix, Row, Section } from "~/components/settings";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import { Input, Select } from "~/components/ui/input";
import { ActionMenu, MenuList, usePopover } from "~/components/ui/menu";
import { Switch } from "~/components/ui/toggle";
import type { Project, ProjectPermission, ProjectRole, Tool } from "~/data";
import { cn } from "~/lib/cn";
import { plural } from "~/lib/format";

/**
 * Access permissions: each area has levels, and a role holds one level per area. A level
 * includes the ones before it; each level past None is one permission, a row of its area.
 */
export const accessAreas: {
  id: string;
  label: string;
  hint: string;
  levels: string[];
  /** What each level past None allows, in the same order. */
  rows: string[];
}[] = [
  {
    id: "files",
    label: "Files",
    hint: "Folders, tracks, versions and variants",
    levels: ["None", "View", "Upload", "Organise", "Delete"],
    rows: [
      "View files and tracks",
      "Upload files, versions, takes",
      "Organise folders and tracks",
      "Delete files and folders",
    ],
  },
  {
    id: "comments",
    label: "Comments",
    hint: "Reading, writing, and triaging anyone's",
    levels: ["None", "Read", "Write", "Triage"],
    rows: ["Read comments", "Comment", "Triage feedback (resolve, assign)"],
  },
  {
    id: "reviews",
    label: "Reviews",
    hint: "Responding, requesting, inviting and revoking reviewers",
    levels: ["None", "Respond", "Request", "Manage"],
    rows: [
      "Respond to reviews and record decisions",
      "Request reviews",
      "Add or remove reviewers and guests",
    ],
  },
  {
    id: "downloads",
    label: "Downloads",
    hint: "The proxy, or the original, made for each person and logged",
    levels: ["None", "Proxy", "Original"],
    rows: ["Download proxies, marked and logged", "Download originals, marked and logged"],
  },
  {
    id: "takes",
    label: "Sessions and takes",
    hint: "Seeing the take manager, or editing it",
    levels: ["None", "View", "Edit"],
    rows: ["See sessions and takes", "Edit sessions and takes"],
  },
  {
    id: "production",
    label: "Production tools",
    hint: "Schedule, take log, score marking, stage plan",
    levels: ["None", "View", "Edit"],
    rows: ["See the production tools", "Use the production tools"],
  },
  {
    id: "workflow",
    label: "Workflow",
    hint: "Stages, statuses, categories and upload checks",
    levels: ["None", "View", "Edit"],
    rows: ["See the workflow", "Edit workflows"],
  },
  {
    id: "people",
    label: "Roles and people",
    hint: "Who is in the project and what they may do",
    levels: ["None", "View", "Manage"],
    rows: ["See who is in the project", "Manage roles and members"],
  },
  {
    id: "project",
    label: "Project",
    hint: "Settings, archiving and deletion",
    levels: ["None", "Edit", "Delete"],
    rows: ["Edit the project's settings", "Archive and delete the project"],
  },
];

/** The level a role starts at in each area, read off its permissions. */
export function accessOf(role: ProjectRole): Record<string, string> {
  const has = (p: ProjectPermission) => role.permissions.includes(p);
  const tool = (t: Tool) => role.tools.includes(t);
  return {
    files: has("delete")
      ? "Delete"
      : has("organise")
        ? "Organise"
        : has("upload")
          ? "Upload"
          : "View",
    comments: has("triage") ? "Triage" : has("comment") ? "Write" : "Read",
    reviews: has("manage_reviewers")
      ? "Manage"
      : has("request_reviews")
        ? "Request"
        : has("decide")
          ? "Respond"
          : "None",
    downloads: tool("download") ? "Original" : "Proxy",
    takes: tool("takes") ? "Edit" : "View",
    production: tool("production") ? "Edit" : "None",
    workflow: has("edit_workflows") ? "Edit" : "View",
    people: has("manage_roles") ? "Manage" : "View",
    project: has("delete") ? "Delete" : has("manage_roles") ? "Edit" : "None",
  };
}

/** The player's tools are on or off per role; downloads, takes and production are access levels. */
export const playerTools: Tool[] = [
  "qa",
  "meters",
  "spectrogram",
  "score",
  "compare",
  "loops",
  "normalise",
];

export const toolCopy: Record<Tool, { label: string; hint: string }> = {
  qa: { label: "QA", hint: "Findings, loudness, format and metadata" },
  meters: { label: "Meters", hint: "Peak, RMS, mid, side, correlation" },
  spectrogram: { label: "Spectrogram", hint: "Below, behind or instead of the waveform" },
  score: { label: "Score", hint: "The linked score beside the recording" },
  takes: { label: "Takes", hint: "Sessions, takes and the other options for a bar" },
  compare: { label: "Compare", hint: "Versions and variants on keys 1 to 4" },
  loops: { label: "Loops", hint: "Drag, nudge, pre and post roll" },
  normalise: { label: "Normalise", hint: "Level-matched playback, where the project allows it" },
  download: { label: "Download", hint: "The proxy or the original, watermarked and logged" },
  production: { label: "Production", hint: "Schedule, take log, score marking, stage plan" },
};

/** A role as the editor holds it: a level in each area and its tools. */
interface EditedRole {
  id: string;
  name: string;
  access: Record<string, string>;
  tools: Tool[];
}

/** A name not yet taken among the roles, for a copy of one. */
const copyName = (name: string, taken: string[]) => {
  let candidate = `${name} copy`;
  for (let n = 2; taken.includes(candidate); n++) candidate = `${name} copy ${n}`;
  return candidate;
};

/** "New role": a blank one, named first, or a copy of any role, made at once. */
function NewRoleMenu({
  roles,
  onBlank,
  onCopy,
}: {
  roles: EditedRole[];
  onBlank: () => void;
  onCopy: (role: EditedRole) => void;
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
            ...roles.map((r) => ({ label: r.name, onSelect: () => onCopy(r) })),
          ]}
        />
      )}
    </div>
  );
}

/**
 * Roles and access (#506): one role at a time, as XenForo edits its user groups. The roles
 * across the top, then the chosen one's permissions by area (each area's level sets every row
 * in it at once), its player tools, and the exceptions (decision 258) below.
 */
export function RolesAndAccess({ project, canRoles }: { project: Project; canRoles: boolean }) {
  const [roles, setRoles] = useState<EditedRole[]>(() =>
    project.roles.map((r) => ({ id: r.id, name: r.name, access: accessOf(r), tools: r.tools })),
  );
  const [shownId, setShownId] = useState(project.roles[0]?.id ?? "");
  const [dialog, setDialog] = useState<"blank" | "rename" | "copy" | "compare" | null>(null);
  const [copySource, setCopySource] = useState("");
  // Exceptions to the player tools (decision 258): a person's or a group's own.
  const [exceptions, setExceptions] = useState<{ id: string; label: string; tools: Tool[] }[]>([
    { id: "x-mira", label: "Mira Solberg (guest)", tools: ["score", "loops"] },
    {
      id: "x-soloists",
      label: "Soloists (group)",
      tools: ["qa", "meters", "score", "compare", "loops", "normalise"],
    },
  ]);
  const role = roles.find((r) => r.id === shownId) ?? roles[0];
  if (!role) return null;
  const members = (id: string) => project.members.filter((m) => m.roleId === id).length;
  const managers = roles.filter((r) => r.access.people === "Manage");
  const update = (change: Partial<EditedRole>) =>
    setRoles((list) => list.map((r) => (r.id === role.id ? { ...r, ...change } : r)));
  const setArea = (area: string, level: string) =>
    update({ access: { ...role.access, [area]: level } });
  const add = (from: EditedRole | null, name: string) => {
    const id = `r-new-${roles.length}`;
    setRoles((list) => [
      ...list,
      {
        id,
        name,
        access: from
          ? { ...from.access }
          : Object.fromEntries(
              accessAreas.map((a) => [
                a.id,
                a.id === "files" ? "View" : a.id === "comments" ? "Read" : "None",
              ]),
            ),
        tools: from ? [...from.tools] : ["score", "compare", "loops", "normalise"],
      },
    ]);
    setShownId(id);
  };
  const others = roles.filter((r) => r.id !== role.id);
  const source = others.find((r) => r.id === copySource) ?? others[0];
  const inUse = members(role.id) > 0;
  const close = () => setDialog(null);

  return (
    <>
      <div className="flex flex-col gap-6">
        <div className="flex flex-wrap items-center gap-1.5">
          <fieldset className="m-0 flex min-w-0 flex-wrap items-center gap-1.5 border-0 p-0">
            <legend className="sr-only">Role</legend>
            {roles.map((r) => (
              <button
                key={r.id}
                type="button"
                aria-pressed={r.id === role.id}
                onClick={() => setShownId(r.id)}
                className={cn(
                  "inline-flex h-7 max-w-[200px] cursor-pointer items-center rounded-chip border px-2.5 text-[13px] transition-colors",
                  r.id === role.id
                    ? "border-edge bg-raised text-ink shadow-1"
                    : "border-transparent text-ink-3 hover:text-ink",
                )}
              >
                <span className="truncate">{r.name}</span>
              </button>
            ))}
          </fieldset>
          {canRoles && (
            <NewRoleMenu
              roles={roles}
              onBlank={() => setDialog("blank")}
              onCopy={(from) =>
                add(
                  from,
                  copyName(
                    from.name,
                    roles.map((r) => r.name),
                  ),
                )
              }
            />
          )}
          <Button
            variant="quiet"
            size="sm"
            className="ml-auto"
            onClick={() => setDialog("compare")}
          >
            <Icon name="columns" size={14} />
            Compare
          </Button>
        </div>

        <section aria-label={role.name} className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-[16px] font-medium text-ink">{role.name}</h2>
              <p className="mt-0.5 text-[13px] text-ink-3">
                {members(role.id) === 0
                  ? "No one has this role yet"
                  : plural(members(role.id), "person", "people")}
              </p>
            </div>
            {canRoles && (
              <ActionMenu
                always
                label={role.name}
                actions={[
                  { label: "Rename…", onSelect: () => setDialog("rename") },
                  { label: "Copy from…", onSelect: () => setDialog("copy") },
                  "divider",
                  inUse
                    ? {
                        label: "In use: cannot delete",
                        hint: "Give its people another role first",
                        onSelect: () => {},
                      }
                    : {
                        label: "Delete",
                        danger: true,
                        onSelect: () => {
                          setRoles((list) => list.filter((r) => r.id !== role.id));
                          setShownId(roles[0]?.id ?? "");
                        },
                      },
                ]}
              />
            )}
          </div>
          <div className="flex flex-col overflow-hidden rounded-panel-lg border border-line bg-raised/25 shadow-1">
            {accessAreas.map((area, i) => {
              const level = role.access[area.id] ?? "None";
              const at = area.levels.indexOf(level);
              // The last role that manages people keeps that level (the project is never left
              // without someone to run it); production tools are for music projects.
              const floor =
                area.id === "people" && level === "Manage" && managers.length === 1 ? at : 0;
              const fixed = !canRoles || (area.id === "production" && project.profile !== "music");
              return (
                <div key={area.id} className={cn(i > 0 && "border-t border-line")}>
                  <div className="flex items-center gap-3 bg-raised/40 px-4 py-2.5">
                    <div className="min-w-0 flex-1">
                      <h3 className="text-[14px] font-medium text-ink">{area.label}</h3>
                      <p className="text-[12px] text-ink-3">{area.hint}</p>
                    </div>
                    <Select
                      value={level}
                      aria-label={`${area.label} for ${role.name}`}
                      title={floor ? "Another role must manage people first" : undefined}
                      disabled={fixed || floor > 0}
                      onChange={(e) => setArea(area.id, e.target.value)}
                      className={cn("h-7 w-32 text-[12px]", level === "None" && "text-ink-3")}
                    >
                      {area.levels.map((l) => (
                        <option key={l}>{l}</option>
                      ))}
                    </Select>
                  </div>
                  {area.rows.map((label, j) => {
                    const own = j + 1;
                    const on = at >= own;
                    return (
                      <div
                        key={label}
                        className="flex items-center gap-3 border-t border-line py-2 pr-4 pl-6"
                      >
                        <span
                          className={cn(
                            "min-w-0 flex-1 text-[13px]",
                            on ? "text-ink-2" : "text-ink-3",
                          )}
                        >
                          {label}
                        </span>
                        <Switch
                          label={label}
                          checked={on}
                          disabled={fixed || own <= floor}
                          onChange={(v) =>
                            setArea(area.id, area.levels[v ? own : own - 1] ?? "None")
                          }
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
        intro={`Which tools ${role.name} sees on the recording page. Downloads, takes and the production tools are levels above.`}
      >
        {playerTools.map((t) => (
          <Row key={t} name={toolCopy[t].label} hint={toolCopy[t].hint}>
            <Switch
              label={toolCopy[t].label}
              checked={role.tools.includes(t)}
              disabled={!canRoles}
              onChange={(on) =>
                update({
                  tools: on ? [...role.tools, t] : role.tools.filter((x) => x !== t),
                })
              }
            />
          </Row>
        ))}
      </Section>

      <Section
        title="Exceptions"
        intro="An exception's tools replace the role's for that person or group; a guest's stay within their review's."
        action={
          canRoles ? (
            <Button variant="ghost" size="md">
              Add an exception
            </Button>
          ) : undefined
        }
      >
        <Matrix
          heading="Tool"
          columns={exceptions.map((x) => ({ id: x.id, label: x.label }))}
          rows={playerTools.map((t) => ({
            id: t,
            label: toolCopy[t].label,
            hint: toolCopy[t].hint,
          }))}
          value={(row, col) =>
            exceptions.find((x) => x.id === col)?.tools.includes(row as Tool) ?? false
          }
          onToggle={
            canRoles
              ? (row, col) =>
                  setExceptions((list) =>
                    list.map((x) =>
                      x.id !== col
                        ? x
                        : {
                            ...x,
                            tools: x.tools.includes(row as Tool)
                              ? x.tools.filter((t) => t !== row)
                              : [...x.tools, row as Tool],
                          },
                    ),
                  )
              : undefined
          }
          locked={() => (!canRoles ? "Managed by whoever manages roles" : null)}
        />
      </Section>

      {(dialog === "blank" || dialog === "rename") && (
        <NameDialog
          title={dialog === "blank" ? "New role" : `Rename ${role.name}`}
          initial={dialog === "blank" ? "" : role.name}
          submit={dialog === "blank" ? "Add role" : "Rename"}
          onSubmit={(name) => {
            if (dialog === "blank") add(null, name);
            else update({ name });
            close();
          }}
          onClose={close}
        />
      )}
      {dialog === "copy" && source && (
        <Dialog
          title={`Copy into ${role.name}`}
          description={`Every level and every tool of the role you choose replaces ${role.name}'s. Its name and its people stay.`}
          onClose={close}
          width="sm"
          footer={
            <>
              <Button variant="ghost" onClick={close}>
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  update({ access: { ...source.access }, tools: [...source.tools] });
                  close();
                }}
              >
                Copy
              </Button>
            </>
          }
        >
          <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
            Copy from
            <Select value={source.id} onChange={(e) => setCopySource(e.target.value)}>
              {others.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </Select>
          </label>
        </Dialog>
      )}
      {dialog === "compare" && (
        <Dialog
          title="Compare roles"
          description="Every role's level in each area, and how many player tools it has."
          onClose={close}
          width="xl"
        >
          <div className="scroll-quiet overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className="px-2 py-2 text-left font-normal text-ink-3">Role</th>
                  {accessAreas.map((a) => (
                    <th key={a.id} className="px-2 py-2 text-left font-normal text-ink-3">
                      {a.label}
                    </th>
                  ))}
                  <th className="px-2 py-2 text-right font-normal text-ink-3">Tools</th>
                </tr>
              </thead>
              <tbody>
                {roles.map((r) => (
                  <tr key={r.id} className="border-t border-line">
                    <td className="px-2 py-2 text-ink">{r.name}</td>
                    {accessAreas.map((a) => (
                      <td
                        key={a.id}
                        className={cn(
                          "px-2 py-2",
                          r.access[a.id] === "None" ? "text-ink-3" : "text-ink-2",
                        )}
                      >
                        {r.access[a.id]}
                      </td>
                    ))}
                    <td className="tabular px-2 py-2 text-right text-ink-2">
                      {r.tools.filter((t) => playerTools.includes(t)).length}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Dialog>
      )}
    </>
  );
}

function NameDialog({
  title,
  initial,
  submit,
  onSubmit,
  onClose,
}: {
  title: string;
  initial: string;
  submit: string;
  onSubmit: (name: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial);
  return (
    <Dialog
      title={title}
      onClose={onClose}
      width="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!name.trim()} onClick={() => onSubmit(name.trim())}>
            {submit}
          </Button>
        </>
      }
    >
      <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
        Name
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="For example Conductor"
        />
      </label>
    </Dialog>
  );
}
