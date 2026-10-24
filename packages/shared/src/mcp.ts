import { z } from "zod";
import { anchor } from "./anchor.ts";
import { type ApiScope, scopeAllows } from "./api-tokens.ts";
import { commentBody } from "./comments.ts";
import { reviewDecisions } from "./reviews.ts";

/**
 * The MCP endpoint (#199): a Model Context Protocol server inside the API, so an assistant
 * holding an API token or an OAuth access token can read what waits on its member, read a
 * review and its comments, comment, record a decision and read a QA report. Each tool is one
 * or more calls of the public API (#197) made with the same token, so it reaches what that
 * token reaches and nothing else. No media, and no address that would fetch any, leaves it.
 */

/** Where the endpoint answers (Streamable HTTP: one address, JSON-RPC messages posted to it). */
export const MCP_PATH = "/api/mcp";

/**
 * The protocol versions it speaks, newest first. A client asking for another is answered with
 * the newest, as the specification's version negotiation says.
 */
export const mcpProtocolVersions = ["2025-11-25", "2025-06-18"] as const;
export type McpProtocolVersion = (typeof mcpProtocolVersions)[number];

/** The version to answer `initialize` with: the one asked for if spoken, else the newest. */
export function negotiateProtocol(requested: unknown): McpProtocolVersion {
  return mcpProtocolVersions.find((v) => v === requested) ?? mcpProtocolVersions[0];
}

/** JSON-RPC 2.0's error codes, as MCP uses them. */
export const jsonRpcErrors = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const;

const rpcId = z.union([z.string().max(200), z.number().int()]);

/** One JSON-RPC message from a client: a request (with an id), a notification, or a response. */
export const jsonRpcMessage = z.union([
  z.object({
    jsonrpc: z.literal("2.0"),
    id: rpcId.optional(),
    method: z.string().min(1).max(200),
    params: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    jsonrpc: z.literal("2.0"),
    id: rpcId.nullable(),
    result: z.unknown().optional(),
    error: z.unknown().optional(),
  }),
]);
export type JsonRpcMessage = z.infer<typeof jsonRpcMessage>;

/** `tools/call`'s parameters. */
export const mcpToolCall = z.object({
  name: z.string().min(1).max(128),
  arguments: z.record(z.string(), z.unknown()).optional(),
});

const id = z.uuid();

/** `list_waiting_reviews`: the reviews asking something of the token's member. */
export const mcpListWaitingInput = z
  .object({
    include: z
      .enum(["waiting", "open", "all"])
      .default("waiting")
      .describe(
        "waiting: open reviews where it is your turn now (the default); open: every open review you are in; all: closed ones too.",
      ),
  })
  .strict();

/** `get_review`: one review, its items and reviewers, and the comments on what it reviews. */
export const mcpGetReviewInput = z
  .object({
    reviewId: id.describe("The review's id, from list_waiting_reviews."),
    comments: z
      .boolean()
      .default(true)
      .describe(
        "Include the comment threads on each reviewed file (needs the comments scope). Default true.",
      ),
  })
  .strict();

/** `list_comments`: a file's comment threads. */
export const mcpListCommentsInput = z
  .object({
    fileId: id.describe("The file's id, from a review's items."),
    unresolvedOnly: z.boolean().default(false).describe("Only threads not yet resolved."),
  })
  .strict();

/** `add_comment`: a new thread on a file, or a reply to one. */
export const mcpAddCommentInput = z
  .object({
    fileId: id.describe("The file to comment on."),
    body: commentBody.describe("The comment's text."),
    anchor: anchor
      .optional()
      .describe(
        "Where the comment points: a time range in seconds, a region of a page or frame, or a bar and beat. Leave it out for the whole file, and for a reply.",
      ),
    parentId: id.optional().describe("The thread to reply to; leave it out to start a thread."),
  })
  .strict()
  .refine((c) => !(c.parentId && c.anchor), {
    message: "A reply takes its thread's anchor",
    path: ["anchor"],
  });

/** `record_decision`: approved or changes requested, on an approval review. */
export const mcpRecordDecisionInput = z
  .object({
    reviewId: id.describe("The approval review to decide."),
    decision: z.enum(reviewDecisions).describe("approved, or changes_requested."),
    note: z.string().trim().max(4000).optional().describe("Said with the decision."),
  })
  .strict();

/** `get_qa_report`: a recording's or video's quality checks. */
export const mcpQaReportInput = z
  .object({ fileId: id.describe("The recording or video, from a review's items.") })
  .strict();

/** The tools the endpoint offers. */
export const mcpToolNames = [
  "list_waiting_reviews",
  "get_review",
  "list_comments",
  "add_comment",
  "record_decision",
  "get_qa_report",
] as const;
export type McpToolName = (typeof mcpToolNames)[number];

export interface McpToolSpec {
  name: McpToolName;
  title: string;
  description: string;
  /** The scope it needs, as `scopeFor` asks of the calls it makes. */
  scope: ApiScope;
  input: z.ZodType;
  /** Reads only, or changes something. */
  readOnly: boolean;
}

/** Each tool: what it is called, what it does, the scope it needs and what it takes. */
export const mcpTools: readonly McpToolSpec[] = [
  {
    name: "list_waiting_reviews",
    title: "Reviews waiting on me",
    description:
      "Lists the reviews that ask something of you in this workspace, open ones first: by default those where it is your turn now. Each names its project, kind (approval, feedback or share), status and due date.",
    scope: "reviews:read",
    input: mcpListWaitingInput,
    readOnly: true,
  },
  {
    name: "get_review",
    title: "Read a review",
    description:
      "Reads one review: its message, items (files, or tracks at a version), reviewers with their state and decision, the decisions so far, what you may do in it, and the comment threads on each reviewed file.",
    scope: "reviews:read",
    input: mcpGetReviewInput,
    readOnly: true,
  },
  {
    name: "list_comments",
    title: "Read a file's comments",
    description:
      "Lists a file's comment threads with their replies: who wrote each, when, where it points (time, region or bar) and whether it is resolved.",
    scope: "comments",
    input: mcpListCommentsInput,
    readOnly: true,
  },
  {
    name: "add_comment",
    title: "Add a comment",
    description:
      "Adds a comment to a file as you, starting a thread (optionally anchored to a time range, a region or a bar) or replying to one. Mentions and notifications follow as they do in the app.",
    scope: "comments",
    input: mcpAddCommentInput,
    readOnly: false,
  },
  {
    name: "record_decision",
    title: "Record a decision",
    description:
      "Records your decision on an approval review: approved or changes requested, with an optional note. Only where you are a reviewer, it is your turn, and your role allows deciding; it is logged as any decision is.",
    scope: "reviews:write",
    input: mcpRecordDecisionInput,
    readOnly: false,
  },
  {
    name: "get_qa_report",
    title: "Read a QA report",
    description:
      "Reads a recording's or video's quality report: the delivery profile it is measured against and each finding (loudness, true peak, clipping, format and the like), with its severity and where in the file it is.",
    scope: "files:read",
    input: mcpQaReportInput,
    readOnly: true,
  },
];

/** The tools a token with these scopes may call, which is all `tools/list` shows it. */
export const mcpToolsFor = (scopes: readonly ApiScope[]) =>
  mcpTools.filter((t) => scopeAllows(scopes, t.scope));
