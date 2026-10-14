import {
  type Anchor,
  decodePeaks,
  type FileKind,
  type MediaInfo,
  type ProjectProfile,
} from "@hekate/shared";
import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export const healthQuery = queryOptions({
  queryKey: ["health"],
  queryFn: async () => {
    const res = await api.health.$get();
    return (await res.json()) as {
      status: "ok" | "degraded";
      version: string;
      database: "ok" | "unreachable";
    };
  },
  refetchInterval: 30_000,
});

export interface Me {
  user: { id: string; name: string; email: string };
  organisations: { id: string; name: string; role: "owner" | "admin" | "member" }[];
  activeOrganisationId: string;
}

/** The signed-in member, or null when signed out. */
export const meQuery = queryOptions({
  queryKey: ["me"],
  queryFn: async (): Promise<Me | null> => {
    const res = await api.me.$get();
    if (res.status === 401) return null;
    return json<Me>(res);
  },
  staleTime: 60_000,
});

export const setupQuery = queryOptions({
  queryKey: ["setup"],
  queryFn: async () => (await json<{ needed: boolean }>(await api.setup.$get())).needed,
  staleTime: Number.POSITIVE_INFINITY,
});

export const projectsQuery = queryOptions({
  queryKey: ["projects"],
  queryFn: async () => (await json<{ projects: Project[] }>(await api.projects.$get())).projects,
});

export const projectQuery = (id: string) =>
  queryOptions({
    queryKey: ["projects", id],
    queryFn: async () =>
      (await json<{ project: Project }>(await api.projects[":id"].$get({ param: { id } }))).project,
  });

export interface Project {
  id: string;
  name: string;
  profile: ProjectProfile;
  createdAt: string;
}

export function useCreateProject() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { name: string; profile: ProjectProfile }) =>
      (await json<{ project: Project }>(await api.projects.$post({ json: input }))).project,
    onSuccess: () => client.invalidateQueries({ queryKey: ["projects"] }),
  });
}

export interface Member {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: "owner" | "admin" | "member";
  joinedAt: string;
}
export interface PendingInvitation {
  id: string;
  email: string;
  role: "owner" | "admin" | "member";
  expiresAt: string;
}

export const membersQuery = queryOptions({
  queryKey: ["organisation", "members"],
  queryFn: async () =>
    (await json<{ members: Member[] }>(await api.organisation.members.$get())).members,
});

export const invitationsQuery = queryOptions({
  queryKey: ["organisation", "invitations"],
  queryFn: async () =>
    (await json<{ invitations: PendingInvitation[] }>(await api.organisation.invitations.$get()))
      .invitations,
});

export function useOrganisationMutations() {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: ["organisation"] });
  return {
    invite: useMutation({
      mutationFn: async (input: { email: string; role: Member["role"] }) =>
        json<{ link: string }>(await api.organisation.invitations.$post({ json: input })),
      onSuccess: refresh,
    }),
    revoke: useMutation({
      mutationFn: async (id: string) => {
        const res = await api.organisation.invitations[":id"].$delete({ param: { id } });
        if (!res.ok) await json(res);
      },
      onSuccess: refresh,
    }),
    setRole: useMutation({
      mutationFn: async (input: { id: string; role: Member["role"] }) =>
        json(
          await api.organisation.members[":id"].$patch({
            param: { id: input.id },
            json: { role: input.role },
          }),
        ),
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: async (id: string) => {
        const res = await api.organisation.members[":id"].$delete({ param: { id } });
        if (!res.ok) await json(res);
      },
      onSuccess: refresh,
    }),
  };
}

export function useSwitchOrganisation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (organisationId: string) =>
      json(await api.me.organisation.$put({ json: { organisationId } })),
    onSuccess: () => client.invalidateQueries(),
  });
}

export interface ProjectFile {
  id: string;
  folderId: string | null;
  name: string;
  kind: FileKind;
  contentType: string;
  byteSize: number;
  mediaInfo: MediaInfo | null;
  /** Playable proxies: prepared in the background after the file is measured. */
  streamStatus: StreamStatus;
  /** Waveform peaks: computed in the background for files with audio. */
  peaksStatus: StreamStatus;
  uploadedBy: string | null;
  createdAt: string;
}

export type StreamStatus = "none" | "pending" | "ready" | "failed";

/** Still being measured or prepared for playback, so worth asking again shortly. */
export const settling = (f: ProjectFile) =>
  f.streamStatus === "pending" ||
  ((f.kind === "audio" || f.kind === "video") &&
    f.mediaInfo === null &&
    f.streamStatus !== "failed");

