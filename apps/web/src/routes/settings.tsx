import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Icon } from "~/components/icons";
import { OrganisationName } from "~/components/organisation-name";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  invitationsQuery,
  type Member,
  membersQuery,
  meQuery,
  useOrganisationMutations,
} from "~/lib/queries";

const roles: Member["role"][] = ["owner", "admin", "member"];
const roleLabel: Record<Member["role"], string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
};
const dateFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });

function Select({
  value,
  onChange,
  options,
  label,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  label: string;
  disabled?: boolean;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className="h-8 cursor-pointer rounded-control border border-edge bg-ground px-2 text-[13px] text-ink disabled:cursor-default disabled:opacity-60"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function Invite({ myRole }: { myRole: Member["role"] }) {
  const { invite } = useOrganisationMutations();
  const [role, setRole] = useState<Member["role"]>("member");
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const email = String(new FormData(form).get("email"));
    invite.mutate(
      { email, role },
      {
        onSuccess: (res) => {
          setLink(res.link);
          setCopied(false);
          form.reset();
        },
      },
    );
  };
  const allowed = roles.filter((r) => r !== "owner" || myRole === "owner");
  return (
    <section className="flex flex-col gap-3 rounded-panel border border-hairline bg-surface p-5">
      <h2 className="label m-0">Invite</h2>
      <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-[240px] flex-1 flex-col gap-1.5">
          <label htmlFor="invite-email" className="text-xs text-ink-3">
            Email
          </label>
          <Input
            id="invite-email"
            name="email"
            type="email"
            required
            placeholder="name@example.com"
          />
        </div>
        <Select
          label="Role"
          value={role}
          onChange={(v) => setRole(v as Member["role"])}
          options={allowed.map((r) => ({ value: r, label: roleLabel[r] }))}
        />
        <Button variant="primary" type="submit" disabled={invite.isPending}>
          Send invitation
        </Button>
      </form>
      {invite.error && <p className="m-0 text-xs text-signal">{invite.error.message}</p>}
      {link && (
        <div className="flex flex-wrap items-center gap-2 rounded-control border border-hairline bg-ground p-2 pl-3">
          <span className="tabular min-w-0 flex-1 truncate text-xs text-ink-2">{link}</span>
          <Button
            size="sm"
            onClick={async () => {
              await navigator.clipboard?.writeText(link);
              setCopied(true);
            }}
          >
            {copied ? "Copied" : "Copy link"}
          </Button>
        </div>
      )}
      <p className="m-0 text-xs text-ink-3">
        The invitation is emailed and works once, for 7 days.
      </p>
    </section>
  );
}

export function SettingsPage() {
  const { data: me } = useQuery(meQuery);
  const { data: members } = useQuery(membersQuery);
  const myRole = me?.organisations.find((o) => o.id === me.activeOrganisationId)?.role ?? "member";
  const isAdmin = myRole === "owner" || myRole === "admin";
  const { data: invitations } = useQuery({ ...invitationsQuery, enabled: isAdmin });
  const { setRole, remove, revoke } = useOrganisationMutations();
  const error = setRole.error ?? remove.error ?? revoke.error;
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-8 sm:px-8">
      <div className="flex flex-col gap-1">
        <OrganisationName />
        <h1 className="m-0 text-[28px] font-medium tracking-[-0.02em]">Members</h1>
      </div>
      {isAdmin && <Invite myRole={myRole} />}
      {error && <p className="m-0 text-xs text-signal">{error.message}</p>}
      <ul className="m-0 flex list-none flex-col p-0">
        <li className="label grid grid-cols-[1fr_auto] gap-4 border-b border-hairline px-2 pb-2 sm:grid-cols-[1fr_1fr_140px_80px]">
          <span>Name</span>
          <span className="hidden sm:block">Email</span>
          <span>Role</span>
          <span className="hidden sm:block" />
        </li>
        {members?.map((m) => {
          const isSelf = m.userId === me?.user.id;
          const canEdit = isAdmin && (myRole === "owner" || m.role !== "owner");
          return (
            <li
              key={m.id}
              className="grid min-h-12 grid-cols-[1fr_auto] items-center gap-4 border-b border-hairline px-2 py-2 sm:grid-cols-[1fr_1fr_140px_80px]"
            >
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-sm font-medium">
                  {m.name}
                  {isSelf && <span className="ml-2 text-xs font-normal text-ink-3">you</span>}
                </span>
                <span className="truncate text-xs text-ink-3 sm:hidden">{m.email}</span>
              </span>
              <span className="hidden truncate text-[13px] text-ink-2 sm:block">{m.email}</span>
              <Select
                label={`Role for ${m.name}`}
                value={m.role}
                disabled={!canEdit}
                onChange={(role) => setRole.mutate({ id: m.id, role: role as Member["role"] })}
                options={roles
                  .filter((r) => r !== "owner" || myRole === "owner" || m.role === "owner")
                  .map((r) => ({ value: r, label: roleLabel[r] }))}
              />
              <span className="hidden justify-end sm:flex">
                {(canEdit || isSelf) && (
                  <Button variant="ghost" size="sm" onClick={() => remove.mutate(m.id)}>
                    {isSelf ? "Leave" : "Remove"}
                  </Button>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      {isAdmin && invitations && invitations.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="label m-0 px-2">Pending invitations</h2>
          <ul className="m-0 flex list-none flex-col p-0">
            {invitations.map((i) => (
              <li
                key={i.id}
                className="flex min-h-11 items-center gap-4 border-b border-hairline px-2"
              >
                <Icon name="mail" className="text-ink-3" />
                <span className="min-w-0 flex-1 truncate text-[13px]">{i.email}</span>
                <span className="text-xs text-ink-3">{roleLabel[i.role]}</span>
                <span className="tabular text-xs text-ink-3">
                  until {dateFormat.format(new Date(i.expiresAt))}
                </span>
                <Button variant="ghost" size="sm" onClick={() => revoke.mutate(i.id)}>
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
