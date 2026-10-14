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
import { GuestFields } from "./guest-fields";
import { Button } from "./ui/button";

const control =
  "h-8 rounded-control border border-edge bg-ground px-3 text-[13px] text-ink outline-none placeholder:text-ink-3 focus:border-ink-3";

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
      className="flex flex-col gap-4 rounded-panel border border-hairline bg-surface p-5"
    >
      <label className="flex max-w-80 flex-col gap-1.5">
        <span className="label">Name</span>
        <input
          className={control}
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
              <label className="flex cursor-pointer items-center gap-2 text-[13px] text-ink-2">
                <input
                  type="checkbox"
                  checked={people.includes(person.userId)}
                  onChange={() => toggle(person.userId)}
                  className="accent-[var(--hk-ink)]"
                />
                <span className="text-ink">{person.name}</span>
              </label>
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
  const [editing, setEditing] = useState<string | null>(null);
  const manage = can("manage_reviewers");
  return (
    <section aria-label="Groups" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="m-0 text-[15px] font-medium">Groups</h2>
          <p className="m-0 text-[13px] text-ink-3">
            Named sets of members and guests, asked together as one step of a review.
          </p>
        </div>
        {manage && editing === null && <Button onClick={() => setEditing("new")}>New group</Button>}
      </div>
      {editing === "new" && <GroupEditor projectId={projectId} onDone={() => setEditing(null)} />}
      {(error ?? remove.error) && (
        <p className="m-0 text-xs text-signal">{(error ?? remove.error)?.message}</p>
      )}
      {groups && groups.length === 0 && editing !== "new" && (
        <p className="m-0 text-[13px] text-ink-3">No groups yet.</p>
      )}
      {groups && groups.length > 0 && (
        <ul className="m-0 flex list-none flex-col border-t border-hairline p-0">
          {groups.map((group) =>
            editing === group.id ? (
              <li key={group.id} className="border-b border-hairline py-3">
                <GroupEditor projectId={projectId} group={group} onDone={() => setEditing(null)} />
              </li>
            ) : (
              <li
                key={group.id}
                className="grid min-h-12 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-hairline py-2.5"
              >
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-sm font-medium text-ink">{group.name}</span>
                  <span className="truncate text-xs text-ink-3">{peopleOf(group)}</span>
                </span>
                {manage && (
                  <span className="flex gap-3 text-xs">
                    <button
                      type="button"
                      onClick={() => setEditing(group.id)}
                      className="cursor-pointer border-0 bg-transparent p-0 text-ink-3 hover:text-ink"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      disabled={remove.isPending}
                      onClick={() => remove.mutate(group.id)}
                      className="cursor-pointer border-0 bg-transparent p-0 text-ink-3 hover:text-signal"
                    >
                      Delete
                    </button>
                  </span>
                )}
              </li>
            ),
          )}
        </ul>
      )}
    </section>
  );
}