export const projectFilesQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["projects", projectId, "files"],
    queryFn: async () =>
      (
        await json<{ files: ProjectFile[] }>(
          await api.projects[":id"].files.$get({ param: { id: projectId } }),
        )
      ).files,
    refetchInterval: (query) => (query.state.data?.some(settling) ? 3000 : false),
  });

export interface FileDetail extends ProjectFile {
  projectId: string;
}

export const fileQuery = (fileId: string) =>
  queryOptions({
    queryKey: ["files", fileId],
    queryFn: async () =>
      (await json<{ file: FileDetail }>(await api.files[":id"].$get({ param: { id: fileId } })))
        .file,
    refetchInterval: (query) => (query.state.data && settling(query.state.data) ? 3000 : false),
  });

export interface Rendition {
  id: string;
  name: string;
  codecs: string;
  bandwidth: number;
  width: number | null;
  height: number | null;
}

export interface Playback {
  /** The master playlist, valid only with this sign-in session. */
  url: string;
  expiresAt: string;
  renditions: Rendition[];
}

/**
 * A playback link for one viewing. Every start is logged, so the link is fetched once per
 * visit and never shared between components or kept after the page closes.
 */
export const playbackQuery = (fileId: string) =>
  queryOptions({
    queryKey: ["files", fileId, "playback"],
    queryFn: async () =>
      json<Playback>(await api.files[":id"].playback.$post({ param: { id: fileId } })),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    retry: false,
  });

export interface PeakLevelInfo {
  id: string;
  samplesPerPeak: number;
  count: number;
  channels: number;
  sampleRate: number;
}

/** The zoom levels of a file's waveform peaks, once the worker has computed them. */
export const peaksQuery = (fileId: string) =>
  queryOptions({
    queryKey: ["files", fileId, "peaks"],
    queryFn: async () =>
      json<{ status: StreamStatus; levels: PeakLevelInfo[] }>(
        await api.files[":id"].peaks.$get({ param: { id: fileId } }),
      ),
    refetchInterval: (query) => (query.state.data?.status === "pending" ? 3000 : false),
  });

/** One level of peaks, decoded. Levels never change, so they are kept for the visit. */
export const peakLevelQuery = (fileId: string, levelId: string) =>
  queryOptions({
    queryKey: ["files", fileId, "peaks", levelId],
    queryFn: async () => {
      const res = await api.files[":id"].peaks[":levelId"].$get({
        param: { id: fileId, levelId },
      });
      if (!res.ok) await json(res);
      return decodePeaks(new Uint8Array(await res.arrayBuffer()));
    },
    staleTime: Number.POSITIVE_INFINITY,
  });

export interface Comment {
  id: string;
  fileId: string;
  parentId: string | null;
  anchor: Anchor | null;
  body: string;
  authorId: string | null;
  authorName: string | null;
  resolvedAt: string | null;
  resolvedByName: string | null;
  editedAt: string | null;
  createdAt: string;
}

/** A file's comments, oldest first; kept fresh so colleagues' notes appear while reviewing. */
export const commentsQuery = (fileId: string) =>
  queryOptions({
    queryKey: ["files", fileId, "comments"],
    queryFn: async () =>
      (
        await json<{ comments: Comment[] }>(
          await api.files[":id"].comments.$get({ param: { id: fileId } }),
        )
      ).comments,
    refetchInterval: 15_000,
  });

export function useCommentMutations(fileId: string) {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: ["files", fileId, "comments"] });
  return {
    create: useMutation({
      mutationFn: async (input: { body: string; anchor?: Anchor | null; parentId?: string }) =>
        json<{ comment: Comment }>(
          await api.files[":id"].comments.$post({ param: { id: fileId }, json: input }),
        ),
      onSuccess: refresh,
    }),
    edit: useMutation({
      mutationFn: async (input: { id: string; body: string }) =>
        json<{ comment: Comment }>(
          await api.comments[":id"].$patch({ param: { id: input.id }, json: { body: input.body } }),
        ),
      onSuccess: refresh,
    }),
    resolve: useMutation({
      mutationFn: async (input: { id: string; resolved: boolean }) =>
        json<{ comment: Comment }>(
          await api.comments[":id"].resolve.$post({
            param: { id: input.id },
            json: { resolved: input.resolved },
          }),
        ),
      onSuccess: refresh,
    }),
  };
}
