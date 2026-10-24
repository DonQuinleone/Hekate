import type { Database } from "@hekate/db";
import {
  API_TOKEN_RATE,
  apiBase,
  apiScopes,
  jsonRpcErrors,
  jsonRpcMessage,
  MCP_PATH,
  mcpProtocolVersions,
  mcpToolCall,
  mcpTools,
  mcpToolsFor,
  negotiateProtocol,
} from "@hekate/shared";
import type { Context } from "hono";
import { Hono } from "hono";
import type { z } from "zod";
import { type ApiTokenContext, bearerOf, liveToken } from "./api-tokens.ts";
import { pinnedWorkspace } from "./hosts.ts";
import { type ApiAnswer, type ApiCall, ToolRefusal, toolRunners } from "./mcp-tools.ts";
import { jsonSchemaOf } from "./openapi/schema.ts";
import { admit } from "./rate-limit.ts";
import { version } from "./version.ts";

/**
 * The MCP endpoint (#199, decision 231): the Model Context Protocol's Streamable HTTP transport
 * at `/api/mcp`, stateless, answering JSON-RPC requests with one JSON response each (or one
 * event, for a client that takes only a stream). It takes an API token or an OAuth access token
 * (`Authorization: Bearer hk_…`) and nothing else: no session cookie, so no page can make a
 * signed-in browser call it. Its tools call the public API with that token (`mcp-tools.ts`).
 */

export interface McpDeps {
  db: Database;
  publicUrl: string;
  /** Answers a request as the whole app does: how a tool calls the public API, in-process. */
  fetch: (request: Request, env: unknown) => Response | Promise<Response>;
}

const origin = (url: string) => new URL(url).origin;

/** The endpoint's own address, which an OAuth client asks a token for (RFC 8707's resource). */
export const mcpResource = (publicUrl: string) => `${origin(publicUrl)}${MCP_PATH}`;

/** Where the endpoint's protected resource metadata is (RFC 9728, the path inserted). */
export const resourceMetadataUrl = (publicUrl: string) =>
  `${origin(publicUrl)}/.well-known/oauth-protected-resource${MCP_PATH}`;

/**
 * The protected resource metadata (RFC 9728), which an MCP client reads to find the
 * authorisation server (Hekate's own, decision 225) and the scopes. `resource` is the endpoint
 * at its own address, or the instance's API as a whole at the root document: a token is for the
 * whole API, of which the endpoint is part.
 */
export function protectedResourceMetadata(
  publicUrl: string,
  resource: "mcp" | "api",
  docsUrl?: string,
) {
  const issuer = publicUrl.replace(/\/+$/, "");
  return {
    resource: resource === "mcp" ? mcpResource(publicUrl) : origin(publicUrl),
    authorization_servers: [issuer],
    scopes_supported: [...apiScopes],
    bearer_methods_supported: ["header"],
    resource_name: "Hekate",
    ...(docsUrl ? { resource_documentation: `${docsUrl.replace(/\/+$/, "")}/use/mcp/` } : {}),
  };
}

/** Headers passed on to the calls a tool makes: who asks, and where they asked from. */
const FORWARDED = [
  "authorization",
  "user-agent",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "forwarded",
] as const;

const rpcError = (id: string | number | null, code: number, message: string, data?: unknown) => ({
  jsonrpc: "2.0" as const,
  id,
  error: { code, message, ...(data === undefined ? {} : { data }) },
});
const rpcResult = (id: string | number, result: unknown) => ({
  jsonrpc: "2.0" as const,
  id,
  result,
});

/** What the assistant is told when it connects. */
const INSTRUCTIONS =
  "Hekate is a media review and approval system. These tools act as the member who holds the token, in one workspace, within the token's scopes. Start with list_waiting_reviews to see what is waiting, read a review with get_review, comment with add_comment and decide an approval with record_decision. Media never leaves through these tools: point people to the review in Hekate to listen or watch.";

