import {
  headCount,
  type LinkablePerson,
  outstanding,
  type Personnel,
  type PersonnelKind,
  type PersonnelLink,
  personnelKinds,
} from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, Fragment, useState } from "react";
import { Avatar } from "~/components/avatar";
import { Empty } from "~/components/empty";
import { Icon } from "~/components/icons";
import { ProductionNav } from "~/components/production-nav";
import { Button } from "~/components/ui/button";
import { Choice } from "~/components/ui/choice";
import { Dialog } from "~/components/ui/dialog";
import { Field } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { ActionMenu, Dropdown } from "~/components/ui/menu";
import { Segmented } from "~/components/ui/segmented";
import { cn } from "~/lib/cn";
import { personnelQuery, usePersonnel, useProjectCan } from "~/lib/queries";
import { ProjectFrame } from "./project";

const kindWords: Record<PersonnelKind, { heading: string; one: string }> = {
  artist: { heading: "Artists", one: "Artist" },
  ensemble: { heading: "Ensembles", one: "Ensemble" },
  staff: { heading: "Staff", one: "Staff" },
  other: { heading: "Others", one: "Other" },
};

/**
 * Personnel (#49), in Production as the prototype has it: artists, ensembles, staff and others,
 * with their session agreement and headphones, an ensemble's breakdown, and who each is in
 * Hekate. Those who see the production tools read it; those who use them change it.
 */
export function PersonnelPage({ projectId }: { projectId: string }) {
  const can = useProjectCan(projectId);
  const { data, error } = useQuery({
    ...personnelQuery(projectId),
    enabled: can("view_production"),
  });
  return (
    <ProjectFrame projectId={projectId} title="Personnel">
      {(project) => (
        <div className="fade-in mx-auto flex w-full max-w-[1100px] flex-col gap-5 px-5 py-6 @3xl/app:px-10">
          <ProductionNav projectId={projectId} current="personnel" can={can} />
          {!can("view_production") ? (
            <Empty
              title="Not among what your role shows"
              text="Personnel is shown to the roles the project's access gives the production tools."
            />
          ) : error ? (
            <p className="m-0 text-signal">{error.message}</p>
          ) : !data ? (
            <p className="m-0 text-ink-3">Loading</p>
          ) : (
            <PersonnelList
              projectId={projectId}
              personnel={data.personnel}
              people={data.people}
              canEdit={can("edit_production") && !project.archivedAt}
            />
          )}
        </div>
      )}
    </ProjectFrame>
  );
}

/** A yes or no beside someone: filled when it is done, dashed while it is not. */
function Flag({ on, label, title }: { on: boolean; label: string; title: string }) {
  return (
    <span
      className={cn("flex items-center gap-1.5 text-[12px]", on ? "text-ink-2" : "text-ink-3")}
      title={title}
    >
      <span
        aria-hidden="true"
        className={cn(
          "inline-block size-[9px] shrink-0 rounded-full",
          on ? "bg-ink" : "border-[1.5px] border-dashed border-ink-3",
        )}
      />
      <span className="sr-only">{on ? "Yes:" : "No:"}</span>
      {label}
    </span>
  );
}

/**
 * Whether someone has signed and needs headphones; for an ensemble whose players are being named,
 * how many of them have signed and how many need headphones.
 */
function Flags({ entry }: { entry: Personnel }) {
  const players = entry.sections.some((s) => s.members.length > 0);
  if (!players)
    return (
      <>
        <Flag on={entry.agreement} label="agreement" title="Session agreement signed" />
        <Flag on={entry.headphones} label="headphones" title="Needs headphones" />
      </>
    );
  const total = headCount(entry);
  const { unsigned, headphones } = outstanding(entry);
  return (
    <>
      <Flag
        on={unsigned === 0}
        label={`agreement ${total - unsigned}/${total}`}
        title={`${total - unsigned} of ${total} players have signed the session agreement`}
      />
      <Flag
        on={headphones > 0}
        label={`headphones ${headphones}`}
        title={`${headphones} of the named players need headphones`}
      />
    </>
  );
}

