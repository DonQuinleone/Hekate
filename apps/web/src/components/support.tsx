import {
  pressing,
  type SupportSeverity,
  severityHints,
  severityNames,
  type TicketAttachment,
  type TicketDetail,
  type TicketKind,
  type TicketMessage,
  type TicketRow,
  type TicketState,
  ticketKindNames,
  ticketKinds,
  type WorkspaceSupport,
} from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type DragEvent, type FormEvent, type ReactNode, useRef, useState } from "react";
import { Avatar } from "~/components/avatar";
import { Icon } from "~/components/icons";
import { Row, Section } from "~/components/settings";
import { StatusRows } from "~/components/status";
import { Button } from "~/components/ui/button";
import { Choice } from "~/components/ui/choice";
import { Dialog } from "~/components/ui/dialog";
import { Field } from "~/components/ui/field";
import { FileInput, Input, Select, Textarea } from "~/components/ui/input";
import { type ReviewState, StatusDot } from "~/components/ui/status";
import { cn } from "~/lib/cn";
import { ago } from "~/lib/comments";
import { helpTopics, topicsFor } from "~/lib/help-topics";
import { meQuery } from "~/lib/queries";
import {
  downloadAttachment,
  ticketQuery,
  useReplyToTicket,
  useResolveTicket,
  useSendTicket,
  workspaceSupportQuery,
} from "~/lib/support";

/**
 * Support (#181), as the prototype has it: the workspace's tickets, a new ticket with the
 * deflection first, and a ticket as a thread in a modal. The desk's side (#182) shares the
 * row, the thread and the reply box.
 */

/** Waiting on support or open is in signal; answered waits on the workspace; resolved is done. */
export const ticketDot = (state: TicketState): ReviewState =>
  state === "resolved" ? "approved" : state === "answered" ? "in_review" : "changes_requested";

/** A ticket's state as a line of copy says it. */
export const ticketStateCopy: Record<TicketState, string> = {
  open: "open",
  waiting: "waiting on support",
  answered: "answered",
  resolved: "resolved",
};

/** A ticket in a list: its reference and subject, then where it stands. */
export function TicketListRow({
  ticket,
  operator = false,
  onOpen,
}: {
  ticket: TicketRow;
  operator?: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-raised/40"
    >
      <StatusDot state={ticketDot(ticket.state)} />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2 text-[14px] text-ink">
          <span className="tabular shrink-0 text-[12px] text-ink-3">{ticket.reference}</span>
          <span className="truncate">{ticket.subject}</span>
          {pressing(ticket.severity) && (
            <span className="shrink-0 rounded-chip border border-signal/40 px-1.5 text-[11px] text-signal">
              {severityNames[ticket.severity]}
            </span>
          )}
        </span>
        <span className="block truncate text-[12px] text-ink-3">
          {operator && ticket.workspace
            ? `${ticket.workspace.name} · ${ticket.requester.name} · `
            : ""}
          {ticketKindNames[ticket.kind]} · {ticketStateCopy[ticket.state]} · {ago(ticket.updatedAt)}
        </span>
      </span>
      <span className="tabular text-[12px] text-ink-3" title="Messages">
        {ticket.messages}
      </span>
      <Icon name="chevronRight" size={14} className="text-ink-3" />
    </button>
  );
}