/** A tool as `tools/list` describes it. */
const describe = (tool: (typeof mcpTools)[number]) => ({
  name: tool.name,
  title: tool.title,
  description: tool.description,
  inputSchema: jsonSchemaOf(tool.input),
  annotations: {
    title: tool.title,
    readOnlyHint: tool.readOnly,
    destructiveHint: false,
    idempotentHint: tool.readOnly,
    openWorldHint: false,
  },
});

/** A tool's answer: its data as text (for older clients) and as structured content. */
const toolResult = (data: unknown) => ({
  content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  structuredContent: data,
});
const toolError = (message: string) => ({
  content: [{ type: "text", text: message }],
  isError: true,
});

/**
 * Keys that never leave, wherever an answer came to hold them: the tools pass on fields by
 * name, so none should be there; this is the second lock on that door.
 */
const WITHHELD = /url|href|link|playlist|segment|secret|token|key$/i;

/** An answer with every withheld key taken out, all the way down. */
export function withheld(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withheld);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !WITHHELD.test(key))
      .map(([key, inner]) => [key, withheld(inner)]),
  );
}

/** A zod failure as one line the assistant can act on. */
const issuesText = (error: z.ZodError) =>
  `Check the arguments: ${error.issues
    .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
    .join("; ")}`;

/**
 * `/api/mcp`. POST takes one JSON-RPC message; GET and DELETE are answered 405, as a stateless
 * server with no stream of its own to offer. Registered before the token middleware, which
 * would refuse a path no scope names: this checks the token itself, and every call a tool
 * makes passes that middleware as any other call does.
 */
