import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Avatar } from "~/components/avatar";
import { Icon } from "~/components/icons";
import { Label } from "~/components/label";
import { Dot, type DotState } from "~/components/status";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import { Select } from "~/components/ui/input";
import { severities, type Ticket } from "~/data";
import { cn } from "~/lib/cn";

export const ticketDot = (state: Ticket["state"]): DotState =>
  state === "resolved" ? "approved" : state === "answered" ? "working" : "changes_requested";

export const ticketStateCopy: Record<Ticket["state"], string> = {
  open: "open",
  waiting: "waiting on support",
  answered: "answered",
  resolved: "resolved",
};

export const kindCopy: Record<Ticket["kind"], string> = {
  problem: "Something is broken",
  question: "A question",
  billing: "Billing",
  idea: "An idea",
};

/** One ticket as a thread in a modal. Operators also see who is asking and can jump to them. */
export function TicketDialog({
  ticket,
  operator = false,
  onClose,
}: {
  ticket: Ticket;
  operator?: boolean;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const [reply, setReply] = useState("");
  const [state, setState] = useState(ticket.state);
  const sev = severities.find((s) => s.id === ticket.severity);
  return (
    <Dialog
      title={`${ticket.reference} · ${ticket.subject}`}
      description={`${kindCopy[ticket.kind]} · ${sev?.label.toLowerCase()} · opened ${ticket.opened} · ${ticketStateCopy[state]}`}
      onClose={onClose}
      width={operator ? "xl" : "lg"}
      footer={
        <>
          {operator ? (
            <Select
              value={state}
              onChange={(e) => setState(e.target.value as Ticket["state"])}
              aria-label="State"
              className="h-8 w-48 text-[13px]"
            >
              <option value="open">Open</option>
              <option value="waiting">Waiting on support</option>
              <option value="answered">Answered</option>
              <option value="resolved">Resolved</option>
            </Select>
          ) : (
            state !== "resolved" && (
              <Button variant="ghost" onClick={() => setState("resolved")}>
                Mark resolved
              </Button>
            )
          )}
          <span className="flex-1" />
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button variant="primary" disabled={!reply.trim()} onClick={() => setReply("")}>
            Send
          </Button>
        </>
      }
    >
      <div className={cn("grid gap-6", operator && "@3xl/app:grid-cols-[minmax(0,1fr)_240px]")}>
        <div className="flex min-w-0 flex-col gap-4">
          <ol className="flex flex-col gap-3">
            {ticket.messages.map((m) => (
              <li
                key={m.id}
                className={cn("flex gap-3", m.from === "operator" && "flex-row-reverse text-right")}
              >
                {m.from === "system" ? (
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-raised text-ink-3">
                    <Icon name="bolt" size={13} />
                  </span>
                ) : ticket.requester.personId && m.from === "requester" ? (
                  <Avatar personId={ticket.requester.personId} size={28} />
                ) : (
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-raised text-[11px] font-medium text-ink-2">
                    {m.name
                      .split(" ")
                      .map((w) => w[0])
                      .join("")
                      .slice(0, 2)}
                  </span>
                )}
                <div
                  className={cn(
                    "flex min-w-0 max-w-[85%] flex-col gap-1",
                    m.from === "operator" && "items-end",
                  )}
                >
                  <span className="text-[12px] text-ink-3">
                    {m.name} · {m.at}
                  </span>
                  <p
                    className={cn(
                      "rounded-panel px-3 py-2 text-[13px] leading-[20px]",
                      m.from === "system"
                        ? "border border-dashed border-line text-ink-3"
                        : m.from === "operator"
                          ? "bg-signal/15 text-ink"
                          : "bg-raised text-ink",
                    )}
                  >
                    {m.text}
                  </p>
                  {m.attachments?.map((a) => (
                    <span key={a} className="flex items-center gap-1.5 text-[12px] text-ink-2">
                      <Icon name="file" size={12} />
                      {a}
                    </span>
                  ))}
                </div>
              </li>
            ))}
          </ol>
          <div className="flex flex-col gap-2">
            <textarea
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              placeholder={operator ? `Reply to ${ticket.requester.name.split(" ")[0]}…` : "Reply…"}
              className="h-24 rounded-control border border-edge bg-ground px-3 py-2 text-[13px] text-ink placeholder:text-ink-3 focus:border-ink-3 focus:outline-none"
            />
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm">
                <Icon name="plus" size={13} />
                Attach
              </Button>
              {operator && (
                <Select defaultValue="" className="h-7 w-44 text-[12px]" aria-label="Canned reply">
                  <option value="">Canned reply</option>
                  <option>Rate-limited channel</option>
                  <option>Quota raised</option>
                  <option>Fixed in the next patch</option>
                </Select>
              )}
            </div>
          </div>
        </div>
        {operator && (
          <aside className="flex flex-col gap-4 rounded-panel-lg border border-line bg-raised/25 p-4 text-[13px]">
            <div>
              <Label>Who</Label>
              <div className="mt-1.5 flex items-center gap-2.5">
                {ticket.requester.personId ? (
                  <Avatar personId={ticket.requester.personId} size={32} />
                ) : (
                  <span className="flex size-8 items-center justify-center rounded-full bg-raised text-[12px] font-medium text-ink-2">
                    {ticket.requester.name
                      .split(" ")
                      .map((w) => w[0])
                      .join("")}
                  </span>
                )}
                <span className="min-w-0">
                  <span className="block truncate text-ink">{ticket.requester.name}</span>
                  <span className="block truncate text-[12px] text-ink-3">
                    {ticket.requester.email}
                  </span>
                </span>
              </div>
              <p className="mt-1.5 text-[12px] text-ink-3">
                {ticket.requester.role} · seen {ticket.requester.seen}
              </p>
              <Button
                variant="secondary"
                size="sm"
                className="mt-2 w-full"
                onClick={() =>
                  navigate({ to: "/instance/$section", params: { section: "workspaces" } })
                }
              >
                Open the account
              </Button>
            </div>
            <div>
              <Label>Workspace</Label>
              <p className="mt-1.5 text-ink">{ticket.workspace}</p>
              <p className="tabular text-[12px] text-ink-3">
                {ticket.workspaceHost}.review.endlesshall.example
              </p>
              <p className="mt-1 text-[12px] text-ink-3">{ticket.plan} plan · 2 open reviews</p>
              <Button
                variant="ghost"
                size="sm"
                className="mt-2 w-full"
                onClick={() =>
                  navigate({ to: "/instance/$section", params: { section: "workspaces" } })
                }
              >
                Open the workspace
              </Button>
            </div>
            {ticket.errorRef && (
              <div>
                <Label>Error</Label>
                <p className="tabular mt-1.5 text-ink">{ticket.errorRef}</p>
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-2 w-full"
                  onClick={() =>
                    navigate({ to: "/instance/$section", params: { section: "debug" } })
                  }
                >
                  Look it up
                </Button>
              </div>
            )}
            <div>
              <Label>Severity</Label>
              <p className="mt-1.5 flex items-center gap-2 text-ink">
                <Dot
                  state={
                    ticket.severity === "high" ||
                    ticket.severity === "urgent" ||
                    ticket.severity === "emergency"
                      ? "changes_requested"
                      : "approved"
                  }
                />
                {sev?.label}
              </p>
              <p className="text-[12px] text-ink-3">{sev?.hint}</p>
            </div>
          </aside>
        )}
      </div>
    </Dialog>
  );
}

/** A row in a list of tickets. */
export function TicketRow({
  ticket,
  operator = false,
  onOpen,
}: {
  ticket: Ticket;
  operator?: boolean;
  onOpen: () => void;
}) {
  const sev = severities.find((s) => s.id === ticket.severity);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-raised/40"
    >
      <Dot state={ticketDot(ticket.state)} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 text-[14px] text-ink">
          <span className="tabular text-[12px] text-ink-3">{ticket.reference}</span>
          <span className="truncate">{ticket.subject}</span>
          {(ticket.severity === "high" ||
            ticket.severity === "urgent" ||
            ticket.severity === "emergency") && (
            <span className="rounded-chip border border-signal/40 px-1.5 text-[11px] text-signal">
              {sev?.label}
            </span>
          )}
        </span>
        <span className="block truncate text-[12px] text-ink-3">
          {operator ? `${ticket.workspace} · ${ticket.requester.name} · ` : ""}
          {kindCopy[ticket.kind]} · {ticketStateCopy[ticket.state]} · {ticket.updated}
        </span>
      </span>
      <span className="tabular text-[12px] text-ink-3">{ticket.messages.length}</span>
      <Icon name="chevronRight" size={14} className="text-ink-3" />
    </button>
  );
}
