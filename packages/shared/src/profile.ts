import { z } from "zod";
import type { AnchorKind } from "./anchor.ts";

/** A project's profile decides which tools and anchors appear. The data model is shared. */
export const projectProfile = z.enum(["music", "video", "general"]);
export type ProjectProfile = z.infer<typeof projectProfile>;

export type Tool = "waveform" | "score" | "bar-ruler" | "filmstrip" | "timecode" | "draw" | "pages";

export interface ProfileDefinition {
  label: string;
  anchors: readonly AnchorKind[];
  tools: readonly Tool[];
  /** What a version is called in this profile. */
  versionNoun: string;
}

export const profiles: Record<ProjectProfile, ProfileDefinition> = {
  music: {
    label: "Music",
    anchors: ["bar", "time", "region", "section"],
    tools: ["waveform", "score", "bar-ruler", "pages"],
    versionNoun: "take",
  },
  video: {
    label: "Video",
    anchors: ["time", "region"],
    tools: ["filmstrip", "timecode", "waveform", "draw"],
    versionNoun: "version",
  },
  general: {
    label: "General",
    anchors: ["time", "region"],
    tools: ["pages", "waveform", "draw"],
    versionNoun: "version",
  },
};

export function allowsAnchor(profile: ProjectProfile, kind: AnchorKind): boolean {
  return profiles[profile].anchors.includes(kind);
}
