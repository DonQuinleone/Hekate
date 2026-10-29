import {
  type ApiScope,
  type McpToolName,
  mcpAddCommentInput,
  mcpGetReviewInput,
  mcpListCommentsInput,
  mcpListWaitingInput,
  mcpQaReportInput,
  mcpRecordDecisionInput,
  scopeAllows,
} from "@hekate/shared";

/**
 * The MCP endpoint's tools (#199, decision 231). Each is made of calls to the public API
 * (`/api/v1`), made in-process with the caller's own token, so the token's scopes, its
 * workspace, its member's role and every check a route makes apply as they would to a script.
 * What comes back is reshaped by allow-list: only the fields named here leave, so no address
 * that would fetch media (nor anything a later route adds) can reach an assistant.
 */

/** A call of the public API, as the tool's token, and what it answered. */
export type ApiCall = (method: "GET" | "POST", path: string, body?: unknown) => Promise<ApiAnswer>;

export type ApiAnswer =
  | { ok: true; status: number; body: unknown }
  | { ok: false; status: number; code: string; message: string; reference: string | null };

/** A tool that could not do what was asked, in words the assistant can pass on or act on. */
export class ToolRefusal extends Error {}

/** What a tool needs: the API, and the scopes its token holds (to leave out what it cannot read). */
export interface ToolContext {
  call: ApiCall;
  scopes: readonly ApiScope[];
}

/** The answer's body, or a refusal saying why there is none. */
async function answer(context: ToolContext, ...args: Parameters<ApiCall>): Promise<unknown> {
  const got = await context.call(...args);
  if (got.ok) return got.body;
  throw new ToolRefusal(refusalText(got));
}

/** A refusal as the assistant reads it: the API's own words, its code, and a reference if any. */
export function refusalText(got: Extract<ApiAnswer, { ok: false }>): string {
  const reference = got.reference ? ` (reference ${got.reference})` : "";
  return `${got.message} [${got.status} ${got.code}]${reference}`;
}

// What the API answers, as far as the tools read it. Fields are read by name and nothing else
// is passed on, so these list only what is read.

type Row = Record<string, unknown>;
const rowsOf = (value: unknown, key: string): Row[] => {
  const list = value && typeof value === "object" ? (value as Row)[key] : undefined;
  return Array.isArray(list) ? (list as Row[]) : [];
};
const rowOf = (value: unknown, key: string): Row => {
  const row = value && typeof value === "object" ? (value as Row)[key] : undefined;
  return row && typeof row === "object" ? (row as Row) : {};
};
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
const bool = (v: unknown): boolean => v === true;

/** A review in a list: what it is, where, and whether it waits on you. */
export function waitingReviewOf(r: Row) {
  return {
    id: str(r.id),
    title: str(r.title),
    kind: str(r.kind),
    status: str(r.status),
    outcome: str(r.outcome),
    order: str(r.order),
    project: { id: str(r.projectId), name: str(r.projectName) },
    dueAt: str(r.dueAt),
    createdAt: str(r.createdAt),
    yourTurn: bool(r.yourTurn),
    youSubmittedAt: str(r.submittedAt),
  };
}

/** An anchor, passed on as the shared schema defines it (positions, never addresses). */
const anchorOf = (v: unknown) => (v && typeof v === "object" ? v : null);

/** One comment, without its replies. */
export function commentOf(c: Row) {
  const carry = c.carry && typeof c.carry === "object" ? (c.carry as Row) : null;
  const from = carry?.from && typeof carry.from === "object" ? (carry.from as Row) : null;
  return {
    id: str(c.id),
    parentId: str(c.parentId),
    body: str(c.body),
    anchor: anchorOf(c.anchor),
    channel: num(c.channel),
    author: str(c.authorName),
    byGuest: bool(c.authorGuest),
    guestLabel: str(c.authorLabel),
    mine: bool(c.mine),
    createdAt: str(c.createdAt),
    editedAt: str(c.editedAt),
    resolvedAt: str(c.resolvedAt),
    resolvedBy: str(c.resolvedByName),
    assignee: str(c.assigneeName),
    mentions: Array.isArray(c.mentions)
      ? (c.mentions as Row[]).map((m) => str(m.name)).filter((n): n is string => n !== null)
      : [],
    // Their names and sizes: an attachment is fetched only as a download, never through here.
    attachments: Array.isArray(c.attachments)
      ? (c.attachments as Row[]).map((a) => ({
          name: str(a.name),
          contentType: str(a.contentType),
          byteSize: num(a.byteSize),
        }))
      : [],
    /** Carried from an earlier version: the file it began on. */
    carriedFrom: from ? str(from.fileId) : null,
  };
}

/** A file's comments as threads, each with its replies in order. */
export function threadsOf(rows: Row[], unresolvedOnly = false) {
  const comments = rows.map(commentOf);
  const replies = new Map<string, ReturnType<typeof commentOf>[]>();
  for (const c of comments)
    if (c.parentId) replies.set(c.parentId, [...(replies.get(c.parentId) ?? []), c]);
  return comments
    .filter((c) => !c.parentId && (!unresolvedOnly || c.resolvedAt === null))
    .map((c) => ({
      ...c,
      replies: (replies.get(c.id ?? "") ?? []).sort((a, b) =>
        (a.createdAt ?? "").localeCompare(b.createdAt ?? ""),
      ),
    }));
}

