import { z } from "zod";
import { type PlayerTool, playerTool, playerTools } from "./roles.ts";

/**
 * Exceptions to the player tools (decision 258): for one person (a member or a guest) or one
 * of the project's groups, the tools they have in this project in place of their role's. A
 * guest's tools come from their reviews, so for a guest an exception only takes tools away.
 */

const tools = z.array(playerTool).max(playerTools.length);

/** A new exception: exactly one of a member, a guest or a group, and their tools. */
export const toolExceptionInput = z
  .object({
    userId: z.string().min(1).max(64).optional(),
    guestId: z.uuid().optional(),
    groupId: z.uuid().optional(),
    tools,
  })
  .strict()
  .refine((e) => [e.userId, e.guestId, e.groupId].filter((x) => x !== undefined).length === 1, {
    message: "Name one person or one group",
  })
  .transform((e) => ({ ...e, tools: [...new Set(e.tools)] }));
export type ToolExceptionInput = z.infer<typeof toolExceptionInput>;

/** Changing an exception's tools. */
export const toolExceptionUpdate = z
  .object({ tools })
  .strict()
  .transform((e) => ({ tools: [...new Set(e.tools)] }));

/** An exception as the project's settings list it. */
export interface ToolException {
  id: string;
  /** Whom it is for: a member, a guest or a group, by name. */
  kind: "member" | "guest" | "group";
  subjectId: string;
  name: string;
  tools: PlayerTool[];
}

const known = (list: readonly string[]) =>
  list.filter((t): t is PlayerTool => (playerTools as readonly string[]).includes(t));

/**
 * The tools someone has once a project's exceptions apply: their own exception where they
 * have one, else every tool any of their groups' exceptions gives, else what they had. For a
 * guest (`narrowOnly`), never a tool their reviews do not already give them.
 */
export function exceptedTools(
  base: ReadonlySet<PlayerTool>,
  own: readonly string[] | null,
  groups: readonly (readonly string[])[],
  narrowOnly = false,
): Set<PlayerTool> {
  const chosen = own
    ? known(own)
    : groups.length > 0
      ? playerTools.filter((t) => groups.some((g) => g.includes(t)))
      : null;
  if (!chosen) return new Set(base);
  return new Set(narrowOnly ? chosen.filter((t) => base.has(t)) : chosen);
}
