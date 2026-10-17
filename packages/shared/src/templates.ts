import { z } from "zod";
import { categoryHandlings } from "./categories.ts";
import { profileRef } from "./qa.ts";
import { qaSettings } from "./qa-rules.ts";
import { projectPermission } from "./roles.ts";

/**
 * Project templates (#240): what a project is set up with, saved from one project to start
 * others from. Roles, comment categories, the delivery profile, QA rules and the checks on a
 * new version; never files, people, reviews or comments.
 */

export const templateName = z.string().trim().min(1, "Name the template").max(120);

/** Saving a project as a template. */
export const saveTemplateInput = z.object({ name: templateName });

/** What a template holds, as it is stored and read back. */
export const templateContent = z.object({
  settings: z.object({
    carriedCommentsShown: z.boolean(),
    deliveryProfile: profileRef.nullable(),
    checkTruePeak: z.boolean(),
    requireEdl: z.boolean(),
    qaSettings: qaSettings.nullable(),
  }),
  // No limits of their own: whatever a project may hold, its template holds.
  roles: z.array(z.object({ name: z.string().min(1), permissions: z.array(projectPermission) })),
  categories: z.array(
    z.object({
      name: z.string().min(1),
      handling: z.enum(categoryHandlings),
      stage: z.string().nullable(),
    }),
  ),
});
export type TemplateContent = z.infer<typeof templateContent>;

/** A template as the workspace lists it. */
export interface ProjectTemplate {
  id: string;
  name: string;
  /** Who saved it, and from which project, while they exist. */
  createdByName: string | null;
  fromProject: string | null;
  roles: string[];
  categories: number;
  /** Whether the viewer may remove it: whoever saved it, or a workspace admin. */
  removable: boolean;
  createdAt: string;
}
