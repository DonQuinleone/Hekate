import type { GuestInput, PersonInput } from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import {
  type ProjectGroup,
  projectGroupsQuery,
  projectMembersQuery,
  useGroupMutations,
  useProjectCan,
} from "~/lib/queries";
import { AvatarRow } from "./avatar";
import { GuestFields } from "./guest-fields";
import { Icon } from "./icons";
import { Card, SectionHead } from "./page";
import { Button } from "./ui/button";
import { Choice } from "./ui/choice";
import { Dialog } from "./ui/dialog";
import { Input } from "./ui/input";
import { ActionMenu } from "./ui/menu";

const keyOf = (p: PersonInput) =>
  typeof p === "string" ? `member:${p}` : `guest:${p.email.toLowerCase()}`;

/** How a group's people read in a line: "Mira Solberg, Ines Arlow (Conductor, guest)". */
export const peopleOf = (group: ProjectGroup) =>
  group.members
    .map((m) => (m.guest ? `${m.name} (${m.label ? `${m.label}, guest` : "guest"})` : m.name))
    .join(", ");

/** Name a group and choose its people: members with a role in the project, and guests. */
function GroupEditor({
  projectId,
  group,
  onDone,
}: {
  projectId: string;
  group?: ProjectGroup;
  onDone: () => void;
}) {
  const { data: members } = useQuery(projectMembersQuery(projectId));
  const { create, update } = useGroupMutations(projectId);
  const [name, setName] = useState(group?.name ?? "");
  const [people, setPeople] = useState<PersonInput[]>(
    group?.members.map((m) =>
      m.guest ? { name: m.name, email: m.email, label: m.label ?? undefined } : (m.userId ?? ""),
    ) ?? [],
  );
  const save = group ? update : create;
  const toggle = (userId: string) =>
    setPeople(people.includes(userId) ? people.filter((p) => p !== userId) : [...people, userId]);
  const addGuest = (guest: GuestInput) => {
    if (!people.some((p) => keyOf(p) === keyOf(guest))) setPeople([...people, guest]);
  };
  const guests = people.filter((p): p is GuestInput => typeof p !== "string");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const input = { name, members: people };
    const done = { onSuccess: onDone };
    if (group) update.mutate({ ...input, groupId: group.id }, done);
    else create.mutate(input, done);
  };
  return (
    <form
      onSubmit={submit}
      aria-label={group ? `Edit ${group.name}` : "New group"}
      className="flex flex-col gap-4"
    >
      <label className="flex max-w-80 flex-col gap-1.5">
        <span className="label">Name</span>
        <Input
          className="h-8 text-[13px]"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Soloists"
        />
      </label>
      <div className="flex flex-col gap-1.5">
        <span className="label">People</span>
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {(members ?? []).map((person) => (
            <li key={person.userId}>
              <Choice
                checked={people.includes(person.userId)}
                onChange={() => toggle(person.userId)}
                className="items-center text-[13px]"
              >
                {person.name}
              </Choice>
            </li>
          ))}
          {guests.map((guest) => (
            <li key={keyOf(guest)} className="flex items-center gap-2 text-[13px] text-ink-2">
              <span className="text-ink">{guest.name}</span>
              <span className="truncate text-xs text-ink-3">
                {guest.label ? `${guest.label}, guest` : "Guest"} · {guest.email}
              </span>
              <button
                type="button"
                onClick={() => setPeople(people.filter((p) => p !== guest))}
                className="ml-auto cursor-pointer border-0 bg-transparent p-0 text-xs text-ink-3 hover:text-signal"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
        <GuestFields onAdd={addGuest} />
      </div>
      {save.error && <p className="m-0 text-xs text-signal">{save.error.message}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          disabled={!name.trim() || people.length === 0 || save.isPending}
        >
          {group ? "Save group" : "Create group"}
        </Button>
      </div>
    </form>
  );
}

/**
 * A project's groups of reviewers. A review can ask a group as one step: everyone in it at
 * once, and in a sequence the next step waits for all of them.
 */
export function ReviewerGroups({ projectId }: { projectId: string }) {
  const { data: groups, error } = useQuery(projectGroupsQuery(projectId));
  const can = useProjectCan(projectId);
  const { remove } = useGroupMutations(projectId);
  const [editing, setEditing] = useState<ProjectGroup | "new" | null>(null);
  const manage = can("manage_reviewers");
  const close = () => setEditing(null);
  return (
    <section aria-label="Groups" className="flex flex-col gap-3">
      <SectionHead
        title="Groups"
        hint="people a review or a role can name as one"
        action={
          manage && (
            <Button variant="secondary" size="md" onClick={() => setEditing("new")}>
              <Icon name="plus" size={14} />
              New group
            </Button>
          )
        }
      />
      {(error ?? remove.error) && (
        <p className="m-0 text-xs text-signal">{(error ?? remove.error)?.message}</p>
      )}
      {groups && groups.length === 0 && (
        <Card className="px-4 py-4 text-[13px] text-ink-3">
          No groups yet. A group such as Soloists is a set of people, members and reviewers alike,
          that a review or a tool exception can name as one: ask the group, and everyone in it is
          asked together.
        </Card>
      )}
      {groups && groups.length > 0 && (
        <ul className="m-0 grid list-none grid-cols-1 gap-3 p-0 @3xl/app:grid-cols-2 @6xl/app:grid-cols-3">
          {groups.map((group) => (
            <li key={group.id} className="min-w-0">
              <Card className="flex items-center gap-3 px-4 py-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-panel bg-raised text-ink-2">
                  <Icon name="users" size={16} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] text-ink">{group.name}</span>
                  <span className="block truncate text-[12px] text-ink-3">{peopleOf(group)}</span>
                </span>
                <span className="hidden @3xl/app:inline-flex">
                  <AvatarRow
                    people={group.members.map((m) => ({ id: m.userId ?? m.email, name: m.name }))}
                    max={3}
                  />
                </span>
                {manage && (
                  <ActionMenu
                    always
                    label={group.name}
                    actions={[
                      { label: "Edit…", onSelect: () => setEditing(group) },
                      "divider",
                      { label: "Delete", danger: true, onSelect: () => remove.mutate(group.id) },
                    ]}
                  />
                )}
              </Card>
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <Dialog
          title={editing === "new" ? "New group" : `Edit ${editing.name}`}
          description="A set of people, members and reviewers alike, that a review or a role can be given to as one. Ask the group, and everyone in it is asked together."
          onClose={close}
          width="md"
        >
          <GroupEditor
            projectId={projectId}
            group={editing === "new" ? undefined : editing}
            onDone={close}
          />
        </Dialog>
      )}
    </section>
  );
}
