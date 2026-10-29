import { z } from "zod";
import type { AnchorKind } from "./anchor.ts";
import { assetPolicy } from "./asset-policy.ts";
import { commentAssignment } from "./comment-assignment.ts";
import { normalisationMode } from "./normalisation.ts";
import { workflowNotices } from "./notifications.ts";
import { profileRef } from "./qa.ts";
import { qaSettings } from "./qa-rules.ts";
import { commentReferences } from "./references.ts";
import { watermarkSettings } from "./watermark.ts";

/**
 * A project's profile decides which tools and anchors appear. Any kind of file can live in any
 * project, and the data model (folders, files, tracks, versions, variants, takes) is shared.
 */
export const projectProfile = z.enum(["music", "video", "general"]);
export type ProjectProfile = z.infer<typeof projectProfile>;

export type Tool = "waveform" | "score" | "bar-ruler" | "filmstrip" | "timecode" | "draw" | "pages";

export interface ProfileDefinition {
  label: string;
  anchors: readonly AnchorKind[];
  tools: readonly Tool[];
}

export const profiles: Record<ProjectProfile, ProfileDefinition> = {
  music: {
    label: "Music",
    anchors: ["bar", "time", "region"],
    tools: ["waveform", "score", "bar-ruler", "pages"],
  },
  video: {
    label: "Video",
    anchors: ["time", "region"],
    tools: ["filmstrip", "timecode", "waveform", "draw"],
  },
  general: {
    label: "General",
    anchors: ["time", "region"],
    tools: ["pages", "waveform", "draw"],
  },
};

export function allowsAnchor(profile: ProjectProfile, kind: AnchorKind): boolean {
  return profiles[profile].anchors.includes(kind);
}

/** A line saying what a project is, for the project list. */
const projectDescription = z.string().trim().max(300);

/**
 * A new project: its name and profile, a line about it, and optionally a template: another
 * project whose settings and roles are copied (never its content).
 */
export const createProjectInput = z
  .object({
    name: z.string().trim().min(1).max(120),
    profile: projectProfile,
    description: projectDescription.optional(),
    /** Another project to copy roles and settings from. */
    templateId: z.uuid().optional(),
    /** Or a saved template (#240). */
    savedTemplateId: z.uuid().optional(),
  })
  .strict()
  .refine((p) => !(p.templateId && p.savedTemplateId), {
    message: "Start from a project or a template, not both",
    path: ["savedTemplateId"],
  });
export type CreateProjectInput = z.infer<typeof createProjectInput>;

/** Which projects the list shows: those in use, or those archived; with their figures or not. */
export const projectListQuery = z.object({
  archived: z.enum(["1"]).optional(),
  figures: z.enum(["1"]).optional(),
});

/** A project's settings: its own, for those who edit the project; its checks, for those who edit its workflow. */
export const updateProjectInput = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: projectDescription.nullable().optional(),
    /** Only decides which tools appear; files of any kind stay welcome. */
    profile: projectProfile.optional(),
    /** Whether threads carried to a new version show there until someone hides them. */
    carriedCommentsShown: z.boolean().optional(),
    /** What recordings are checked against; null suggests one from each file's channels. */
    deliveryProfile: profileRef.nullable().optional(),
    /** Refuse a new version whose audio peaks over the delivery profile's ceiling. */
    checkTruePeak: z.boolean().optional(),
    /** Refuse a new version without an edit decision list. */
    requireEdl: z.boolean().optional(),
    /** Its QA rules, as a whole (#144). */
    qaSettings: qaSettings.optional(),
    /** What reviewers may type beside a comment: pages, bars, beats (#240). */
    references: commentReferences.optional(),
    /** Whether recordings play at their delivery target's loudness (#240). */
    normalisation: normalisationMode.optional(),
    /** The visible watermark: whom it marks, where and how strongly (#31). */
    watermark: watermarkSettings.optional(),
    /** Downloads and deletion, and whether downloads carry the inaudible mark (decision 257). */
    assetPolicy: assetPolicy.optional(),
    /** Who the workflow tells, and how (decision 259). */
    workflowNotices: workflowNotices.optional(),
    /** Whom a new comment is for, unless a track or a stage says otherwise (decision 279). */
    commentAssignment: commentAssignment.nullable().optional(),
  })
  .refine(
    (u) =>
      u.name !== undefined ||
      u.description !== undefined ||
      u.profile !== undefined ||
      u.carriedCommentsShown !== undefined ||
      u.deliveryProfile !== undefined ||
      u.checkTruePeak !== undefined ||
      u.requireEdl !== undefined ||
      u.qaSettings !== undefined ||
      u.references !== undefined ||
      u.normalisation !== undefined ||
      u.watermark !== undefined ||
      u.assetPolicy !== undefined ||
      u.workflowNotices !== undefined ||
      u.commentAssignment !== undefined,
    { message: "Nothing to change" },
  );
export type UpdateProjectInput = z.infer<typeof updateProjectInput>;
