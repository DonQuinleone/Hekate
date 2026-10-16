import { Avatar } from "~/components/avatar";
import { Icon } from "~/components/icons";
import { Label } from "~/components/label";
import { Button } from "~/components/ui/button";
import { ActionMenu } from "~/components/ui/menu";
import { guests, invitations, members, personById } from "~/data";
import { formatDate } from "~/lib/format";
import { useViewer } from "~/viewer/context";
import { Empty, StateGate } from "~/viewer/state-gate";

const roleCopy = { owner: "Owner", admin: "Admin", member: "Member" };

/** Members, invitations and guests: a section of organisation settings under Access. */
export function MembersSection() {
  const viewer = useViewer();
  const elevated =
    viewer.persona.organisationRole === "owner" || viewer.persona.organisationRole === "admin";
  return (
    <div className="flex flex-col gap-8">
      <StateGate
        empty={
          <Empty
            title="Just you so far"
            text="Invite the people you work with. They get an email with a link that works once."
            action={<Button variant="primary">Invite</Button>}
          />
        }
      >
        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <Label>Members · {members.length}</Label>
            {elevated && (
              <Button variant="primary" size="sm">
                <Icon name="plus" size={14} />
                Invite
              </Button>
            )}
          </div>
          <ul className="flex list-none flex-col rounded-panel-lg border border-line bg-raised/40 p-0 shadow-1">
            {members.map((m) => {
              const p = personById(m.personId);
              const you = m.personId === viewer.personId;
              return (
                <li
                  key={m.personId}
                  className="group grid grid-cols-[1fr_auto] items-center gap-4 rounded-panel px-2 py-2 transition-colors hover:bg-raised/60 @3xl/app:grid-cols-[1fr_1fr_120px_32px]"
                >
                  <span className="flex min-w-0 items-center gap-3">
                    <Avatar personId={m.personId} size={28} />
                    <span className="min-w-0">
                      <span className="block truncate text-[14px] text-ink">
                        {p.name}
                        {you && <span className="text-ink-3"> · you</span>}
                      </span>
                      <span className="block truncate text-[13px] text-ink-3 @3xl/app:hidden">
                        {p.email}
                      </span>
                    </span>
                  </span>
                  <span className="hidden truncate text-[14px] text-ink-2 @3xl/app:block">
                    {p.email}
                  </span>
                  {elevated &&
                  !(
                    m.role === "owner" && members.filter((x) => x.role === "owner").length === 1
                  ) ? (
                    <select
                      defaultValue={m.role}
                      className="h-7 rounded-control border border-transparent bg-transparent text-[14px] text-ink-2 hover:border-edge"
                    >
                      <option value="owner">Owner</option>
                      <option value="admin">Admin</option>
                      <option value="member">Member</option>
                    </select>
                  ) : (
                    <span
                      className="text-[14px] text-ink-2"
                      title={m.role === "owner" ? "The last owner cannot change role" : undefined}
                    >
                      {roleCopy[m.role]}
                    </span>
                  )}
                  <span className="hidden @3xl/app:block">
                    {elevated && (
                      <ActionMenu
                        label={p.name}
                        actions={[
                          { label: "Change role…", onSelect: () => {} },
                          { label: "Remove from workspace…", danger: true, onSelect: () => {} },
                        ]}
                      />
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
        {elevated && (
          <section className="flex flex-col gap-2">
            <Label>Invited · {invitations.length}</Label>
            <ul className="flex list-none flex-col rounded-panel-lg border border-line bg-raised/40 p-0 shadow-1">
              {invitations.map((i) => (
                <li
                  key={i.email}
                  className="group flex items-center gap-3 rounded-panel px-2 py-2 transition-colors hover:bg-raised/60"
                >
                  <Icon name="mail" className="text-ink-3" />
                  <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{i.email}</span>
                  <span className="text-[13px] text-ink-3">
                    {roleCopy[i.role]} · until {formatDate(i.expiresAt)}
                  </span>
                  <ActionMenu
                    label={i.email}
                    actions={[
                      { label: "Send again", onSelect: () => {} },
                      { label: "Revoke", danger: true, onSelect: () => {} },
                    ]}
                  />
                </li>
              ))}
            </ul>
          </section>
        )}
        <section className="flex flex-col gap-2">
          <Label>Guests · {guests.length}</Label>
          <ul className="flex list-none flex-col rounded-panel-lg border border-line bg-raised/40 p-0 shadow-1">
            {guests.map((g) => {
              const p = personById(g.personId);
              return (
                <li
                  key={g.personId}
                  className="group flex items-center gap-3 rounded-panel px-2 py-2 transition-colors hover:bg-raised/60"
                >
                  <Avatar personId={g.personId} size={28} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] text-ink">
                      {p.name} <span className="text-ink-3">· {g.label}</span>
                    </span>
                    <span className="block truncate text-[13px] text-ink-3">{p.email}</span>
                  </span>
                  <span className="hidden text-[13px] text-ink-3 @3xl/app:inline">
                    {g.linkSentAt ? `link sent ${formatDate(g.linkSentAt)}` : "revoked"}
                  </span>
                  {elevated && (
                    <ActionMenu
                      label={p.name}
                      actions={[
                        { label: "Send a new link", onSelect: () => {} },
                        { label: "Revoke access", danger: true, onSelect: () => {} },
                      ]}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      </StateGate>
    </div>
  );
}
