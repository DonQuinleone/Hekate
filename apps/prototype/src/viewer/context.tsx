import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import {
  type Comment,
  type File,
  fileById,
  type Project,
  type ProjectPermission,
  projects,
  type Review,
  type Reviewer,
  reviews,
  type Tool,
  variationOf,
} from "~/data";
import { type Persona, type PersonaId, personaById } from "./personas.ts";

/** Prototype-only settings, beside the role: how the page is shown, and in which state. */
export type ScreenState =
  | "normal"
  | "empty"
  | "loading"
  | "processing"
  | "failed"
  | "refused"
  | "expired"
  | "long";
export type Width = "desktop" | "phone";

export interface Settings {
  shadows: boolean;
  width: Width;
  state: ScreenState;
}

const SETTINGS_KEY = "hekate.prototype.settings";
const PERSONA_KEY = "hekate.prototype.persona";

function remembered<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...(JSON.parse(raw) as T) } : fallback;
  } catch {
    return fallback;
  }
}

function remember(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Not kept; the choice still holds for this visit.
  }
}

export interface Viewer {
  persona: Persona;
  personId: string;
  isGuest: boolean;
  isInstance: boolean;
  settings: Settings;
  setPersona: (id: PersonaId) => void;
  setSettings: (patch: Partial<Settings>) => void;
  /** The projects this person can see at all. */
  projects: () => Project[];
  canSee: (projectId: string) => boolean;
  can: (projectId: string, permission: ProjectPermission) => boolean;
  /** The tools this person's role gives them in a project. */
  tools: (projectId: string) => Set<Tool>;
  /** The reviewer row for this person in a review, if they are in it. */
  reviewerIn: (review: Review) => Reviewer | undefined;
  /** The reviews this person may open. */
  reviews: () => Review[];
  /** What this person may do on a file: through their role, or the widest review that grants it. */
  fileAccess: (fileId: string) => FileAccess | null;
  roleName: (projectId: string) => string | null;
}

export interface FileAccess {
  /** The review the access comes through, when it is not the project role. */
  review: Review | null;
  reviewer: Reviewer | null;
  tools: Set<Tool>;
  comment: boolean;
  decide: boolean;
  comments: "all" | "own_and_replies" | "own";
  history: boolean;
  download: "none" | "proxy" | "original";
  triage: boolean;
}

const ViewerContext = createContext<Viewer | null>(null);

