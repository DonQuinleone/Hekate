import {
  type CannedReply,
  type OperatorTicketDetail,
  pressing,
  type SupportSeverity,
  serviceStateNames,
  severityHints,
  severityNames,
  supportSeverities,
  type TicketState,
  ticketStateNames,
  ticketStates,
} from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useDeferredValue, useState } from "react";
import { Avatar } from "~/components/avatar";
import { TileGrid } from "~/components/billing";
import { Empty } from "~/components/empty";
import { Icon } from "~/components/icons";
import { StatusSection } from "~/components/incidents";
import { Row, Section } from "~/components/settings";
import { calmLine } from "~/components/status";
import { AttachPicker, Thread, TicketListRow, ticketLine } from "~/components/support";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import { Field } from "~/components/ui/field";
import { Input, Select, Textarea } from "~/components/ui/input";
import { ActionMenu } from "~/components/ui/menu";
import { StatusDot } from "~/components/ui/status";
import { ago } from "~/lib/comments";
import { instanceErrorQuery } from "~/lib/queries";
import { statusNowQuery } from "~/lib/status";
import {
  cannedRepliesQuery,
  type DeskFilters,
  deskTicketQuery,
  deskTicketsQuery,
  downloadAttachment,
  supportDeskQuery,
  useDeskReply,
  useDeskState,
  useRemoveCannedReply,
  useSaveCannedReply,
  useSaveDesk,
} from "~/lib/support";

/**
 * The instance's Support page (#182), as the prototype has it: the desk's figures, every
 * workspace's tickets with their filters, a ticket in a modal with who asked and where from,
 * and the desk's own settings. The operators', with tickets in the app.
 */
