import type {
  CannedReply,
  CannedReplyInput,
  OperatorTicketDetail,
  SupportDesk,
  SupportDeskInput,
  SupportFigures,
  SupportSeverity,
  TicketAttachment,
  TicketDetail,
  TicketInput,
  TicketRow,
  TicketState,
  WorkspaceSupport,
} from "@hekate/shared";
import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { json } from "./queries";

/**
 * Support (#181, #182): the workspace's tickets and the instance's desk. Attachments go up as
 * the bytes themselves once their message is sent, and come down as the answer to a request
 * made in the session, never as an address.
 */

export const workspaceSupportQuery = queryOptions({
  queryKey: ["support"],
  queryFn: async () => json<WorkspaceSupport>(await api.organisation.support.$get()),
});

export const ticketQuery = (id: string) =>
  queryOptions({
    queryKey: ["support", "ticket", id],
    queryFn: async () =>
      json<{ ticket: TicketDetail }>(
        await api.organisation.support.tickets[":id"].$get({ param: { id } }),
      ),
  });

/** Where a message's attachments are sent, from the workspace or the desk. */
const attachmentsUrl = (side: "organisation" | "instance", ticketId: string, messageId: string) =>
  `/api/${side}/support/tickets/${ticketId}/messages/${messageId}/attachments`;

async function attach(url: string, files: File[]) {
  for (const file of files)
    await json<{ attachment: TicketAttachment }>(
      await fetch(url, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": file.type || "application/octet-stream",
          "x-file-name": encodeURIComponent(file.name),
        },
        body: file,
      }),
    );
}

/** Sends a ticket, then its attachments. */
export function useSendTicket() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ input, files }: { input: TicketInput; files: File[] }) => {
      const made = await json<{ ticket: TicketDetail; messageId: string }>(
        await api.organisation.support.tickets.$post({ json: input }),
      );
      await attach(attachmentsUrl("organisation", made.ticket.id, made.messageId), files);
      return made.ticket;
    },
    onSettled: () => client.invalidateQueries({ queryKey: ["support"] }),
  });
}

/** A reply from the workspace, then its attachments. */
export function useReplyToTicket(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ body, files }: { body: string; files: File[] }) => {
      const sent = await json<{ ticket: TicketDetail; messageId: string }>(
        await api.organisation.support.tickets[":id"].messages.$post({
          param: { id },
          json: { body },
        }),
      );
      await attach(attachmentsUrl("organisation", id, sent.messageId), files);
    },
    onSettled: () => client.invalidateQueries({ queryKey: ["support"] }),
  });
}

export function useResolveTicket(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      json<{ ticket: TicketDetail }>(
        await api.organisation.support.tickets[":id"].resolve.$post({ param: { id } }),
      ),
    onSuccess: () => client.invalidateQueries({ queryKey: ["support"] }),
  });
}

/** Saves an attachment: its bytes asked for in this session, handed to the browser to keep. */
export async function downloadAttachment(
  side: "organisation" | "instance",
  ticketId: string,
  attachment: TicketAttachment,
) {
  const res = await fetch(
    `/api/${side}/support/tickets/${ticketId}/attachments/${attachment.id}/download`,
    { method: "POST", credentials: "same-origin" },
  );
  if (!res.ok) await json(res);
  const href = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = href;
  a.download = attachment.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}

/** The desk's filters, as its list asks for them. */
export interface DeskFilters {
  state: "open" | "waiting" | "all";
  severity?: SupportSeverity;
  workspace?: string;
  q?: string;
}

export const deskTicketsQuery = (filters: DeskFilters) =>
  queryOptions({
    queryKey: ["instance", "support", "tickets", filters],
    queryFn: async () =>
      json<{
        tickets: TicketRow[];
        figures: SupportFigures;
        workspaces: { id: string; name: string }[];
      }>(
        await api.instance.support.$get({
          query: {
            state: filters.state,
            ...(filters.severity ? { severity: filters.severity } : {}),
            ...(filters.workspace ? { workspace: filters.workspace } : {}),
            ...(filters.q ? { q: filters.q } : {}),
          },
        }),
      ),
  });

export const deskTicketQuery = (id: string) =>
  queryOptions({
    queryKey: ["instance", "support", "ticket", id],
    queryFn: async () =>
      json<{ ticket: OperatorTicketDetail }>(
        await api.instance.support.tickets[":id"].$get({ param: { id } }),
      ),
  });

/** An operator's answer, setting where the ticket stands as it goes, then its attachments. */
export function useDeskReply(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { body: string; state?: TicketState; files: File[] }) => {
      const sent = await json<{ messageId: string }>(
        await api.instance.support.tickets[":id"].messages.$post({
          param: { id },
          json: { body: input.body, ...(input.state ? { state: input.state } : {}) },
        }),
      );
      await attach(attachmentsUrl("instance", id, sent.messageId), input.files);
    },
    onSettled: () => client.invalidateQueries({ queryKey: ["instance", "support"] }),
  });
}

export function useDeskState(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (state: TicketState) =>
      json<{ ticket: OperatorTicketDetail }>(
        await api.instance.support.tickets[":id"].state.$put({ param: { id }, json: { state } }),
      ),
    onSuccess: () => client.invalidateQueries({ queryKey: ["instance", "support"] }),
  });
}

export const cannedRepliesQuery = queryOptions({
  queryKey: ["instance", "support", "replies"],
  queryFn: async () => json<{ replies: CannedReply[] }>(await api.instance.support.replies.$get()),
});

export function useSaveCannedReply() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, input }: { id?: string; input: CannedReplyInput }) =>
      json<{ replies: CannedReply[] }>(
        id
          ? await api.instance.support.replies[":id"].$put({ param: { id }, json: input })
          : await api.instance.support.replies.$post({ json: input }),
      ),
    onSuccess: () => client.invalidateQueries({ queryKey: ["instance", "support", "replies"] }),
  });
}

export function useRemoveCannedReply() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      json<{ replies: CannedReply[] }>(
        await api.instance.support.replies[":id"].$delete({ param: { id } }),
      ),
    onSuccess: () => client.invalidateQueries({ queryKey: ["instance", "support", "replies"] }),
  });
}

export const supportDeskQuery = queryOptions({
  queryKey: ["instance", "support", "desk"],
  queryFn: async () => json<SupportDesk>(await api.instance.support.desk.$get()),
});

export function useSaveDesk() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: SupportDeskInput) =>
      json<SupportDesk>(await api.instance.support.desk.$put({ json: input })),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["instance", "support", "desk"] });
      void client.invalidateQueries({ queryKey: ["me"] });
    },
  });
}
