import { z } from "zod";

/** Organisation-level roles, highest first. Per-project roles are a separate model. */
export const organisationRoles = ["owner", "admin", "member"] as const;
export const organisationRole = z.enum(organisationRoles);
export type OrganisationRole = z.infer<typeof organisationRole>;

const rank: Record<OrganisationRole, number> = { owner: 3, admin: 2, member: 1 };

/** True when `role` is at least `required`. */
export function atLeast(role: OrganisationRole, required: OrganisationRole): boolean {
  return rank[role] >= rank[required];
}

export const inviteInput = z.object({
  email: z.email().max(254),
  role: organisationRole.default("member"),
});

export const acceptInvitationInput = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  password: z.string().min(12).max(256).optional(),
});

/** Choose the storage backend for an organisation's new objects; null uses the instance default. */
export const organisationStorageInput = z.object({
  backend: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,31}$/)
    .nullable(),
});

/** Rename a workspace (an organisation in code). */
export const organisationUpdateInput = z.object({
  name: z.string().trim().min(1).max(120),
});
export type OrganisationUpdateInput = z.infer<typeof organisationUpdateInput>;