export function InstanceSupport({
  ticketId,
  onTicket,
}: {
  ticketId?: string;
  onTicket: (id: string | undefined) => void;
}) {
  const [q, setQ] = useState("");
  const [state, setState] = useState<DeskFilters["state"]>("open");
  const [severity, setSeverity] = useState<SupportSeverity | "">("");
  const [workspace, setWorkspace] = useState("");
  const search = useDeferredValue(q.trim());
  const { data, error } = useQuery(
    deskTicketsQuery({
      state,
      ...(severity ? { severity } : {}),
      ...(workspace ? { workspace } : {}),
      ...(search ? { q: search } : {}),
    }),
  );
  const { data: status } = useQuery(statusNowQuery);
  const figures = data?.figures;
  return (
    <>
      {ticketId && <DeskTicket id={ticketId} onClose={() => onTicket(undefined)} />}
      <TileGrid
        tiles={[
          {
            label: "Open",
            value: String(figures?.open ?? 0),
            hint: `${figures?.waiting ?? 0} waiting on you`,
            flag: (figures?.waiting ?? 0) > 0,
          },
          {
            label: "First reply",
            value:
              figures?.firstReplyHours === null || figures?.firstReplyHours === undefined
                ? "None"
                : `${figures.firstReplyHours} h`,
            hint: "median this month",
          },
          { label: "Resolved", value: String(figures?.resolved ?? 0), hint: "this month" },
          {
            label: "Status page",
            value: !status
              ? "…"
              : status.open.length > 0
                ? status.open.length === 1
                  ? "1 incident"
                  : `${status.open.length} incidents`
                : status.state === "operational"
                  ? "Up"
                  : serviceStateNames[status.state],
            hint: !status
              ? "reading"
              : status.open.length > 0
                ? (status.open[0]?.title ?? "")
                : calmLine(status).toLowerCase(),
            flag: (status?.open.length ?? 0) > 0,
          },
        ]}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search tickets"
          aria-label="Search tickets"
          className="w-full @3xl/app:w-64"
        />
        <Select
          value={state}
          onChange={(e) => setState(e.target.value as DeskFilters["state"])}
          aria-label="State"
          className="w-44"
        >
          <option value="open">Open</option>
          <option value="waiting">Waiting on you</option>
          <option value="all">All</option>
        </Select>
        <Select
          value={workspace}
          onChange={(e) => setWorkspace(e.target.value)}
          aria-label="Workspace"
          className="w-48"
        >
          <option value="">Any workspace</option>
          {data?.workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </Select>
        <Select
          value={severity}
          onChange={(e) => setSeverity(e.target.value as SupportSeverity | "")}
          aria-label="Severity"
          className="w-36"
        >
          <option value="">Any severity</option>
          {supportSeverities.map((s) => (
            <option key={s} value={s}>
              {severityNames[s]}
            </option>
          ))}
        </Select>
      </div>
      {error ? (
        <p className="m-0 text-[13px] text-signal">{error.message}</p>
      ) : data && data.tickets.length === 0 ? (
        <Empty
          title={
            q || severity || workspace || state !== "open" ? "Nothing matches" : "Nothing open"
          }
          text={
            q || severity || workspace || state !== "open"
              ? "No ticket has those words or filters. Clear them to see the rest."
              : "Every ticket is answered. New ones appear here, and whoever is on call hears of them by email."
          }
        />
      ) : (
        <div className="flex flex-col divide-y divide-line rounded-panel-lg border border-line bg-raised/25 shadow-1">
          {data?.tickets.map((t) => (
            <TicketListRow key={t.id} ticket={t} operator onOpen={() => onTicket(t.id)} />
          ))}
        </div>
      )}
      <StatusSection />
      <Desk />
    </>
  );
}

/** The desk's own settings: severities by plan, the status page, who is on call, canned replies. */
function Desk() {
  const navigate = useNavigate();
  const { data: desk } = useQuery(supportDeskQuery);
  const { data: canned } = useQuery(cannedRepliesQuery);
  const save = useSaveDesk();
  const [managing, setManaging] = useState(false);
  if (!desk) return null;
  const severityLine = desk.billing
    ? desk.plans.length === 0
      ? "No plans yet: every workspace is on the internal plan, which allows every severity."
      : desk.plans
          .map((p) => {
            const top = [...p.severities].sort(
              (a, b) => supportSeverities.indexOf(b) - supportSeverities.indexOf(a),
            )[0];
            return `${p.name} up to ${top ? severityNames[top] : "none"}`;
          })
          .join("; ")
    : "Billing is off, so every workspace may mark any severity. Emergency tells whoever is on call.";
  return (
    <Section
      title="Desk"
      intro="Support is a module: on because the instance runs with HEKATE_SUPPORT=app. Set it to link or mail to answer elsewhere, or off."
    >
      <Row name="Severities by plan" hint={severityLine}>
        {desk.billing && (
          <Button
            variant="ghost"
            size="md"
            onClick={() =>
              void navigate({ to: "/instance/$section", params: { section: "billing" } })
            }
          >
            Edit
          </Button>
        )}
      </Row>
      <Row
        name="On call"
        hint={
          desk.onCall
            ? "Hears of each new ticket first, and is told at once of an Emergency."
            : "Nobody: every operator hears of each new ticket."
        }
      >
        <Select
          aria-label="On call"
          value={desk.onCall ?? ""}
          disabled={save.isPending}
          onChange={(e) =>
            save.mutate({ statusUrl: desk.statusUrl, onCall: e.target.value || null })
          }
          className="w-52"
        >
          <option value="">Nobody</option>
          {desk.operators.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </Select>
      </Row>
      <Row
        name="Canned replies"
        hint={
          canned && canned.replies.length > 0
            ? canned.replies.map((r) => r.title).join(" · ")
            : "None yet: answers the desk gives often, to start a reply from."
        }
      >
        <Button variant="ghost" size="md" onClick={() => setManaging(true)}>
          Manage
        </Button>
      </Row>
      {save.error && <p className="m-0 px-4 py-2 text-[13px] text-signal">{save.error.message}</p>}
      {managing && <CannedRepliesDialog onClose={() => setManaging(false)} />}
    </Section>
  );
}

function CannedRepliesDialog({ onClose }: { onClose: () => void }) {
  const { data } = useQuery(cannedRepliesQuery);
  const save = useSaveCannedReply();
  const remove = useRemoveCannedReply();
  const [editing, setEditing] = useState<CannedReply | "new" | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const open = (reply: CannedReply | "new") => {
    setEditing(reply);
    setTitle(reply === "new" ? "" : reply.title);
    setBody(reply === "new" ? "" : reply.body);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    save.mutate(
      { ...(editing === "new" ? {} : { id: editing.id }), input: { title, body } },
      { onSuccess: () => setEditing(null) },
    );
  };
  return (
    <Dialog
      title="Canned replies"
      description="Answers the desk gives often. Choosing one in a ticket puts its words in the reply, to change before sending."
      onClose={onClose}
      width="lg"
      footer={
        editing ? (
          <>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              type="submit"
              form="canned-reply"
              disabled={save.isPending || !title.trim() || !body.trim()}
            >
              Save
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
            <Button variant="primary" onClick={() => open("new")}>
              <Icon name="plus" size={14} />
              Reply
            </Button>
          </>
        )
      }
    >
      {editing ? (
        <form id="canned-reply" onSubmit={submit} className="flex flex-col gap-4">
          <Field label="Name" error={save.error?.message}>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Fixed in the next patch"
              maxLength={60}
              autoFocus
            />
          </Field>
          <Field label="Reply">
            <Textarea value={body} onChange={(e) => setBody(e.target.value)} className="h-40" />
          </Field>
        </form>
      ) : data && data.replies.length === 0 ? (
        <p className="m-0 text-[13px] text-ink-3">
          None yet. Add the answers you give most, so a reply starts from them.
        </p>
      ) : (
        <div className="flex flex-col divide-y divide-line rounded-panel-lg border border-line">
          {data?.replies.map((r) => (
            <div key={r.id} className="group flex items-center gap-3 px-4 py-2.5">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] text-ink">{r.title}</span>
                <span className="block truncate text-[12px] text-ink-3">{r.body}</span>
              </span>
              <ActionMenu
                label={r.title}
                actions={[
                  { label: "Edit", onSelect: () => open(r) },
                  { label: "Remove", danger: true, onSelect: () => remove.mutate(r.id) },
                ]}
              />
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}

const roleNames = { owner: "Owner", admin: "Admin", member: "Member" } as const;

/** A ticket as the desk sees it: the thread and reply box, and beside it who asked and from where. */
function DeskTicket({ id, onClose }: { id: string; onClose: () => void }) {
  const navigate = useNavigate();
  const { data, error } = useQuery(deskTicketQuery(id));
  const { data: canned } = useQuery(cannedRepliesQuery);
  const reply = useDeskReply(id);
  const setState = useDeskState(id);
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [chosen, setChosen] = useState<TicketState | null>(null);
  const [lookUp, setLookUp] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const ticket = data?.ticket;
  const state = chosen ?? ticket?.state ?? "waiting";
  const send = () =>
    reply.mutate(
      { body: body.trim(), files, ...(chosen ? { state: chosen } : {}) },
      {
        onSuccess: () => {
          setBody("");
          setFiles([]);
          setChosen(null);
        },
      },
    );
  const openWorkspace = (t: OperatorTicketDetail, tab?: "members") =>
    void navigate({
      to: "/instance/$section",
      params: { section: "workspaces" },
      search: { workspace: t.place.id, ...(tab ? { tab } : {}) },
    });
  return (
    <Dialog
      title={ticket ? `${ticket.reference} · ${ticket.subject}` : "Ticket"}
      description={ticket ? ticketLine({ ...ticket, state }) : undefined}
      onClose={onClose}
      width="xl"
      footer={
        ticket && (
          <>
            <Select
              value={state}
              aria-label="State"
              onChange={(e) => {
                const next = e.target.value as TicketState;
                // With a reply written, the state goes with it; otherwise it is set at once.
                if (body.trim()) setChosen(next);
                else setState.mutate(next, { onSuccess: () => setChosen(null) });
              }}
              className="h-8 w-48 text-[13px]"
            >
              {ticketStates.map((s) => (
                <option key={s} value={s}>
                  {ticketStateNames[s]}
                </option>
              ))}
            </Select>
            <span className="flex-1" />
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
            <Button variant="primary" disabled={!body.trim() || reply.isPending} onClick={send}>
              {reply.isPending ? "Sending" : "Send"}
            </Button>
          </>
        )
      }
    >
      {error && <p className="m-0 text-[13px] text-signal">{error.message}</p>}
      {ticket && (
        <div className="grid gap-6 @3xl/app:grid-cols-[minmax(0,1fr)_240px]">
          <div className="flex min-w-0 flex-col gap-4">
            <Thread
              messages={ticket.thread}
              onDownload={(a) =>
                void downloadAttachment("instance", ticket.id, a).catch((e: Error) =>
                  setFailed(e.message),
                )
              }
            />
            <div className="flex flex-col gap-2">
              <Textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder={`Reply to ${ticket.who.name.split(" ")[0] ?? "them"}…`}
                aria-label="Reply"
                className="h-24"
              />
              <AttachPicker files={files} onChange={setFiles}>
                {canned && canned.replies.length > 0 && (
                  <Select
                    value=""
                    size="sm"
                    aria-label="Canned reply"
                    onChange={(e) => {
                      const picked = canned.replies.find((r) => r.id === e.target.value);
                      if (picked)
                        setBody(body.trim() ? `${body.trimEnd()}\n\n${picked.body}` : picked.body);
                    }}
                    className="w-44"
                  >
                    <option value="">Canned reply</option>
                    {canned.replies.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.title}
                      </option>
                    ))}
                  </Select>
                )}
              </AttachPicker>
              {(reply.error ?? setState.error ?? failed) && (
                <p role="alert" className="m-0 text-[13px] text-signal">
                  {reply.error?.message ?? setState.error?.message ?? failed}
                </p>
              )}
            </div>
          </div>
          <aside className="flex min-w-0 flex-col gap-4 rounded-panel-lg border border-line bg-raised/25 p-4 text-[13px]">
            <div>
              <span className="eyebrow">Who</span>
              <div className="mt-1.5 flex items-center gap-2.5">
                <Avatar id={ticket.who.id ?? ticket.who.name} name={ticket.who.name} size={32} />
                <span className="min-w-0">
                  <span className="block truncate text-ink">{ticket.who.name}</span>
                  <span className="block truncate text-[12px] text-ink-3">
                    {ticket.who.email ?? "Account deleted"}
                  </span>
                </span>
              </div>
              <p className="mt-1.5 mb-0 text-[12px] text-ink-3">
                {ticket.who.role ? roleNames[ticket.who.role] : "No longer a member"}
                {ticket.who.lastSeenAt ? ` · seen ${ago(ticket.who.lastSeenAt)}` : ""}
              </p>
              <Button
                variant="secondary"
                size="sm"
                className="mt-2 w-full"
                onClick={() => openWorkspace(ticket, "members")}
              >
                Open the account
              </Button>
            </div>
            <div>
              <span className="eyebrow">Workspace</span>
              <p className="mt-1.5 mb-0 truncate text-ink">{ticket.place.name}</p>
              <p className="tabular m-0 truncate text-[12px] text-ink-3">{ticket.place.address}</p>
              <p className="mt-1 mb-0 text-[12px] text-ink-3">
                {ticket.place.plan ? `${ticket.place.plan} plan` : "No plan"} ·{" "}
                {ticket.place.openReviews === 1
                  ? "1 open review"
                  : `${ticket.place.openReviews} open reviews`}
              </p>
              <Button
                variant="ghost"
                size="sm"
                className="mt-2 w-full"
                onClick={() => openWorkspace(ticket)}
              >
                Open the workspace
              </Button>
            </div>
            {ticket.errorReference && (
              <div>
                <span className="eyebrow">Error</span>
                <p className="tabular mt-1.5 mb-0 text-ink">{ticket.errorReference}</p>
                {lookUp ? (
                  <ErrorSummary reference={ticket.errorReference} />
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mt-2 w-full"
                    onClick={() => setLookUp(true)}
                  >
                    Look it up
                  </Button>
                )}
              </div>
            )}
            {ticket.item && (
              <div>
                <span className="eyebrow">In question</span>
                <p className="mt-1.5 mb-0 truncate text-ink">
                  {ticket.item.name ?? `A ${ticket.item.kind} since deleted`}
                </p>
                <p className="m-0 text-[12px] text-ink-3">
                  {ticket.operatorAccess
                    ? `They let the operators open this ${ticket.item.kind}.`
                    : `Not to be opened without asking.`}
                </p>
              </div>
            )}
            <div>
              <span className="eyebrow">Severity</span>
              <p className="mt-1.5 mb-0 flex items-center gap-2 text-ink">
                <StatusDot state={pressing(ticket.severity) ? "changes_requested" : "approved"} />
                {severityNames[ticket.severity]}
              </p>
              <p className="m-0 text-[12px] text-ink-3">{severityHints[ticket.severity]}</p>
            </div>
          </aside>
        </div>
      )}
    </Dialog>
  );
}

/** What the error report says, in brief, with the way to the whole story. */
function ErrorSummary({ reference }: { reference: string }) {
  const navigate = useNavigate();
  const { data, isPending, error } = useQuery(instanceErrorQuery(reference));
  if (isPending) return <p className="mt-1 mb-0 text-[12px] text-ink-3">Looking it up</p>;
  if (error) return <p className="mt-1 mb-0 text-[12px] text-signal">{error.message}</p>;
  if (!data)
    return (
      <p className="mt-1 mb-0 text-[12px] text-ink-3">
        No report has it any more: they are kept for 30 days.
      </p>
    );
  return (
    <div className="mt-1 flex flex-col gap-1">
      <p className="m-0 text-[12px] [overflow-wrap:anywhere] text-ink-2">{data.message}</p>
      <p className="m-0 truncate text-[12px] text-ink-3">
        {data.source} · {data.location} · {ago(data.occurredAt)}
      </p>
      <Button
        variant="ghost"
        size="sm"
        className="w-full"
        onClick={() => void navigate({ to: "/instance/$section", params: { section: "debug" } })}
      >
        Debug tools
      </Button>
    </div>
  );
}
