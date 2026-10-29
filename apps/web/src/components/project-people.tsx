import { applyPermissions, reviewerDefaults } from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { Avatar } from "~/components/avatar";
import { ReviewerGroups } from "~/components/groups";
import { Icon } from "~/components/icons";
import { Card, SectionHead } from "~/components/page";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import { Field } from "~/components/ui/field";
import { Input, Select, Textarea } from "~/components/ui/input";
import { ActionMenu } from "~/components/ui/menu";
import { StatusDot } from "~/components/ui/status";
import { formatDates } from "~/lib/locale";
import { standingChange } from "~/lib/permissions";
import {
  type KnownGuest,
  membersQuery,
  meQuery,
  projectGroupsQuery,
  projectGuestsQuery,
  projectMembersQuery,
  projectReviewerGrantsQuery,
  projectRolesQuery,
  useProjectAccessMutations,
  useProjectCan,
  useProjectGuestMutations,
  useProjectReviewerGrant,
  workspaceSettingsQuery,
} from "~/lib/queries";
import { ReviewerPermissionsEditor } from "./reviewer-permissions";

const dayFormat = formatDates({ day: "numeric", month: "short" });

/**
 * Two kinds of people, never conflated (#143): members have accounts and a role in the
 * project; reviewers are guests, reaching only what a review gives them, by a link.
 */
export function ProjectPeople({ projectId }: { projectId: string }) {
  return (
    <div className="flex flex-col gap-8">
      <Members projectId={projectId} />
      <Reviewers projectId={projectId} />
      <ReviewerGroups projectId={projectId} />
    </div>
  );
}

