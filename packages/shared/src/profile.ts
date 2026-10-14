import { z } from "zod";
import type { AnchorKind } from "./anchor.ts";

/**
 * A project's profile decides which tools and anchors appear. Any kind of file can live in any
 * project, and the data model (folders, files, tracks, versions, variations, takes) is shared.
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

/** A project's settings, changed by those who shape its workflow. */
export const updateProjectInput = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    /** Whether threads carried to a new version show there until someone hides them. */
    carriedCommentsShown: z.boolean().optional(),
  })
  .refine((u) => u.name !== undefined || u.carriedCommentsShown !== undefined, {
    message: "Nothing to change",
  });
export type UpdateProjectInput = z.infer<typeof updateProjectInput>;