export function ViewerProvider({ children }: { children: ReactNode }) {
  const [personaId, setPersonaId] = useState<PersonaId>(
    () => remembered(PERSONA_KEY, { id: "owner" as PersonaId }).id,
  );
  const [settings, setSettingsState] = useState<Settings>(() =>
    remembered(SETTINGS_KEY, { shadows: true, width: "desktop", state: "normal" }),
  );
  const persona = personaById(personaId);

  const setPersona = useCallback((id: PersonaId) => {
    setPersonaId(id);
    remember(PERSONA_KEY, { id });
  }, []);
  const setSettings = useCallback((patch: Partial<Settings>) => {
    setSettingsState((s) => {
      const next = { ...s, ...patch };
      remember(SETTINGS_KEY, next);
      return next;
    });
  }, []);

  const viewer = useMemo<Viewer>(() => {
    const isGuest = persona.kind === "guest";
    const isInstance = persona.kind === "instance";
    const roleIn = (project: Project) => {
      if (isGuest || isInstance) return null;
      const override = persona.projectRoles[project.id];
      const roleId =
        override === undefined
          ? project.members.find((m) => m.personId === persona.personId)?.roleId
          : override;
      return roleId ? (project.roles.find((r) => r.id === roleId) ?? null) : null;
    };
    const elevated = persona.organisationRole === "owner" || persona.organisationRole === "admin";
    const canSee = (projectId: string) => {
      const project = projects.find((p) => p.id === projectId);
      if (!project || isGuest || isInstance) return false;
      if (elevated) return true;
      return roleIn(project)?.permissions.includes("view") ?? false;
    };
    const can = (projectId: string, permission: ProjectPermission) => {
      const project = projects.find((p) => p.id === projectId);
      if (!project || !canSee(projectId)) return false;
      if (elevated) return true;
      return roleIn(project)?.permissions.includes(permission) ?? false;
    };
    const tools = (projectId: string): Set<Tool> => {
      const project = projects.find((p) => p.id === projectId);
      if (!project || !canSee(projectId)) return new Set();
      if (elevated) return new Set(project.roles.find((r) => r.id === "r-producer")?.tools ?? []);
      return new Set(roleIn(project)?.tools ?? []);
    };
    const reviewerIn = (review: Review) => {
      const row = review.reviewers.find((r) => r.personId === persona.personId);
      if (!row) return undefined;
      // A member persona is never a guest row, and the guest persona is only the guest row.
      return row;
    };
    const myReviews = () =>
      reviews.filter((r) => {
        if (isInstance) return false;
        if (isGuest)
          return (
            r.reviewers.some((x) => x.personId === persona.personId) && r.status !== "cancelled"
          );
        return canSee(r.projectId) || r.reviewers.some((x) => x.personId === persona.personId);
      });
    const fileAccess = (fileId: string): FileAccess | null => {
      const file = fileById(fileId);
      if (!file) return null;
      const viaRole = canSee(file.projectId);
      const variation = variationOf(fileId);
      const grants = myReviews().filter(
        (r) =>
          r.status !== "cancelled" &&
          r.items.some(
            (i) => i.fileId === fileId || (variation && i.trackId === variation.track.id),
          ) &&
          reviewerIn(r)?.state !== "waiting",
      );
      if (!viaRole && grants.length === 0) return null;
      if (viaRole) {
        const t = tools(file.projectId);
        return {
          review: null,
          reviewer: null,
          tools: t,
          comment: can(file.projectId, "comment"),
          decide: can(file.projectId, "decide"),
          comments: "all",
          history: true,
          download: t.has("download") ? "original" : "none",
          triage: can(file.projectId, "triage"),
        };
      }
      // The widest of the reviews that reach the file.
      const rows = grants.map((r) => ({ review: r, reviewer: reviewerIn(r) as Reviewer }));
      const widest = rows.reduce((a, b) =>
        b.reviewer.permissions.tools.length > a.reviewer.permissions.tools.length ? b : a,
      );
      const t = new Set<Tool>();
      for (const row of rows) for (const x of row.reviewer.permissions.tools) t.add(x);
      const scope = rows.some((r) => r.reviewer.permissions.comments === "all")
        ? "all"
        : rows.some((r) => r.reviewer.permissions.comments === "own_and_replies")
          ? "own_and_replies"
          : "own";
      return {
        review: widest.review,
        reviewer: widest.reviewer,
        tools: t,
        comment: rows.some((r) => r.reviewer.permissions.comment),
        decide: rows.some((r) => r.reviewer.permissions.decide && r.review.kind === "approval"),
        comments: scope,
        history: rows.some((r) => r.reviewer.permissions.history),
        download: rows.some((r) => r.reviewer.permissions.download === "original")
          ? "original"
          : rows.some((r) => r.reviewer.permissions.download === "proxy")
            ? "proxy"
            : "none",
        triage: false,
      };
    };
    return {
      persona,
      personId: persona.personId,
      isGuest,
      isInstance,
      settings,
      setPersona,
      setSettings,
      projects: () => projects.filter((p) => canSee(p.id) && !p.archived),
      canSee,
      can,
      tools,
      reviewerIn,
      reviews: myReviews,
      fileAccess,
      roleName: (projectId) => {
        const project = projects.find((p) => p.id === projectId);
        if (!project) return null;
        if (elevated) return persona.organisationRole === "owner" ? "Owner" : "Admin";
        return roleIn(project)?.name ?? null;
      },
    };
  }, [persona, settings, setPersona, setSettings]);

  return <ViewerContext.Provider value={viewer}>{children}</ViewerContext.Provider>;
}

export function useViewer(): Viewer {
  const v = useContext(ViewerContext);
  if (!v) throw new Error("No ViewerProvider");
  return v;
}

/** Which comments this person sees on a file, by the scope their access grants. */
export function visibleComments(all: Comment[], access: FileAccess, personId: string): Comment[] {
  if (access.comments === "all") return all;
  const mine = new Set(all.filter((c) => c.authorId === personId).map((c) => c.id));
  return all.filter((c) => {
    if (c.authorId === personId) return true;
    if (access.comments === "own_and_replies" && c.parentId && mine.has(c.parentId)) return true;
    return false;
  });
}

export const isMedia = (file: File) => file.kind === "audio" || file.kind === "video";