function PersonnelList({
  projectId,
  personnel,
  people,
  canEdit,
}: {
  projectId: string;
  personnel: Personnel[];
  people: LinkablePerson[];
  canEdit: boolean;
}) {
  const { remove } = usePersonnel(projectId);
  const [editing, setEditing] = useState<"new" | Personnel | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const addButton = (
    <Button variant="secondary" size="md" onClick={() => setEditing("new")}>
      <Icon name="plus" size={14} />
      Person
    </Button>
  );
  const groups = personnelKinds
    .map((kind) => ({ kind, rows: personnel.filter((p) => p.kind === kind) }))
    .filter((g) => g.rows.length > 0);
  return (
    <>
      {personnel.length === 0 ? (
        <Empty
          title="Nobody listed yet"
          text="Artists, ensembles, staff and others, with their agreement and headphone flags."
          action={
            canEdit ? (
              <Button variant="primary" onClick={() => setEditing("new")}>
                Add a person
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="flex flex-col gap-6">
          {groups.map(({ kind, rows }, g) => (
            <section
              key={kind}
              aria-label={kindWords[kind].heading}
              className="flex flex-col gap-2"
            >
              <div className="flex items-center gap-2">
                <span className="label">
                  {kindWords[kind].heading} · {rows.length}
                </span>
                {canEdit && g === 0 && <span className="ml-auto">{addButton}</span>}
              </div>
              <ul className="-mx-2 m-0 flex list-none flex-col p-0">
                {rows.map((p) => (
                  <li key={p.id} className="flex flex-col">
                    <div className="group flex items-center gap-3 rounded-panel px-2 py-2 transition-colors hover:bg-raised/60">
                      {p.link ? (
                        <Avatar
                          id={p.link.kind === "member" ? p.link.userId : p.link.guestId}
                          name={p.link.name}
                          size={28}
                        />
                      ) : (
                        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-raised text-ink-2">
                          <Icon name="users" size={13} />
                        </span>
                      )}
                      {/* The flags beside the name where there is room, under it on a phone. */}
                      <span className="flex min-w-0 flex-1 flex-col gap-1 @xl/app:flex-row @xl/app:items-center @xl/app:gap-3">
                        <span className="min-w-0 @xl/app:flex-1">
                          <span className="flex items-center gap-2 text-[14px] text-ink">
                            <span className="truncate">{p.name}</span>
                            {p.link && (
                              <span className="text-[12px] text-ink-3">{p.link.kind}</span>
                            )}
                          </span>
                          <span className="block truncate text-[13px] text-ink-3">
                            {[p.role, p.kind === "ensemble" ? `${headCount(p)} players` : ""]
                              .filter(Boolean)
                              .join(" · ")}
                          </span>
                        </span>
                        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                          <Flags entry={p} />
                        </span>
                      </span>
                      {p.kind === "ensemble" && p.sections.length > 0 && (
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-expanded={open === p.id}
                          onClick={() => setOpen(open === p.id ? null : p.id)}
                        >
                          {open === p.id ? "Hide" : "Breakdown"}
                        </Button>
                      )}
                      {canEdit && (
                        <ActionMenu
                          label={p.name}
                          actions={[
                            { label: "Edit", onSelect: () => setEditing(p) },
                            "divider",
                            { label: "Remove", danger: true, onSelect: () => remove.mutate(p.id) },
                          ]}
                        />
                      )}
                    </div>
                    {open === p.id && <Breakdown entry={p} />}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      {editing && (
        <EntryDialog
          projectId={projectId}
          entry={editing === "new" ? undefined : editing}
          people={people}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

/** An ensemble's sections: how many, how they divide, and the players named so far. */
function Breakdown({ entry }: { entry: Personnel }) {
  return (
    <div className="rise-in mx-2 mb-2 rounded-panel border border-line bg-raised/30 p-3">
      <table className="w-full table-fixed text-[13px]">
        <caption className="sr-only">{entry.name}, by section</caption>
        <colgroup>
          <col className="w-[28%]" />
          <col className="w-14" />
          <col />
        </colgroup>
        <tbody>
          {entry.sections.map((s) => (
            <Fragment key={s.id}>
              <tr className="border-b border-line last:border-b-0">
                <th scope="row" className="truncate py-1.5 text-left font-normal text-ink">
                  {s.name}
                </th>
                <td className="tabular py-1.5 text-ink-2">{Math.max(s.count, s.members.length)}</td>
                <td className="truncate py-1.5 text-ink-3">
                  {[
                    s.divisi ? `divisi ${s.divisi}` : "",
                    s.members.length > 0
                      ? s.members.map((m) => m.name).join(", ")
                      : "names to come",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </td>
              </tr>
            </Fragment>
          ))}
        </tbody>
      </table>
      {entry.seating && <p className="m-0 mt-2 text-[12px] text-ink-3">Seating: {entry.seating}</p>}
    </div>
  );
}

interface DraftPlayer {
  name: string;
  agreement: boolean;
  headphones: boolean;
}
interface DraftSection {
  key: number;
  name: string;
  count: string;
  divisi: string;
  members: DraftPlayer[];
}

let keys = 0;
const sectionOf = (s?: Personnel["sections"][number]): DraftSection => ({
  key: keys++,
  name: s?.name ?? "",
  count: String(s ? Math.max(s.count, s.members.length) : ""),
  divisi: s?.divisi ?? "",
  members: s?.members.map(({ id: _id, ...m }) => m) ?? [],
});

/** Adding someone, or changing them: an ensemble's sections and players with it. */
function EntryDialog({
  projectId,
  entry,
  people,
  onClose,
}: {
  projectId: string;
  entry?: Personnel;
  people: LinkablePerson[];
  onClose: () => void;
}) {
  const { add, change } = usePersonnel(projectId);
  const [name, setName] = useState(entry?.name ?? "");
  const [kind, setKind] = useState<PersonnelKind>(entry?.kind ?? "artist");
  const [role, setRole] = useState(entry?.role ?? "");
  const [agreement, setAgreement] = useState(entry?.agreement ?? false);
  const [headphones, setHeadphones] = useState(entry?.headphones ?? false);
  const [link, setLink] = useState<PersonnelLink | null>(
    entry?.link
      ? entry.link.kind === "member"
        ? { kind: "member", userId: entry.link.userId }
        : { kind: "guest", guestId: entry.link.guestId }
      : null,
  );
  const [sections, setSections] = useState<DraftSection[]>(entry?.sections.map(sectionOf) ?? []);
  const [seating, setSeating] = useState(entry?.seating ?? "");
  const saving = entry ? change : add;
  const linkedId = link ? (link.kind === "member" ? link.userId : link.guestId) : null;
  const linked = people.find((p) => p.kind === link?.kind && p.id === linkedId);
  const counted = sections.map((s) => (/^\d{1,3}$/.test(s.count.trim()) ? Number(s.count) : NaN));
  const valid =
    name.trim() !== "" &&
    (kind !== "ensemble" ||
      sections.every(
        (s, i) =>
          s.name.trim() !== "" &&
          Number.isFinite(counted[i]) &&
          s.members.length <= (counted[i] ?? 0) &&
          s.members.every((m) => m.name.trim() !== ""),
      ));
  const edit = (key: number, change: Partial<DraftSection>) =>
    setSections((all) => all.map((s) => (s.key === key ? { ...s, ...change } : s)));
  const save = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    const input = {
      name: name.trim(),
      kind,
      role: role.trim(),
      agreement,
      headphones,
      link,
      seating: kind === "ensemble" ? seating.trim() : "",
      sections:
        kind === "ensemble"
          ? sections.map((s, i) => ({
              name: s.name.trim(),
              count: counted[i] ?? 0,
              divisi: s.divisi.trim(),
              members: s.members.map((m) => ({ ...m, name: m.name.trim() })),
            }))
          : [],
    };
    if (entry) change.mutate({ id: entry.id, ...input }, { onSuccess: onClose });
    else add.mutate(input, { onSuccess: onClose });
  };
  return (
    <Dialog
      title={entry ? `Edit ${entry.name}` : "Add a person"}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="personnel-entry"
            disabled={!valid || saving.isPending}
          >
            {entry ? "Save" : "Add"}
          </Button>
        </>
      }
    >
      <form id="personnel-entry" onSubmit={save} className="flex flex-col gap-3">
        <Segmented
          label="Kind"
          value={kind}
          options={personnelKinds.map((k) => ({ value: k, label: kindWords[k].one }))}
          onChange={setKind}
        />
        <div className="grid grid-cols-1 gap-3 @xl/app:grid-cols-2">
          <Field label="Name" error={saving.error?.message}>
            <Input
              autoFocus
              value={name}
              maxLength={120}
              placeholder={kind === "ensemble" ? "Endless Hall Strings" : "Mira Solberg"}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label="Role">
            <Input
              value={role}
              maxLength={80}
              placeholder={kind === "ensemble" ? "Strings" : "Conductor"}
              onChange={(e) => setRole(e.target.value)}
            />
          </Field>
        </div>
        <Field
          label="In Hekate"
          hint="The member or guest this is, so they are one person throughout"
        >
          <Dropdown
            variant="field"
            value={linked ? `${linked.name} (${linked.kind})` : "Not linked"}
            actions={[
              { label: "Not linked", checked: link === null, onSelect: () => setLink(null) },
              ...(people.length > 0 ? ["divider" as const] : []),
              ...people.map((p) => ({
                label: `${p.name} (${p.kind})`,
                checked: p.kind === link?.kind && p.id === linkedId,
                onSelect: () =>
                  setLink(
                    p.kind === "member"
                      ? { kind: "member", userId: p.id }
                      : { kind: "guest", guestId: p.id },
                  ),
              })),
            ]}
          />
        </Field>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          <Choice checked={agreement} onChange={(e) => setAgreement(e.target.checked)}>
            Session agreement signed
          </Choice>
          <Choice checked={headphones} onChange={(e) => setHeadphones(e.target.checked)}>
            Needs headphones
          </Choice>
        </div>
        {kind === "ensemble" && (
          <>
            <div className="flex flex-col gap-3">
              <span className="label">Sections</span>
              {sections.map((s, i) => (
                <fieldset
                  key={s.key}
                  className="m-0 flex flex-col gap-2 rounded-panel border border-line p-3"
                >
                  <legend className="sr-only">Section {i + 1}</legend>
                  <div className="grid grid-cols-[1fr_5rem_6rem_auto] items-end gap-2">
                    <Field label="Section">
                      <Input
                        value={s.name}
                        maxLength={60}
                        placeholder="Violin I"
                        onChange={(e) => edit(s.key, { name: e.target.value })}
                      />
                    </Field>
                    <Field label="Players">
                      <Input
                        inputMode="numeric"
                        value={s.count}
                        onChange={(e) => edit(s.key, { count: e.target.value })}
                      />
                    </Field>
                    <Field label="Divisi">
                      <Input
                        value={s.divisi}
                        maxLength={40}
                        placeholder="2 + 2"
                        onChange={(e) => edit(s.key, { divisi: e.target.value })}
                      />
                    </Field>
                    <Button
                      variant="ghost"
                      size="md"
                      aria-label={`Remove ${s.name || `section ${i + 1}`}`}
                      onClick={() => setSections((all) => all.filter((x) => x.key !== s.key))}
                    >
                      <Icon name="trash" size={14} />
                    </Button>
                  </div>
                  {s.members.map((m, j) => (
                    <div
                      key={`${s.key}-${String(j)}`}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1"
                    >
                      <Input
                        aria-label={`Player ${j + 1} of ${s.name || "the section"}`}
                        className="min-w-0 flex-1"
                        value={m.name}
                        maxLength={80}
                        placeholder="Name"
                        onChange={(e) =>
                          edit(s.key, {
                            members: s.members.map((x, k) =>
                              k === j ? { ...x, name: e.target.value } : x,
                            ),
                          })
                        }
                      />
                      <Choice
                        checked={m.agreement}
                        onChange={(e) =>
                          edit(s.key, {
                            members: s.members.map((x, k) =>
                              k === j ? { ...x, agreement: e.target.checked } : x,
                            ),
                          })
                        }
                      >
                        Agreement
                      </Choice>
                      <Choice
                        checked={m.headphones}
                        onChange={(e) =>
                          edit(s.key, {
                            members: s.members.map((x, k) =>
                              k === j ? { ...x, headphones: e.target.checked } : x,
                            ),
                          })
                        }
                      >
                        Headphones
                      </Choice>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Remove ${m.name || `player ${j + 1}`}`}
                        onClick={() =>
                          edit(s.key, { members: s.members.filter((_, k) => k !== j) })
                        }
                      >
                        <Icon name="close" size={12} />
                      </Button>
                    </div>
                  ))}
                  <div>
                    <Button
                      variant="quiet"
                      size="sm"
                      onClick={() =>
                        edit(s.key, {
                          members: [
                            ...s.members,
                            { name: "", agreement: false, headphones: false },
                          ],
                          // A player named beyond the count adds to it.
                          count: String(Math.max(Number(s.count) || 0, s.members.length + 1)),
                        })
                      }
                    >
                      <Icon name="plus" size={12} />
                      Name a player
                    </Button>
                  </div>
                </fieldset>
              ))}
              <div>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setSections((all) => [...all, sectionOf()])}
                >
                  <Icon name="plus" size={12} />
                  Section
                </Button>
              </div>
            </div>
            <Field label="Seating and forces">
              <Input
                value={seating}
                maxLength={400}
                placeholder="Antiphonal violins; basses behind the cellos"
                onChange={(e) => setSeating(e.target.value)}
              />
            </Field>
          </>
        )}
      </form>
    </Dialog>
  );
}