/** The thread: the workspace at the left, the operators at the right, Hekate's notes dashed. */
export function Thread({
  messages,
  onDownload,
}: {
  messages: TicketMessage[];
  onDownload: (a: TicketAttachment) => void;
}) {
  return (
    <ol className="m-0 flex list-none flex-col gap-3 p-0">
      {messages.map((m) => (
        <li
          key={m.id}
          className={cn("flex gap-3", m.author === "operator" && "flex-row-reverse text-right")}
        >
          {m.author === "system" ? (
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-raised text-ink-3">
              <Icon name="bolt" size={13} />
            </span>
          ) : (
            <Avatar id={m.authorId ?? m.name} name={m.name} size={28} />
          )}
          <div
            className={cn(
              "flex min-w-0 max-w-[85%] flex-col gap-1",
              m.author === "operator" && "items-end",
            )}
          >
            <span className="text-[12px] text-ink-3">
              {m.name} · {ago(m.createdAt)}
            </span>
            <p
              className={cn(
                "m-0 rounded-panel px-3 py-2 text-left text-[13px] leading-[20px] whitespace-pre-wrap [overflow-wrap:anywhere]",
                m.author === "system"
                  ? "border border-dashed border-line text-ink-3"
                  : m.author === "operator"
                    ? "bg-signal/15 text-ink"
                    : "bg-raised text-ink",
              )}
            >
              {m.body}
            </p>
            {m.attachments.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => onDownload(a)}
                className="flex min-w-0 items-center gap-1.5 rounded-control text-[12px] text-ink-2 transition-colors hover:text-ink"
              >
                <Icon name="file" size={12} />
                <span className="truncate">{a.name}</span>
              </button>
            ))}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Files chosen to go with a message: a button to choose, and each one, removable. */
export function AttachPicker({
  files,
  onChange,
  children,
}: {
  files: File[];
  onChange: (files: File[]) => void;
  /** More controls on the same line, such as the desk's canned replies. */
  children?: ReactNode;
}) {
  const chooser = useRef<HTMLInputElement>(null);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="ghost" size="sm" onClick={() => chooser.current?.click()}>
        <Icon name="plus" size={13} />
        Attach
      </Button>
      <FileInput
        ref={chooser}
        multiple
        aria-label="Attach files"
        onChange={(e) => {
          onChange([...files, ...Array.from(e.target.files ?? [])].slice(0, 5));
          e.target.value = "";
        }}
      />
      {children}
      {files.map((f, i) => (
        <span
          key={`${f.name}-${String(i)}`}
          className="flex min-w-0 items-center gap-1 rounded-chip bg-raised px-2 py-0.5 text-[12px] text-ink-2"
        >
          <Icon name="file" size={12} />
          <span className="max-w-[160px] truncate">{f.name}</span>
          <button
            type="button"
            aria-label={`Remove ${f.name}`}
            onClick={() => onChange(files.filter((_, j) => j !== i))}
            className="flex size-5 items-center justify-center rounded-control text-ink-3 hover:text-ink"
          >
            <Icon name="close" size={11} />
          </button>
        </span>
      ))}
    </div>
  );
}

/** "Something is broken · normal · opened 2 h ago · waiting on support". */
export const ticketLine = (t: TicketRow) =>
  `${ticketKindNames[t.kind]} · ${severityNames[t.severity].toLowerCase()} · opened ${ago(t.createdAt)} · ${ticketStateCopy[t.state]}`;

/** One of the workspace's tickets as a thread, with a reply box and Mark resolved. */
function TicketDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, error } = useQuery(ticketQuery(id));
  const reply = useReplyToTicket(id);
  const resolve = useResolveTicket(id);
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [failed, setFailed] = useState<string | null>(null);
  const ticket = data?.ticket;
  const send = () =>
    reply.mutate(
      { body: body.trim(), files },
      {
        onSuccess: () => {
          setBody("");
          setFiles([]);
        },
      },
    );
  return (
    <Dialog
      title={ticket ? `${ticket.reference} · ${ticket.subject}` : "Ticket"}
      description={ticket ? ticketLine(ticket) : undefined}
      onClose={onClose}
      width="lg"
      footer={
        ticket && (
          <>
            {ticket.state !== "resolved" && (
              <Button variant="ghost" disabled={resolve.isPending} onClick={() => resolve.mutate()}>
                Mark resolved
              </Button>
            )}
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
        <div className="flex flex-col gap-4">
          <Thread
            messages={ticket.thread}
            onDownload={(a) =>
              void downloadAttachment("organisation", ticket.id, a).catch((e: Error) =>
                setFailed(e.message),
              )
            }
          />
          <div className="flex flex-col gap-2">
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={ticket.state === "resolved" ? "Reply to open it again…" : "Reply…"}
              aria-label="Reply"
              className="h-24"
            />
            <AttachPicker files={files} onChange={setFiles} />
            {(reply.error ?? resolve.error ?? failed) && (
              <p role="alert" className="m-0 text-[13px] text-signal">
                {reply.error?.message ?? resolve.error?.message ?? failed}
              </p>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}

/** Where the help menu was opened: a file or a review, which the operators may be let open. */
export interface AskedFrom {
  kind: "file" | "review";
  id: string;
}

/** The workspace's Support section: tickets in the app, or where this instance answers instead. */
export function SupportSection({
  ticketId,
  writing,
  from,
}: {
  ticketId?: string;
  writing: boolean;
  from?: AskedFrom;
}) {
  const { data: me } = useQuery(meQuery);
  const navigate = useNavigate();
  const support = me?.support;
  if (!support) return null;
  const go = (search: { ticket?: string; new?: "1" }) =>
    void navigate({ to: "/settings/$section", params: { section: "support" }, search });
  if (support.mode !== "app") {
    const href =
      support.mode === "mail" && support.address
        ? `mailto:${support.address}`
        : support.mode === "link"
          ? support.address
          : null;
    return (
      <Section
        title="Support"
        intro="The people who run this instance take questions outside Hekate. Here is where to reach them."
      >
        <Row
          name="Where"
          hint={
            support.mode === "off"
              ? "Support is not turned on for this instance. Ask whoever runs it."
              : support.mode === "link"
                ? "A help desk of the operators’ own."
                : `By email, to ${support.address ?? "the operators"}.`
          }
        >
          {href && (
            <Button variant="secondary" size="md" asChild>
              <a href={href} target="_blank" rel="noopener noreferrer">
                Open it
              </a>
            </Button>
          )}
        </Row>
        <DocumentationRow docsUrl={support.docsUrl} />
        <StatusRows url={support.statusUrl} />
      </Section>
    );
  }
  return writing ? (
    <NewTicket
      docsUrl={support.docsUrl}
      statusUrl={support.statusUrl}
      from={from}
      onDone={() => go({})}
      onOpen={(id) => go({ ticket: id })}
    />
  ) : (
    <>
      {ticketId && <TicketDialog id={ticketId} onClose={() => go({})} />}
      <Tickets onNew={() => go({ new: "1" })} onOpen={(id) => go({ ticket: id })} />
      <Section title="Help yourself" intro="Most answers are already written down.">
        <DocumentationRow docsUrl={support.docsUrl} />
        <StatusRows url={support.statusUrl} />
      </Section>
    </>
  );
}

const hostOf = (url: string) => url.replace(/^https?:\/\//, "").replace(/\/$/, "");

function DocumentationRow({ docsUrl }: { docsUrl: string }) {
  return (
    <Row name="Documentation" hint={hostOf(docsUrl)} inline>
      <Button variant="ghost" size="md" asChild>
        <a href={docsUrl} target="_blank" rel="noopener noreferrer">
          Open
        </a>
      </Button>
    </Row>
  );
}

function Tickets({ onNew, onOpen }: { onNew: () => void; onOpen: (id: string) => void }) {
  const { data, error } = useQuery(workspaceSupportQuery);
  return (
    <Section
      title="Your tickets"
      intro="What this workspace has asked the people who run the instance, and their answers."
      action={
        <Button variant="primary" size="md" onClick={onNew}>
          <Icon name="plus" size={14} />
          New ticket
        </Button>
      }
    >
      {error ? (
        <p className="m-0 px-4 py-3 text-[13px] text-signal">{error.message}</p>
      ) : !data ? (
        <p className="m-0 px-4 py-3 text-[13px] text-ink-3">Loading</p>
      ) : data.tickets.length === 0 ? (
        <Row
          name="No tickets yet"
          hint="When something is wrong, start a ticket; the thread lives here, and you hear back by email."
        />
      ) : (
        data.tickets.map((t) => <TicketListRow key={t.id} ticket={t} onOpen={() => onOpen(t.id)} />)
      )}
    </Section>
  );
}

/** "Urgent and Emergency come with the Label plan." for the severities this plan leaves out. */
export function lockedLine(choices: WorkspaceSupport["severities"]): string | null {
  const byPlan = new Map<string, SupportSeverity[]>();
  for (const c of choices)
    if (!c.allowed) byPlan.set(c.plan ?? "", [...(byPlan.get(c.plan ?? "") ?? []), c.severity]);
  const lines = [...byPlan].map(([plan, severities]) => {
    const names = severities.map((s) => severityNames[s]);
    const list =
      names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
    const verb = names.length > 1 ? "come" : "comes";
    return plan
      ? `${list} ${verb} with the ${plan} plan.`
      : `${list} ${names.length > 1 ? "are" : "is"} not on this plan.`;
  });
  return lines.length > 0 ? lines.join(" ") : null;
}

/** New ticket: the documentation, common answers and the status page first, then the form. */
function NewTicket({
  docsUrl,
  statusUrl,
  from,
  onDone,
  onOpen,
}: {
  docsUrl: string;
  statusUrl: string;
  from?: AskedFrom;
  onDone: () => void;
  onOpen: (id: string) => void;
}) {
  const { data } = useQuery(workspaceSupportQuery);
  const sendTicket = useSendTicket();
  const [search, setSearch] = useState("");
  const [subject, setSubject] = useState("");
  const [kind, setKind] = useState<TicketKind>("problem");
  const [severity, setSeverity] = useState<SupportSeverity>("normal");
  const [message, setMessage] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [withError, setWithError] = useState(true);
  const [letOpen, setLetOpen] = useState(true);
  const [sent, setSent] = useState<TicketDetail | null>(null);
  const [tried, setTried] = useState(false);
  const chooser = useRef<HTMLInputElement>(null);
  const topics = search.trim() ? topicsFor(search) : helpTopics.slice(0, 3);
  const recent = data?.recentError ?? null;
  if (sent)
    return (
      <Section title="Sent" intro="You will hear back by email; the thread lives here.">
        <Row
          name={`Ticket ${sent.reference}`}
          hint="Normal severity is answered within a working day; higher ones sooner."
        >
          <Button variant="ghost" size="md" onClick={() => onOpen(sent.id)}>
            Open it
          </Button>
          <Button variant="secondary" size="md" onClick={onDone}>
            Back to your tickets
          </Button>
        </Row>
      </Section>
    );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (!subject.trim() || !message.trim()) return;
    sendTicket.mutate(
      {
        input: {
          subject,
          kind,
          severity,
          message,
          errorReference: recent && withError ? recent.reference : null,
          item: from ?? null,
          operatorAccess: from ? letOpen : false,
        },
        files,
      },
      { onSuccess: setSent },
    );
  };
  const drop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    setFiles([...files, ...Array.from(e.dataTransfer.files)].slice(0, 5));
  };
  const choices = data?.severities ?? [];
  const locked = lockedLine(choices);
  return (
    <>
      <Section title="Before you ask" intro="A minute here often saves a day.">
        <div className="flex flex-col gap-3 px-4 py-3">
          <form
            className="relative"
            onSubmit={(e) => {
              e.preventDefault();
              const first = topics[0];
              window.open(first ? `${docsUrl}${first.path}` : docsUrl, "_blank", "noopener");
            }}
          >
            <Icon
              name="search"
              size={16}
              className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-3"
            />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search the documentation"
              aria-label="Search the documentation"
              className="pl-9"
            />
          </form>
          {topics.length === 0 ? (
            <p className="m-0 text-[13px] text-ink-3">
              Nothing written down matches.{" "}
              <a
                href={docsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-ink-2 underline decoration-edge underline-offset-2 hover:text-ink"
              >
                Browse the documentation
              </a>
              , or ask below.
            </p>
          ) : (
            <div className="grid gap-2 @3xl/app:grid-cols-3">
              {topics.map((t) => (
                <a
                  key={t.path}
                  href={`${docsUrl}${t.path}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded-panel border border-line px-3 py-2.5 transition-colors hover:border-edge hover:bg-raised/40"
                >
                  <span className="block text-[13px] text-ink">{t.title}</span>
                  <span className="block text-[12px] text-ink-3">{t.hint}</span>
                </a>
              ))}
            </div>
          )}
        </div>
        <StatusRows url={statusUrl} hint="Something down for everyone is posted here first." />
      </Section>
      <Section
        title="New ticket"
        intro="The reference is made for you when you send. Operators see the error’s whole story if you include its reference."
      >
        <form className="flex flex-col gap-4 px-4 py-4" onSubmit={submit} noValidate>
          <Field
            label="Subject"
            error={tried && !subject.trim() ? "Say what is wrong, in a line" : undefined}
          >
            <Input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="What is wrong, in a line"
              maxLength={140}
              aria-invalid={tried && !subject.trim()}
            />
          </Field>
          <div className="grid gap-4 @md/app:grid-cols-2">
            <Field label="Type">
              <Select value={kind} onChange={(e) => setKind(e.target.value as TicketKind)}>
                {ticketKinds.map((k) => (
                  <option key={k} value={k}>
                    {ticketKindNames[k]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Severity"
              hint={`${severityHints[severity]}.${locked ? ` ${locked}` : ""}`}
            >
              <Select
                value={severity}
                onChange={(e) => setSeverity(e.target.value as SupportSeverity)}
              >
                {choices.map((c) => (
                  <option key={c.severity} value={c.severity} disabled={!c.allowed}>
                    {severityNames[c.severity]}
                    {c.allowed ? "" : c.plan ? ` (${c.plan} plan)` : " (not on this plan)"}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Message" error={tried && !message.trim() ? "Write a message" : undefined}>
            <Textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="What you did, what you expected, what happened. Paste the error reference if you saw one."
              className="h-32"
              aria-invalid={tried && !message.trim()}
            />
          </Field>
          <div className="flex flex-col gap-1.5 text-[13px] text-ink-2">
            Attachments
            {/* biome-ignore lint/a11y/noStaticElementInteractions: dropping is a shortcut; the button does the same. */}
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={drop}
              className={cn(
                "flex flex-wrap items-center gap-x-3 gap-y-2 rounded-panel border border-dashed px-3 py-2.5 text-[12px] text-ink-3 transition-colors",
                dragging ? "border-edge-strong bg-raised/40" : "border-line",
              )}
            >
              <Icon name="upload" size={14} />
              <span>Drop screenshots or logs here, up to five of 10 MB each, or</span>
              <Button variant="ghost" size="sm" onClick={() => chooser.current?.click()}>
                choose
              </Button>
              <FileInput
                ref={chooser}
                multiple
                aria-label="Choose attachments"
                onChange={(e) => {
                  setFiles([...files, ...Array.from(e.target.files ?? [])].slice(0, 5));
                  e.target.value = "";
                }}
              />
            </div>
            {files.length > 0 && <AttachPicker files={files} onChange={setFiles} />}
          </div>
          {recent && (
            <Choice
              checked={withError}
              onChange={(e) => setWithError(e.target.checked)}
              hint={`The last error you saw here, ${ago(recent.occurredAt)}. The operators see its whole story.`}
            >
              Attach error <span className="tabular">{recent.reference}</span>
            </Choice>
          )}
          {from && (
            <Choice checked={letOpen} onChange={(e) => setLetOpen(e.target.checked)}>
              Let the operators open the {from.kind} in question
            </Choice>
          )}
          {sendTicket.error && (
            <p role="alert" className="m-0 text-[13px] text-signal">
              {sendTicket.error.message}
            </p>
          )}
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={onDone}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              className="ml-auto"
              disabled={sendTicket.isPending}
            >
              {sendTicket.isPending ? "Sending" : "Send"}
            </Button>
          </div>
        </form>
      </Section>
    </>
  );
}