/** The members with a role here: change it, take it away, or give one to someone new. */
function Members({ projectId }: { projectId: string }) {
  const can = useProjectCan(projectId);
  const manage = can("manage_roles");
  const { data: holders, error: loadError } = useQuery(projectMembersQuery(projectId));
  const { data: roles } = useQuery(projectRolesQuery(projectId));
  const { data: me } = useQuery(meQuery);
  const { assign, remove } = useProjectAccessMutations(projectId);
  const manageReviewers = can("manage_reviewers");
  const { data: grants } = useQuery({
    ...projectReviewerGrantsQuery(projectId),
    enabled: manageReviewers,
  });
  const [adding, setAdding] = useState(false);
  const [granting, setGranting] = useState<Grantee | null>(null);
  const error = loadError ?? assign.error ?? remove.error;
  return (
    <section aria-label="Members" className="flex flex-col gap-3">
      <SectionHead
        title="Members"
        hint={
          holders
            ? `${holders.length} with ${holders.length === 1 ? "an account" : "accounts"}`
            : undefined
        }
        action={
          manage && (
            <Button variant="secondary" size="md" onClick={() => setAdding(true)}>
              <Icon name="userPlus" size={14} />
              Add member
            </Button>
          )
        }
      />
      {error && !adding && <p className="text-[13px] text-signal">{error.message}</p>}
      <Card>
        <ul className="m-0 list-none p-0">
          {!holders && <li className="px-4 py-4 text-[13px] text-ink-3">Loading</li>}
          {holders?.length === 0 && (
            <li className="px-4 py-4 text-[13px] text-ink-3">
              Nobody has a role here yet.{" "}
              {manage ? "Add members to give them one." : "Workspace admins can add them."}
            </li>
          )}
          {holders?.map((m) => {
            const role = roles?.find((r) => r.id === m.roleId);
            return (
              <li
                key={m.userId}
                className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-3 border-b border-line px-4 py-2.5 last:border-b-0 @3xl/app:grid-cols-[auto_minmax(0,1fr)_160px_auto]"
              >
                <Avatar id={m.userId} name={m.name} size={30} />
                <span className="min-w-0">
                  <span className="block truncate text-[14px] text-ink">
                    {m.name}
                    {m.userId === me?.user.id && <span className="text-ink-3"> · you</span>}
                    {grants?.some((g) => g.userId === m.userId) && (
                      <span className="text-ink-3"> · own review permissions</span>
                    )}
                  </span>
                  <span className="block truncate text-[13px] text-ink-3">{m.email}</span>
                </span>
                {manage && roles ? (
                  <Select
                    size="sm"
                    value={m.roleId}
                    aria-label={`Role of ${m.name}`}
                    onChange={(event) =>
                      assign.mutate({ userId: m.userId, roleId: event.target.value })
                    }
                    className="w-32 @3xl/app:w-full"
                  >
                    {roles.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <span className="text-[13px] text-ink-2">{role?.name}</span>
                )}
                {manage || manageReviewers ? (
                  <ActionMenu
                    always
                    label={m.name}
                    actions={[
                      ...(manageReviewers
                        ? [
                            {
                              label: "Review permissions…",
                              onSelect: () =>
                                setGranting({ kind: "member", id: m.userId, name: m.name }),
                            },
                          ]
                        : []),
                      ...(manage && manageReviewers ? ["divider" as const] : []),
                      ...(manage
                        ? [
                            {
                              label: "Remove from project",
                              danger: true,
                              onSelect: () => remove.mutate(m.userId),
                            },
                          ]
                        : []),
                    ]}
                  />
                ) : (
                  <span className="hidden @3xl/app:block" />
                )}
              </li>
            );
          })}
        </ul>
      </Card>
      <p className="text-[12px] text-ink-3">
        Workspace owners and admins can do everything in every project, with a role here or not.
      </p>
      {adding && <AddMember projectId={projectId} onClose={() => setAdding(false)} />}
      {granting && (
        <StandingDialog projectId={projectId} person={granting} onClose={() => setGranting(null)} />
      )}
    </section>
  );
}

/** Give a member of the workspace a role in this project. */
function AddMember({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const { data: people } = useQuery(membersQuery);
  const { data: holders } = useQuery(projectMembersQuery(projectId));
  const { data: roles } = useQuery(projectRolesQuery(projectId));
  const { assign } = useProjectAccessMutations(projectId);
  const here = new Set(holders?.map((h) => h.userId));
  const candidates = people?.filter((p) => !here.has(p.userId)) ?? [];
  // A new member starts at the least a project role usually gives: the reviewer's, if there is one.
  const [userId, setUserId] = useState("");
  const [roleId, setRoleId] = useState("");
  const chosenRole = roleId || roles?.find((r) => r.name === "Reviewer")?.id || roles?.[0]?.id;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (userId && chosenRole) assign.mutate({ userId, roleId: chosenRole }, { onSuccess: onClose });
  };
  return (
    <Dialog title="Add a member to the project" onClose={onClose} width="sm">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
          Who
          <Select value={userId} required onChange={(event) => setUserId(event.target.value)}>
            <option value="">Choose a member of the workspace</option>
            {candidates.map((p) => (
              <option key={p.userId} value={p.userId}>
                {p.name}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
          Role
          <Select value={chosenRole ?? ""} onChange={(event) => setRoleId(event.target.value)}>
            {roles?.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
        </label>
        <p className="text-[12px] text-ink-3">
          {people && candidates.length === 0
            ? "Everyone in the workspace has a role here already. "
            : ""}
          Someone not in the workspace yet is invited from{" "}
          <Link
            to="/settings/$section"
            params={{ section: "members" }}
            className="text-ink-2 underline decoration-edge underline-offset-2 hover:text-ink"
          >
            Members
          </Link>{" "}
          first.
        </p>
        {assign.error && <p className="text-[13px] text-signal">{assign.error.message}</p>}
        <div className="mt-1 flex justify-end gap-2">
          <Button type="button" variant="ghost" size="md" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            size="md"
            disabled={!userId || !chosenRole || assign.isPending}
          >
            Add
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Guests this project has asked: in its reviews, kept in its groups, or invited from here (#502). */
function Reviewers({ projectId }: { projectId: string }) {
  const can = useProjectCan(projectId);
  const manage = can("manage_reviewers");
  const { data: guests, error: loadError } = useQuery(projectGuestsQuery(projectId));
  const { sendLink, revoke } = useProjectGuestMutations(projectId);
  const [inviting, setInviting] = useState(false);
  const [labelling, setLabelling] = useState<KnownGuest | null>(null);
  const [revoking, setRevoking] = useState<KnownGuest | null>(null);
  const [granting, setGranting] = useState<Grantee | null>(null);
  const { data: grants } = useQuery({ ...projectReviewerGrantsQuery(projectId), enabled: manage });
  const [sent, setSent] = useState<string | null>(null);
  const error = loadError ?? sendLink.error ?? revoke.error;
  return (
    <section aria-label="Reviewers" className="flex flex-col gap-3">
      <SectionHead
        title="Reviewers"
        hint="guests, who reach a review by link"
        action={
          manage && (
            <Button variant="secondary" size="md" onClick={() => setInviting(true)}>
              <Icon name="userPlus" size={14} />
              Invite a reviewer
            </Button>
          )
        }
      />
      {error && <p className="text-[13px] text-signal">{error.message}</p>}
      {sent && <p className="text-[13px] text-ink-2">{sent}</p>}
      <Card>
        <ul className="m-0 list-none p-0">
          {!guests && !loadError && <li className="px-4 py-4 text-[13px] text-ink-3">Loading</li>}
          {guests?.length === 0 && (
            <li className="px-4 py-4 text-[13px] text-ink-3">
              No reviewers yet. Invite one here, or ask someone by email in a review.
            </li>
          )}
          {guests?.map((g) => (
            <li
              key={g.id}
              className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b border-line px-4 py-2.5 last:border-b-0 @3xl/app:grid-cols-[auto_minmax(0,1fr)_170px_170px_auto]"
            >
              <Avatar id={g.email} name={g.name} size={30} />
              <span className="min-w-0">
                <span className="block truncate text-[14px] text-ink">
                  {g.name}
                  {g.label && <span className="text-ink-3"> · {g.label}</span>}
                  {grants?.some((x) => x.guestId === g.id) && (
                    <span className="text-ink-3"> · own review permissions</span>
                  )}
                </span>
                <span className="block truncate text-[13px] text-ink-3">
                  {g.email}
                  {g.note ? ` · ${g.note}` : ""}
                </span>
              </span>
              <span className="hidden items-center gap-2 text-[13px] text-ink-2 @3xl/app:flex">
                <StatusDot state={g.live ? "approved" : "cancelled"} />
                {g.live
                  ? g.lastLinkAt
                    ? `Link sent ${dayFormat.format(new Date(g.lastLinkAt))}`
                    : "Signed in"
                  : g.lastLinkAt
                    ? "No working link"
                    : "Not sent a link"}
              </span>
              <span className="tabular hidden text-[13px] text-ink-3 @3xl/app:block">
                {g.reviews === 0
                  ? "Not asked yet"
                  : `${g.openReviews} open of ${g.reviews} ${g.reviews === 1 ? "review" : "reviews"}`}
              </span>
              {manage ? (
                <ActionMenu
                  always
                  label={g.name}
                  actions={[
                    {
                      label: "Review permissions…",
                      hint: "For every review of this project that asks them",
                      onSelect: () => setGranting({ kind: "guest", id: g.id, name: g.name }),
                    },
                    // A link opens a review, so there is none to send without an open one.
                    ...(g.openReviews > 0
                      ? [
                          {
                            label: "Send a new link",
                            hint: "For the newest open review that asks them",
                            onSelect: () =>
                              sendLink.mutate(g.id, {
                                onSuccess: () => setSent(`A new link is on its way to ${g.name}.`),
                              }),
                          },
                        ]
                      : []),
                    { label: "Change label…", onSelect: () => setLabelling(g) },
                    "divider",
                    { label: "Revoke access…", danger: true, onSelect: () => setRevoking(g) },
                  ]}
                />
              ) : (
                <span className="hidden @3xl/app:block" />
              )}
            </li>
          ))}
        </ul>
      </Card>
      <p className="text-[12px] text-ink-3">
        A guest reaches only the items of the open reviews that ask them, for as long as each
        allows.
      </p>
      {inviting && (
        <InviteDialog
          projectId={projectId}
          onClose={() => setInviting(false)}
          onInvited={(name) =>
            setSent(`${name} is under Reviewers now; a review can ask them whenever it is ready.`)
          }
        />
      )}
      {labelling && (
        <LabelDialog projectId={projectId} guest={labelling} onClose={() => setLabelling(null)} />
      )}
      {granting && (
        <StandingDialog projectId={projectId} person={granting} onClose={() => setGranting(null)} />
      )}
      {revoking && (
        <Dialog
          title={`Revoke ${revoking.name}'s access?`}
          description="Every link and signed-in browser they have stops working, in every project. A new review, or a new link, lets them back in."
          onClose={() => setRevoking(null)}
          width="sm"
          footer={
            <>
              <Button variant="ghost" size="md" onClick={() => setRevoking(null)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                size="md"
                disabled={revoke.isPending}
                onClick={() => revoke.mutate(revoking.id, { onSuccess: () => setRevoking(null) })}
              >
                Revoke access
              </Button>
            </>
          }
        >
          {revoke.error && <p className="text-[13px] text-signal">{revoke.error.message}</p>}
        </Dialog>
      )}
    </section>
  );
}

/**
 * Invite a reviewer without starting a review (#502): a guest of the project, kept under
 * Reviewers so a review can ask them later. Nothing is sent: a guest's link opens a review,
 * and there is none yet.
 */
function InviteDialog({
  projectId,
  onClose,
  onInvited,
}: {
  projectId: string;
  onClose: () => void;
  onInvited: (name: string) => void;
}) {
  const { invite } = useProjectGuestMutations(projectId);
  const { data: groups = [] } = useQuery(projectGroupsQuery(projectId));
  const [form, setForm] = useState({ name: "", email: "", label: "", note: "", groupId: "" });
  const set = (field: keyof typeof form) => (value: string) => setForm({ ...form, [field]: value });
  const valid = form.name.trim() !== "" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim());
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    invite.mutate(
      {
        name: form.name.trim(),
        email: form.email.trim(),
        label: form.label.trim() || undefined,
        note: form.note.trim() || undefined,
        groupId: form.groupId || undefined,
      },
      {
        onSuccess: () => {
          onInvited(form.name.trim());
          onClose();
        },
      },
    );
  };
  return (
    <Dialog
      title="Invite a reviewer"
      description="A guest of this project, reached by link when a review asks them. Nothing is sent until then."
      onClose={onClose}
      width="sm"
    >
      <form onSubmit={submit} aria-label="Invite a reviewer" className="flex flex-col gap-3">
        <div className="grid gap-3 @md:grid-cols-2">
          <Field label="Name">
            <Input
              value={form.name}
              maxLength={120}
              autoComplete="off"
              onChange={(event) => set("name")(event.target.value)}
            />
          </Field>
          <Field label="Email">
            <Input
              type="email"
              value={form.email}
              maxLength={254}
              autoComplete="off"
              onChange={(event) => set("email")(event.target.value)}
            />
          </Field>
        </div>
        <Field label="Role" hint="Shown beside their name: Conductor, Composer, Label. Optional.">
          <Input
            value={form.label}
            maxLength={60}
            autoComplete="off"
            onChange={(event) => set("label")(event.target.value)}
          />
        </Field>
        {groups.length > 0 && (
          <Field label="Group" hint="A group a review can ask as one. Optional.">
            <Select value={form.groupId} onChange={(event) => set("groupId")(event.target.value)}>
              <option value="">None</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Note" hint="Who they are to the project; kept here, for the team. Optional.">
          <Textarea
            rows={2}
            value={form.note}
            maxLength={500}
            onChange={(event) => set("note")(event.target.value)}
          />
        </Field>
        {invite.error && <p className="m-0 text-[13px] text-signal">{invite.error.message}</p>}
        <div className="mt-1 flex justify-end gap-2">
          <Button type="button" variant="ghost" size="md" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" size="md" disabled={!valid || invite.isPending}>
            Add reviewer
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** How a guest appears beside their name, such as Conductor. */
function LabelDialog({
  projectId,
  guest,
  onClose,
}: {
  projectId: string;
  guest: KnownGuest;
  onClose: () => void;
}) {
  const { relabel } = useProjectGuestMutations(projectId);
  const [label, setLabel] = useState(guest.label ?? "");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    relabel.mutate({ guestId: guest.id, label: label.trim() || null }, { onSuccess: onClose });
  };
  return (
    <Dialog
      title={`Label for ${guest.name}`}
      description="Such as Conductor. It is shown beside their name in reviews, comments and lists, so people know who is speaking."
      onClose={onClose}
      width="sm"
    >
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Input
          value={label}
          maxLength={60}
          aria-label="Label"
          onChange={(event) => setLabel(event.target.value)}
          placeholder="For example Conductor"
        />
        {relabel.error && <p className="text-[13px] text-signal">{relabel.error.message}</p>}
        <div className="mt-1 flex justify-end gap-2">
          <Button type="button" variant="ghost" size="md" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" size="md" disabled={relabel.isPending}>
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Someone whose review permissions in this project can be set: a member or a guest. */
interface Grantee {
  kind: "member" | "guest";
  id: string;
  name: string;
}

/**
 * What someone may do in every review of this project that asks them (#55): the workspace's
 * defaults, changed for them alone. A review can still change it for itself.
 */
function StandingDialog({
  projectId,
  person,
  onClose,
}: {
  projectId: string;
  person: Grantee;
  onClose: () => void;
}) {
  const { data: settings } = useQuery(workspaceSettingsQuery);
  const { data: grants } = useQuery(projectReviewerGrantsQuery(projectId));
  const { set, clear } = useProjectReviewerGrant(projectId);
  const theirs = grants?.find((g) =>
    person.kind === "member" ? g.userId === person.id : g.guestId === person.id,
  );
  if (!settings || !grants) return null;
  // No window of their own here: the defaults' runs from each review's start.
  const defaults = { ...reviewerDefaults(settings, new Date()), expiresAt: null };
  const initial = theirs ? (applyPermissions(defaults, theirs.grant).data ?? defaults) : defaults;
  const target = { kind: person.kind, personId: person.id };
  const error = set.error ?? clear.error;
  return (
    <Dialog
      title={`${person.name} in this project's reviews`}
      description={
        theirs
          ? "Their own permissions, in place of the workspace's defaults."
          : "The workspace's defaults, until you change them here."
      }
      onClose={onClose}
    >
      <ReviewerPermissionsEditor
        name={person.name}
        kind="approval"
        guest={person.kind === "guest"}
        standing
        initial={initial}
        pending={set.isPending || clear.isPending}
        error={error?.message ?? null}
        onSave={(chosen) => {
          const grant = standingChange(defaults, chosen);
          if (grant) set.mutate({ ...target, grant }, { onSuccess: onClose });
          else if (theirs) clear.mutate(target, { onSuccess: onClose });
          else onClose();
        }}
        onCancel={onClose}
      />
      {theirs && (
        <div className="mt-3 flex justify-start">
          <Button
            variant="ghost"
            size="sm"
            disabled={clear.isPending}
            onClick={() => clear.mutate(target, { onSuccess: onClose })}
          >
            Back to the workspace's defaults
          </Button>
        </div>
      )}
    </Dialog>
  );
}
