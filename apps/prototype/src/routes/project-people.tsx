import { useState } from "react";
import { Avatar, AvatarRow } from "~/components/avatar";
import { Icon } from "~/components/icons";
import { Card, SectionHead } from "~/components/page";
import { PermissionsDialog } from "~/components/permissions";
import { Dot } from "~/components/status";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import { Input, Select, Textarea } from "~/components/ui/input";
import { ActionMenu } from "~/components/ui/menu";
import { groups, guests, initials, type Project, personById, reviews } from "~/data";
import { formatDate } from "~/lib/format";
import { useViewer } from "~/viewer/context";

/**
 * Two kinds of people, never conflated: members have accounts and a role in the project;
 * reviewers are guests reaching only what a review gives them, by a link, for a while.
 */
export function People({ project }: { project: Project }) {
  const viewer = useViewer();
  const manage = viewer.can(project.id, "manage_roles");
  const manageReviewers = viewer.can(project.id, "manage_reviewers");
  const projectGroups = groups.filter((g) => g.projectId === project.id);
  const [dialog, setDialog] = useState<"member" | "group" | "reviewer" | null>(null);
  const [groupId, setGroupId] = useState<string | null>(null);
  // A reviewer invited from here (#502): a guest of the project, asked into reviews later.
  const [invited, setInvited] = useState<
    { name: string; email: string; label: string; note: string; groupId: string }[]
  >([]);
  const [invite, setInvite] = useState({ name: "", email: "", label: "", note: "", groupId: "" });
  const [permissionsFor, setPermissionsFor] = useState<{ id: string; guest: boolean } | null>(null);
  const memberIds = new Set(project.members.map((m) => m.personId));
  const projectGuests = guests.filter((g) => !memberIds.has(g.personId) || g.personId === "p-mira");
  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <SectionHead
          title="Members"
          hint={`${project.members.length} with accounts`}
          action={
            manage && (
              <Button variant="secondary" size="md" onClick={() => setDialog("member")}>
                <Icon name="userPlus" size={14} />
                Add member
              </Button>
            )
          }
        />
        <Card>
          <ul className="list-none p-0">
            {project.members.map((m) => {
              const p = personById(m.personId);
              const role = project.roles.find((r) => r.id === m.roleId);
              return (
                <li
                  key={m.personId}
                  className="group grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b border-line px-4 py-2.5 last:border-b-0 @3xl/app:grid-cols-[auto_minmax(0,1fr)_150px_150px_auto]"
                >
                  <Avatar personId={m.personId} size={30} />
                  <span className="min-w-0">
                    <span className="block truncate text-[14px] text-ink">
                      {p.name}
                      {m.personId === viewer.personId && <span className="text-ink-3"> · you</span>}
                    </span>
                    <span className="block truncate text-[13px] text-ink-3">{p.email}</span>
                  </span>
                  <span className="hidden text-[13px] text-ink-3 @3xl/app:block">
                    Active {m.personId === "p-ines" ? "yesterday" : "today"}
                  </span>
                  {manage ? (
                    <Select defaultValue={m.roleId} className="h-8 w-full text-[13px]">
                      {project.roles.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <span className="text-[13px] text-ink-2">{role?.name}</span>
                  )}
                  <span className="w-8">
                    {manage && (
                      <ActionMenu
                        label={p.name}
                        actions={[
                          {
                            label: "Review permissions…",
                            onSelect: () => setPermissionsFor({ id: m.personId, guest: false }),
                          },
                          "divider",
                          { label: "Remove from project", danger: true, onSelect: () => {} },
                        ]}
                      />
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </Card>
      </section>

      <section className="flex flex-col gap-3">
        <SectionHead
          title="Reviewers"
          hint="guests, who reach a review by link"
          action={
            manageReviewers && (
              <Button variant="secondary" size="md" onClick={() => setDialog("reviewer")}>
                <Icon name="userPlus" size={14} />
                Invite a reviewer
              </Button>
            )
          }
        />
        <Card>
          <ul className="list-none p-0">
            {projectGuests.map((g) => {
              const p = personById(g.personId);
              const theirs = reviews.filter(
                (r) =>
                  r.projectId === project.id && r.reviewers.some((x) => x.personId === g.personId),
              );
              const open = theirs.filter((r) => r.status === "open");
              return (
                <li
                  key={g.personId}
                  className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b border-line px-4 py-2.5 last:border-b-0 @3xl/app:grid-cols-[auto_minmax(0,1fr)_170px_170px_auto]"
                >
                  <Avatar personId={g.personId} size={30} />
                  <span className="min-w-0">
                    <span className="block truncate text-[14px] text-ink">
                      {p.name} <span className="text-ink-3">· {g.label}</span>
                    </span>
                    <span className="block truncate text-[13px] text-ink-3">{p.email}</span>
                  </span>
                  <span className="hidden items-center gap-2 text-[13px] text-ink-2 @3xl/app:flex">
                    <Dot state={g.linkSentAt ? "approved" : "cancelled"} />
                    {g.linkSentAt ? `Link sent ${formatDate(g.linkSentAt)}` : "Revoked"}
                  </span>
                  <span className="hidden text-[13px] text-ink-3 @3xl/app:block">
                    {open.length} open of {theirs.length} reviews · until 31 Oct
                  </span>
                  <span className="flex items-center gap-1">
                    {manageReviewers && (
                      <ActionMenu
                        always
                        label={p.name}
                        actions={[
                          {
                            label: "Review permissions…",
                            onSelect: () => setPermissionsFor({ id: g.personId, guest: true }),
                          },
                          { label: "Send a new link", onSelect: () => {} },
                          { label: "Change label…", onSelect: () => {} },
                          "divider",
                          { label: "Revoke access", danger: true, onSelect: () => {} },
                        ]}
                      />
                    )}
                  </span>
                </li>
              );
            })}
            {invited.map((g) => (
              <li
                key={g.email}
                className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b border-line px-4 py-2.5 last:border-b-0 @3xl/app:grid-cols-[auto_minmax(0,1fr)_170px_170px_auto]"
              >
                <span
                  aria-hidden="true"
                  className="flex size-[30px] shrink-0 items-center justify-center rounded-full bg-raised text-[11px] font-medium text-ink-2"
                >
                  {initials(g.name)}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[14px] text-ink">
                    {g.name}
                    {g.label && <span className="text-ink-3"> · {g.label}</span>}
                  </span>
                  <span className="block truncate text-[13px] text-ink-3">
                    {g.email}
                    {g.note && ` · ${g.note}`}
                  </span>
                </span>
                <span className="hidden items-center gap-2 text-[13px] text-ink-2 @3xl/app:flex">
                  <Dot state="waiting" />
                  Not sent a link
                </span>
                <span className="hidden text-[13px] text-ink-3 @3xl/app:block">
                  {g.groupId
                    ? `In ${projectGroups.find((x) => x.id === g.groupId)?.name ?? "a group"}`
                    : "Not asked yet"}
                </span>
                <span className="flex items-center gap-1">
                  {manageReviewers && (
                    <ActionMenu
                      always
                      label={g.name}
                      actions={[
                        { label: "Review permissions…", onSelect: () => {} },
                        { label: "Change label…", onSelect: () => {} },
                        "divider",
                        { label: "Remove from the project", danger: true, onSelect: () => {} },
                      ]}
                    />
                  )}
                </span>
              </li>
            ))}
            {projectGuests.length === 0 && invited.length === 0 && (
              <li className="px-4 py-4 text-[13px] text-ink-3">
                No reviewers yet. Invite one here, or ask someone by email in a review.
              </li>
            )}
          </ul>
        </Card>
        <p className="text-[12px] text-ink-3">
          A reviewer's permissions set here apply to every review they are invited to; a review can
          override them for its own items.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <SectionHead
          title="Groups"
          hint="people a review or a tool exception can name as one"
          action={
            manageReviewers && (
              <Button
                variant="secondary"
                size="md"
                onClick={() => {
                  setGroupId(null);
                  setDialog("group");
                }}
              >
                <Icon name="plus" size={14} />
                New group
              </Button>
            )
          }
        />
        <div className="grid gap-3 @3xl/app:grid-cols-2 @6xl/app:grid-cols-3">
          {projectGroups.map((g) => (
            <Card key={g.id} className="flex items-center gap-3 px-4 py-3">
              <span className="flex size-9 items-center justify-center rounded-panel bg-raised text-ink-2">
                <Icon name="users" size={16} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] text-ink">{g.name}</span>
                <span className="block truncate text-[12px] text-ink-3">
                  {g.personIds.map((id) => personById(id).name.split(" ")[0]).join(", ")}
                </span>
              </span>
              <AvatarRow personIds={g.personIds} size={22} />
              {manageReviewers && (
                <ActionMenu
                  always
                  label={g.name}
                  actions={[
                    {
                      label: "Edit",
                      onSelect: () => {
                        setGroupId(g.id);
                        setDialog("group");
                      },
                    },
                    { label: "Delete", danger: true, onSelect: () => {} },
                  ]}
                />
              )}
            </Card>
          ))}
        </div>
      </section>

      {permissionsFor && (
        <PermissionsDialog
          personId={permissionsFor.id}
          guest={permissionsFor.guest}
          onClose={() => setPermissionsFor(null)}
        />
      )}
      {dialog === "member" && (
        <Dialog
          title="Add a member to the project"
          onClose={() => setDialog(null)}
          width="sm"
          footer={
            <>
              <Button variant="ghost" onClick={() => setDialog(null)}>
                Cancel
              </Button>
              <Button variant="primary" onClick={() => setDialog(null)}>
                Add
              </Button>
            </>
          }
        >
          <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
            Who
            <Select defaultValue="">
              <option value="">Choose a member of the workspace</option>
              <option value="p-tomas">{personById("p-tomas").name}</option>
            </Select>
          </label>
          <label className="mt-3 flex flex-col gap-1.5 text-[13px] text-ink-2">
            Role
            <Select defaultValue="r-reviewer">
              {project.roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </Select>
          </label>
          <p className="mt-3 text-[12px] text-ink-3">
            Someone not in the workspace yet is invited from Members first.
          </p>
        </Dialog>
      )}
      {dialog === "reviewer" && (
        <Dialog
          title="Invite a reviewer"
          description="A guest of this project, reached by link when a review asks them. Nothing is sent until then."
          onClose={() => setDialog(null)}
          width="sm"
          footer={
            <>
              <Button variant="ghost" onClick={() => setDialog(null)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={!invite.name.trim() || !invite.email.includes("@")}
                onClick={() => {
                  setInvited([...invited, invite]);
                  setInvite({ name: "", email: "", label: "", note: "", groupId: "" });
                  setDialog(null);
                }}
              >
                Add reviewer
              </Button>
            </>
          }
        >
          <form
            aria-label="Invite a reviewer"
            className="flex flex-col gap-3"
            onSubmit={(e) => e.preventDefault()}
          >
            <div className="grid gap-3 @md:grid-cols-2">
              <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
                Name
                <Input
                  value={invite.name}
                  onChange={(e) => setInvite({ ...invite, name: e.target.value })}
                  autoComplete="off"
                />
              </label>
              <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
                Email
                <Input
                  type="email"
                  value={invite.email}
                  onChange={(e) => setInvite({ ...invite, email: e.target.value })}
                  autoComplete="off"
                />
              </label>
            </div>
            <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
              Role, as shown beside their name
              <Input
                value={invite.label}
                onChange={(e) => setInvite({ ...invite, label: e.target.value })}
                placeholder="Conductor, Composer, Label (optional)"
                autoComplete="off"
              />
            </label>
            <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
              Group
              <Select
                value={invite.groupId}
                onChange={(e) => setInvite({ ...invite, groupId: e.target.value })}
              >
                <option value="">None</option>
                {projectGroups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </Select>
            </label>
            <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
              Note
              <Textarea
                rows={2}
                value={invite.note}
                onChange={(e) => setInvite({ ...invite, note: e.target.value })}
                placeholder="Who they are to the project; kept here, for the team (optional)"
              />
            </label>
          </form>
        </Dialog>
      )}
      {dialog === "group" && (
        <Dialog
          title={groupId ? "Edit group" : "New group"}
          description="A set of people, members and reviewers alike, that a review or a tool exception can name as one. Ask the group, and everyone in it is asked together."
          onClose={() => setDialog(null)}
          width="sm"
          footer={
            <>
              <Button variant="ghost" onClick={() => setDialog(null)}>
                Cancel
              </Button>
              <Button variant="primary" onClick={() => setDialog(null)}>
                Save
              </Button>
            </>
          }
        >
          <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
            Name
            <Input
              defaultValue={projectGroups.find((g) => g.id === groupId)?.name ?? ""}
              placeholder="Label stakeholders"
            />
          </label>
          <div className="mt-3 flex flex-col gap-1.5 text-[13px] text-ink-2">
            People
            {[...project.members.map((m) => m.personId), ...projectGuests.map((g) => g.personId)]
              .filter((v, i, a) => a.indexOf(v) === i)
              .map((id) => (
                <label key={id} className="flex items-center gap-2 text-[14px] text-ink">
                  <input
                    type="checkbox"
                    defaultChecked={projectGroups
                      .find((g) => g.id === groupId)
                      ?.personIds.includes(id)}
                  />
                  <Avatar personId={id} size={20} />
                  {personById(id).name}
                  {!memberIds.has(id) && <span className="text-[12px] text-ink-3">reviewer</span>}
                </label>
              ))}
          </div>
        </Dialog>
      )}
    </div>
  );
}