/** A review as an assistant reads it; reviewers' addresses are left out. */
export function reviewOf(r: Row) {
  const you = r.you && typeof r.you === "object" ? (r.you as Row) : {};
  return {
    id: str(r.id),
    title: str(r.title),
    kind: str(r.kind),
    message: str(r.message),
    status: str(r.status),
    outcome: str(r.outcome),
    order: str(r.order),
    rule: str(r.rule),
    dueAt: str(r.dueAt),
    createdAt: str(r.createdAt),
    completedAt: str(r.completedAt),
    requestedBy: str(r.createdByName),
    cancelledBy: str(r.cancelledByName),
    cancelReason: str(r.cancelReason),
    project: { id: str(r.projectId), profile: str(r.profile) },
    items: rowsOf(r, "items").map((i) => {
      const version = i.version && typeof i.version === "object" ? (i.version as Row) : null;
      return {
        id: str(i.id),
        kind: str(i.kind),
        name: str(i.name),
        fileId: str(i.fileId),
        fileKind: str(i.fileKind),
        trackId: str(i.trackId),
        follows: str(i.follows),
        version: version
          ? {
              number: num(version.number),
              variants: Array.isArray(version.variants)
                ? (version.variants as unknown[]).filter((v) => typeof v === "string")
                : [],
            }
          : null,
        openComments: num(i.openComments),
      };
    }),
    reviewers: rowsOf(r, "reviewers").map((p) => {
      const group = p.group && typeof p.group === "object" ? (p.group as Row) : null;
      return {
        name: str(p.name),
        label: str(p.label),
        guest: bool(p.guest),
        group: group ? str(group.name) : null,
        step: num(p.step),
        state: str(p.state),
        decision: str(p.decision),
        decidedAt: str(p.decidedAt),
        submittedAt: str(p.submittedAt),
        note: str(p.note),
      };
    }),
    decisions: rowsOf(r, "decisions").map((d) => ({
      reviewer: str(d.reviewerName),
      decision: str(d.decision),
      note: str(d.note),
      at: str(d.createdAt),
    })),
    you: {
      reviewer: str(you.reviewerId) !== null,
      yourTurn: bool(you.active),
      canDecide: bool(you.canDecide),
      canSubmit: bool(you.canSubmit),
    },
  };
}

/** A QA report: the profile it is measured against, and each finding. */
export function qaReportOf(q: Row) {
  const profile = rowOf(q, "profile");
  return {
    status: str(q.status),
    profile: {
      label: str(profile.label),
      source: str(profile.source),
      chosen: bool(profile.chosen),
    },
    findings: rowsOf(q, "findings").map((f) => ({
      check: str(f.check),
      severity: str(f.severity),
      summary: str(f.summary),
      channel: num(f.channel),
      start: num(f.start),
      end: num(f.end),
      details:
        f.details && typeof f.details === "object"
          ? Object.fromEntries(
              Object.entries(f.details as Row).filter(([, v]) =>
                ["number", "string", "boolean"].includes(typeof v),
              ),
            )
          : {},
    })),
  };
}

/** The most files `get_review` reads comments for, so one call stays bounded. */
export const REVIEW_COMMENT_FILES = 20;

type Tool = (context: ToolContext, input: unknown) => Promise<unknown>;

/** Each tool's work: its input already checked against its schema in `packages/shared`. */
export const toolRunners: Record<McpToolName, Tool> = {
  async list_waiting_reviews(context, raw) {
    const input = mcpListWaitingInput.parse(raw);
    const rows = rowsOf(await answer(context, "GET", "/reviews"), "reviews").map(waitingReviewOf);
    const reviews = rows.filter((r) =>
      input.include === "all" ? true : input.include === "open" ? r.status === "open" : r.yourTurn,
    );
    return { reviews };
  },

  async get_review(context, raw) {
    const input = mcpGetReviewInput.parse(raw);
    const review = reviewOf(
      rowOf(await answer(context, "GET", `/reviews/${input.reviewId}`), "review"),
    );
    if (!input.comments) return { review };
    if (!scopeAllows(context.scopes, "comments"))
      return {
        review,
        comments: null,
        note: "Comments are left out: this token does not have the comments scope.",
      };
    const fileIds = [...new Set(review.items.flatMap((i) => (i.fileId ? [i.fileId] : [])))].slice(
      0,
      REVIEW_COMMENT_FILES,
    );
    const comments = [];
    for (const fileId of fileIds) {
      const got = await context.call("GET", `/files/${fileId}/comments`);
      comments.push(
        got.ok
          ? { fileId, threads: threadsOf(rowsOf(got.body, "comments")) }
          : { fileId, threads: null, refused: refusalText(got) },
      );
    }
    return { review, comments };
  },

  async list_comments(context, raw) {
    const input = mcpListCommentsInput.parse(raw);
    const rows = rowsOf(
      await answer(context, "GET", `/files/${input.fileId}/comments`),
      "comments",
    );
    return { fileId: input.fileId, threads: threadsOf(rows, input.unresolvedOnly) };
  },

  async add_comment(context, raw) {
    const input = mcpAddCommentInput.parse(raw);
    const made = await answer(context, "POST", `/files/${input.fileId}/comments`, {
      body: input.body,
      ...(input.anchor ? { anchor: input.anchor } : {}),
      ...(input.parentId ? { parentId: input.parentId } : {}),
    });
    return { comment: commentOf(rowOf(made, "comment")) };
  },

  async record_decision(context, raw) {
    const input = mcpRecordDecisionInput.parse(raw);
    const decided = await answer(context, "POST", `/reviews/${input.reviewId}/decisions`, {
      decision: input.decision,
      ...(input.note ? { note: input.note } : {}),
    });
    return { review: reviewOf(rowOf(decided, "review")) };
  },

  async get_qa_report(context, raw) {
    const input = mcpQaReportInput.parse(raw);
    const report = await answer(context, "GET", `/files/${input.fileId}/qa`);
    return { fileId: input.fileId, report: qaReportOf(report as Row) };
  },
};