export function mcpRoutes(deps: McpDeps) {
  const challenge = (error?: string) =>
    `Bearer ${error ? `error="${error}", ` : ""}resource_metadata="${resourceMetadataUrl(deps.publicUrl)}"`;

  /** A call of the public API as the request's own token, through the whole app. */
  const callerFor =
    (c: Context): ApiCall =>
    async (method, path, body) => {
      const headers = new Headers();
      for (const name of FORWARDED) {
        const value = c.req.header(name);
        if (value) headers.set(name, value);
      }
      if (body !== undefined) headers.set("content-type", "application/json");
      const res = await deps.fetch(
        new Request(new URL(`${apiBase()}${path}`, c.req.url), {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
        c.env,
      );
      const text = await res.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      if (res.ok) return { ok: true, status: res.status, body: parsed } satisfies ApiAnswer;
      const error =
        parsed && typeof parsed === "object" && "error" in parsed
          ? ((parsed as { error: { code?: unknown; message?: unknown; reference?: unknown } })
              .error ?? {})
          : {};
      return {
        ok: false,
        status: res.status,
        code: typeof error.code === "string" ? error.code : "http_error",
        message: typeof error.message === "string" ? error.message : res.statusText || "Refused",
        reference: typeof error.reference === "string" ? error.reference : null,
      } satisfies ApiAnswer;
    };

  /** One request's answer: its result, or a JSON-RPC error. */
  async function answer(
    c: Context,
    token: ApiTokenContext,
    id: string | number,
    method: string,
    params: Record<string, unknown> | undefined,
  ) {
    switch (method) {
      case "initialize":
        return rpcResult(id, {
          protocolVersion: negotiateProtocol(params?.protocolVersion),
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "hekate", title: "Hekate", version },
          instructions: INSTRUCTIONS,
        });
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, { tools: mcpToolsFor(token.scopes).map(describe) });
      case "tools/call": {
        const call = mcpToolCall.safeParse(params ?? {});
        if (!call.success) return rpcError(id, jsonRpcErrors.invalidParams, issuesText(call.error));
        const tool = mcpTools.find((t) => t.name === call.data.name);
        if (!tool)
          return rpcError(id, jsonRpcErrors.invalidParams, `Unknown tool: ${call.data.name}`);
        // Refused here as the API would refuse its calls, before any is made.
        if (!mcpToolsFor(token.scopes).includes(tool))
          return rpcResult(
            id,
            toolError(
              `That needs the ${tool.scope} scope, which this token does not have. [403 insufficient_scope]`,
            ),
          );
        const input = tool.input.safeParse(call.data.arguments ?? {});
        if (!input.success) return rpcResult(id, toolError(issuesText(input.error)));
        try {
          const data = await toolRunners[tool.name](
            { call: callerFor(c), scopes: token.scopes },
            input.data,
          );
          return rpcResult(id, toolResult(withheld(data)));
        } catch (error) {
          if (error instanceof ToolRefusal) return rpcResult(id, toolError(error.message));
          throw error;
        }
      }
      default:
        return rpcError(id, jsonRpcErrors.methodNotFound, `Method not found: ${method}`);
    }
  }

  /** The answer as the client asked for it: JSON, or one event on a stream. */
  const reply = (c: Context, message: unknown) => {
    const accept = c.req.header("accept") ?? "";
    if (accept && !/application\/json|\*\/\*/.test(accept) && /text\/event-stream/.test(accept)) {
      return c.body(`event: message\ndata: ${JSON.stringify(message)}\n\n`, 200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
      });
    }
    return c.json(message, 200, { "cache-control": "no-store" });
  };

  const notAllowed = (c: Context) => {
    c.header("Allow", "POST");
    return c.json(
      {
        error: {
          code: "method_not_allowed",
          message: "This endpoint takes JSON-RPC messages by POST, and keeps no stream or session.",
        },
      },
      405,
    );
  };

  return new Hono()
    .get("/", notAllowed)
    .delete("/", notAllowed)
    .post("/", async (c) => {
      // Against DNS rebinding, as the transport asks: a browser's request from another site.
      const from = c.req.header("origin");
      if (from && from !== origin(deps.publicUrl) && from !== origin(c.req.url))
        return c.json(
          { error: { code: "origin_refused", message: "That origin may not call this endpoint." } },
          403,
        );
      const secret = bearerOf(c);
      if (!secret) {
        c.header("WWW-Authenticate", challenge());
        return c.json(
          {
            error: {
              code: "unauthorised",
              message: "This endpoint takes an API token or an OAuth access token.",
            },
          },
          401,
        );
      }
      const token = await liveToken(deps.db, secret);
      const pinned = pinnedWorkspace(c);
      if (!token || (pinned && pinned.id !== token.organisationId)) {
        c.header("WWW-Authenticate", challenge("invalid_token"));
        return c.json(
          {
            error: {
              code: "token_invalid",
              message: "That token does not work here: it may have been revoked, or have expired.",
            },
          },
          401,
        );
      }
      const asked = c.req.header("mcp-protocol-version");
      if (asked && !mcpProtocolVersions.some((v) => v === asked))
        return c.json(
          rpcError(
            null,
            jsonRpcErrors.invalidRequest,
            `Protocol version ${asked} is not supported; this server speaks ${mcpProtocolVersions.join(", ")}.`,
          ),
          400,
        );
      let raw: unknown;
      try {
        raw = await c.req.json();
      } catch {
        return c.json(rpcError(null, jsonRpcErrors.parse, "That is not JSON."), 400);
      }
      if (Array.isArray(raw))
        return c.json(
          rpcError(null, jsonRpcErrors.invalidRequest, "Send one message at a time."),
          400,
        );
      const parsed = jsonRpcMessage.safeParse(raw);
      if (!parsed.success)
        return c.json(
          rpcError(null, jsonRpcErrors.invalidRequest, "That is not a JSON-RPC 2.0 message."),
          400,
        );
      const message = parsed.data;
      // A notification, or a response to a request this server never makes: taken, unanswered.
      if (!("method" in message) || message.id === undefined) return c.body(null, 202);
      // A tool's calls are counted as they pass the token middleware; the rest are counted here.
      if (message.method !== "tools/call") {
        const { allowed, retryAfter } = await admit(
          deps.db,
          `api-token:${token.id}`,
          API_TOKEN_RATE,
        );
        if (!allowed) {
          c.header("Retry-After", String(retryAfter));
          return c.json(
            rpcError(message.id, jsonRpcErrors.internal, "Too many calls; wait a moment."),
            429,
          );
        }
      }
      return reply(c, await answer(c, token, message.id, message.method, message.params));
    });
}
