import { describe, expect, it } from "vitest";
import { scopeFor } from "./api-tokens.ts";
import {
  jsonRpcMessage,
  MCP_PATH,
  mcpAddCommentInput,
  mcpTools,
  mcpToolsFor,
  negotiateProtocol,
} from "./mcp.ts";

describe("the MCP endpoint's pieces (#199)", () => {
  it("answers the version asked for when it speaks it, else its newest", () => {
    expect(negotiateProtocol("2025-06-18")).toBe("2025-06-18");
    expect(negotiateProtocol("2025-11-25")).toBe("2025-11-25");
    expect(negotiateProtocol("2024-11-05")).toBe("2025-11-25");
    expect(negotiateProtocol(undefined)).toBe("2025-11-25");
  });

  it("lists a tool only for a token whose scopes allow it, a write scope including its read", () => {
    expect(mcpToolsFor(["reviews:read"]).map((t) => t.name)).toEqual([
      "list_waiting_reviews",
      "get_review",
    ]);
    expect(mcpToolsFor(["reviews:write"]).map((t) => t.name)).toEqual([
      "list_waiting_reviews",
      "get_review",
      "record_decision",
    ]);
    expect(mcpToolsFor(["files:write"]).map((t) => t.name)).toEqual(["get_qa_report"]);
    expect(mcpToolsFor(["downloads", "workflows", "org:read"])).toEqual([]);
  });

  it("names tools as the protocol allows, and is itself a path no token scope reaches", () => {
    for (const tool of mcpTools) expect(tool.name).toMatch(/^[A-Za-z0-9_.-]{1,128}$/);
    // The endpoint checks its token itself; the token middleware would refuse it.
    expect(scopeFor("POST", MCP_PATH)).toBeNull();
  });

  it("takes requests, notifications and responses, and nothing else", () => {
    expect(jsonRpcMessage.safeParse({ jsonrpc: "2.0", id: 1, method: "ping" }).success).toBe(true);
    expect(
      jsonRpcMessage.safeParse({ jsonrpc: "2.0", method: "notifications/initialized" }).success,
    ).toBe(true);
    expect(jsonRpcMessage.safeParse({ jsonrpc: "2.0", id: 1, result: {} }).success).toBe(true);
    expect(jsonRpcMessage.safeParse({ jsonrpc: "1.0", id: 1, method: "ping" }).success).toBe(false);
    expect(jsonRpcMessage.safeParse({ id: 1, method: "ping" }).success).toBe(false);
  });

  it("refuses a reply with an anchor, as the comment's own schema does", () => {
    const fileId = "01929b8e-5c1a-7d3e-9f40-2b6c8d1e4a57";
    expect(
      mcpAddCommentInput.safeParse({
        fileId,
        body: "Agreed",
        parentId: fileId,
        anchor: { kind: "bar", from: { bar: 3, beat: 1 } },
      }).success,
    ).toBe(false);
    expect(mcpAddCommentInput.safeParse({ fileId, body: "  " }).success).toBe(false);
  });
});
