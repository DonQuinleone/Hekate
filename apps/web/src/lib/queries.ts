import {
  type Anchor,
  type CreateReviewInput,
  decodeLoudness,
  decodePeaks,
  decodeSpectrogram,
  type FileKind,
  type LoudnessSummary,
  type MediaInfo,
  type ProjectPermission,
  type ProjectProfile,
  type ReviewDecision,
  type ReviewerState,
  type ReviewKind,
} from "@hekate/shared";
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
  /** What the signed-in member may do here. Only on a single project; the server checks again. */
  permissions?: ProjectPermission[];
}

/** Whether the signed-in member may do something in a project, once it has loaded. */
export function useProjectCan(projectId: string | undefined) {
  const { data } = useQuery({ ...projectQuery(projectId ?? ""), enabled: Boolean(projectId) });
  return (permission: ProjectPermission) => Boolean(data?.permissions?.includes(permission));
}

export interface ProjectRole {
  id: string;
  name: string;
  permissions: ProjectPermission[];
  members: number;
}

export interface ProjectMember {
  userId: string;
  name: string;
  email: string;
  roleId: string;
}

export const projectRolesQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["projects", projectId, "roles"],
    queryFn: async () =>
      (
        await json<{ roles: ProjectRole[] }>(
          await api.projects[":id"].roles.$get({ param: { id: projectId } }),
        )
      ).roles,
  });

export const projectMembersQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["projects", projectId, "members"],
    queryFn: async () =>
      (
        await json<{ members: ProjectMember[] }>(
          await api.projects[":id"].members.$get({ param: { id: projectId } }),
        )
      ).members,
  });

export function useProjectAccessMutations(projectId: string) {
  const client = useQueryClient();
  // Roles and membership change what the project page offers, so refresh it all.
  const refresh = () => client.invalidateQueries({ queryKey: ["projects", projectId] });
  const ok = async (res: Response) => {
    if (!res.ok) await json(res);
  };
  return {
    createRole: useMutation({
      mutationFn: async (input: { name: string; permissions: ProjectPermission[] }) =>
        json<{ role: ProjectRole }>(
          await api.projects[":id"].roles.$post({ param: { id: projectId }, json: input }),
        ),
      onSuccess: refresh,
    }),
    updateRole: useMutation({
      // Each change sends the role's whole permission set, so changes run one at a time, in
      // the order they were made: a slow earlier request can never overwrite a later one.
      scope: { id: `project-roles-${projectId}` },
      mutationFn: async (input: { id: string; name: string; permissions: ProjectPermission[] }) =>
        json<{ role: ProjectRole }>(
          await api.projects[":id"].roles[":roleId"].$patch({
            param: { id: projectId, roleId: input.id },
            json: { name: input.name, permissions: input.permissions },
          }),
        ),
      // Show the change at once; the server's answer, or a refusal, replaces it.
      onMutate: async (input) => {
        const key = projectRolesQuery(projectId).queryKey;
        await client.cancelQueries({ queryKey: key });
        const before = client.getQueryData(key);
        client.setQueryData(key, (roles) =>
          roles?.map((role) =>
            role.id === input.id
              ? { ...role, name: input.name, permissions: input.permissions }
              : role,
          ),
        );
        return { before };
      },
      onError: (_error, _input, context) => {
        client.setQueryData(projectRolesQuery(projectId).queryKey, context?.before);
      },
      onSettled: refresh,
    }),
    deleteRole: useMutation({
      mutationFn: async (roleId: string) =>
        ok(
          await api.projects[":id"].roles[":roleId"].$delete({ param: { id: projectId, roleId } }),
        ),
      onSuccess: refresh,
    }),
    assign: useMutation({
      mutationFn: async (input: { userId: string; roleId: string }) =>
        ok(
          await api.projects[":id"].members[":userId"].$put({
            param: { id: projectId, userId: input.userId },
            json: { roleId: input.roleId },
          }),
        ),
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: async (userId: string) =>
        ok(
          await api.projects[":id"].members[":userId"].$delete({
            param: { id: projectId, userId },
          }),
        ),
      onSuccess: refresh,
    }),
  };
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
  analysisStatus: StreamStatus;
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
  /** Where the file sits in the music model, when it is a variation of a version. */
  variation: {
    id: string;
    name: string;
    isPrimary: boolean;
    versionId: string;
    versionNumber: number;
    trackId: string;
    trackName: string;
  } | null;
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

/** A file's loudness: the summary, and the shape of its series, once the worker has measured it. */
export const loudnessQuery = (fileId: string) =>
  queryOptions({
    queryKey: ["files", fileId, "loudness"],
    queryFn: async () =>
      json<{
        status: StreamStatus;
        summary: LoudnessSummary | null;
        series: {
          channels: number;
          sampleRate: number;
          samplesPerFrame: number;
          count: number;
        } | null;
      }>(await api.files[":id"].loudness.$get({ param: { id: fileId } })),
    refetchInterval: (query) => (query.state.data?.status === "pending" ? 3000 : false),
  });

/** Loudness and levels over time, decoded. They never change, so they are kept for the visit. */
export const loudnessSeriesQuery = (fileId: string) =>
  queryOptions({
    queryKey: ["files", fileId, "loudness", "series"],
    queryFn: async () => {
      const res = await api.files[":id"].loudness.series.$get({ param: { id: fileId } });
      if (!res.ok) await json(res);
      return decodeLoudness(new Uint8Array(await res.arrayBuffer()));
    },
    staleTime: Number.POSITIVE_INFINITY,
  });

export interface SpectrogramInfo {
  id: string;
  /** A channel index ("0", "1", …), or "mid" or "side". */
  channel: string;
  fftSize: number;
  sampleRate: number;
  samplesPerColumn: number;
  columns: number;
  bands: number;
}

/** A file's spectrograms, one per channel plus mid and side, once the worker has made them. */
export const spectrogramsQuery = (fileId: string) =>
  queryOptions({
    queryKey: ["files", fileId, "spectrograms"],
    queryFn: async () =>
      json<{ status: StreamStatus; spectrograms: SpectrogramInfo[] }>(
        await api.files[":id"].spectrograms.$get({ param: { id: fileId } }),
      ),
    refetchInterval: (query) => (query.state.data?.status === "pending" ? 3000 : false),
  });

/** One spectrogram, decoded. They never change, so they are kept for the visit. */
export const spectrogramQuery = (fileId: string, spectrogramId: string) =>
  queryOptions({
    queryKey: ["files", fileId, "spectrograms", spectrogramId],
    queryFn: async () => {
      const res = await api.files[":id"].spectrograms[":spectrogramId"].$get({
        param: { id: fileId, spectrogramId },
      });
      if (!res.ok) await json(res);
      return decodeSpectrogram(new Uint8Array(await res.arrayBuffer()));
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
  /** Written by a guest reviewer; their label (for example "Conductor") reads beside the name. */
  authorGuest: boolean;
  authorLabel: string | null;
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

export interface Variation {
  id: string;
  versionId: string;
  fileId: string;
  name: string;
  isPrimary: boolean;
  position: number;
  fileName: string;
  kind: FileKind;
  streamStatus: StreamStatus;
}

export interface Version {
  id: string;
  number: number;
  notes: string | null;
  createdAt: string;
  variations: Variation[];
}

export interface Track {
  id: string;
  projectId: string;
  name: string;
  scoreFileId: string | null;
  position: number;
  createdAt: string;
  versions: Version[];
}

export const projectTracksQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["projects", projectId, "tracks"],
    queryFn: async () =>
      (
        await json<{ tracks: Track[] }>(
          await api.projects[":id"].tracks.$get({ param: { id: projectId } }),
        )
      ).tracks,
  });

export const trackQuery = (trackId: string) =>
  queryOptions({
    queryKey: ["tracks", trackId],
    queryFn: async () =>
      (await json<{ track: Track }>(await api.tracks[":id"].$get({ param: { id: trackId } })))
        .track,
  });

export function useTrackMutations(projectId: string) {
  const client = useQueryClient();
  const refresh = (track?: Track) => {
    void client.invalidateQueries({ queryKey: ["projects", projectId, "tracks"] });
    if (track) client.setQueryData(trackQuery(track.id).queryKey, track);
    void client.invalidateQueries({ queryKey: ["files"] });
  };
  return {
    createTrack: useMutation({
      mutationFn: async (input: { name: string }) =>
        (
          await json<{ track: Track }>(
            await api.projects[":id"].tracks.$post({ param: { id: projectId }, json: input }),
          )
        ).track,
      onSuccess: refresh,
    }),
    createVersion: useMutation({
      mutationFn: async (input: {
        trackId: string;
        notes?: string;
        variations: { fileId: string; name: string; primary?: boolean }[];
      }) =>
        (
          await json<{ track: Track }>(
            await api.tracks[":id"].versions.$post({
              param: { id: input.trackId },
              json: { notes: input.notes, variations: input.variations },
            }),
          )
        ).track,
      onSuccess: refresh,
    }),
    makePrimary: useMutation({
      mutationFn: async (variationId: string) =>
        (
          await json<{ track: Track }>(
            await api.variations[":id"].primary.$post({ param: { id: variationId } }),
          )
        ).track,
      onSuccess: refresh,
    }),
  };
}

export interface ReviewSummary {
  id: string;
  kind: ReviewKind;
  title: string;
  status: "open" | "completed" | "cancelled";
  outcome: "approved" | "changes_requested" | "submitted" | null;
  dueAt: string | null;
  createdAt: string;
  reviewers: number;
  submitted: number;
  youReview: boolean;
}

export interface ReviewDetail {
  id: string;
  projectId: string;
  kind: ReviewKind;
  title: string;
  message: string | null;
  dueAt: string | null;
  order: "parallel" | "sequence";
  rule: "all" | "any" | null;
  status: ReviewSummary["status"];
  outcome: ReviewSummary["outcome"];
  createdByName: string | null;
  createdAt: string;
  completedAt: string | null;
  items: (
    | { id: string; kind: "file"; fileId: string; name: string; fileKind: string }
    | {
        id: string;
        kind: "track";
        trackId: string;
        name: string;
        follows: "version" | "latest";
        version: { id: string; number: number } | null;
        fileId: string | null;
      }
  )[];
  reviewers: {
    id: string;
    userId: string;
    name: string;
    state: ReviewerState;
    decision: ReviewDecision | null;
    decidedAt: string | null;
    submittedAt: string | null;
  }[];
  decisions: {
    id: string;
    reviewerId: string;
    reviewerName: string | null;
    decision: ReviewDecision;
    note: string | null;
    createdAt: string;
  }[];
  you: {
    reviewerId: string | null;
    active: boolean;
    canDecide: boolean;
    canSubmit: boolean;
    canManage: boolean;
  };
}

export const projectReviewsQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["projects", projectId, "reviews"],
    queryFn: async () =>
      (
        await json<{ reviews: ReviewSummary[] }>(
          await api.projects[":id"].reviews.$get({ param: { id: projectId } }),
        )
      ).reviews,
  });

export const reviewQuery = (id: string) =>
  queryOptions({
    queryKey: ["reviews", id],
    queryFn: async () =>
      (await json<{ review: ReviewDetail }>(await api.reviews[":id"].$get({ param: { id } })))
        .review,
    // Others decide while you look.
    refetchInterval: 15_000,
  });

export function useCreateReview(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateReviewInput) =>
      (
        await json<{ review: ReviewDetail }>(
          await api.projects[":id"].reviews.$post({ param: { id: projectId }, json: input }),
        )
      ).review,
    onSuccess: () => client.invalidateQueries({ queryKey: ["projects", projectId, "reviews"] }),
  });
}

export function useReviewActions(reviewId: string) {
  const client = useQueryClient();
  const settle = (review: ReviewDetail) => {
    client.setQueryData(reviewQuery(reviewId).queryKey, review);
    void client.invalidateQueries({ queryKey: ["projects", review.projectId, "reviews"] });
  };
  const call = async (res: Response) => (await json<{ review: ReviewDetail }>(res)).review;
  return {
    viewed: useMutation({
      mutationFn: async () =>
        call(await api.reviews[":id"].viewed.$post({ param: { id: reviewId } })),
      onSuccess: settle,
    }),
    decide: useMutation({
      mutationFn: async (input: { decision: ReviewDecision; note?: string }) =>
        call(await api.reviews[":id"].decisions.$post({ param: { id: reviewId }, json: input })),
      onSuccess: settle,
    }),
    submit: useMutation({
      mutationFn: async () =>
        call(await api.reviews[":id"].submit.$post({ param: { id: reviewId } })),
      onSuccess: settle,
    }),
    cancel: useMutation({
      mutationFn: async () =>
        call(await api.reviews[":id"].cancel.$post({ param: { id: reviewId } })),
      onSuccess: settle,
    }),
  };
}

export interface GuestMe {
  guest: { id: string; name: string; email: string; label: string | null };
  organisation: string | null;
  reviews: (Pick<
    ReviewSummary,
    "id" | "kind" | "title" | "status" | "outcome" | "dueAt" | "createdAt"
  > & {
    submittedAt: string | null;
  })[];
}

/** The signed-in guest reviewer, or null when this browser has no guest session. */
export const guestMeQuery = queryOptions({
  queryKey: ["guest", "me"],
  queryFn: async (): Promise<GuestMe | null> => {
    const res = await api.guest.me.$get();
    if (res.status === 401) return null;
    return json<GuestMe>(res);
  },
  staleTime: 60_000,
});

/** Exchange a magic link for a guest session in this browser. */
export function useGuestSignIn() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (token: string) =>
      json<Omit<GuestMe, "guest"> & { guest: { id: string } }>(
        await api.guest.sessions.$post({ json: { token } }),
      ),
    onSuccess: () => client.invalidateQueries({ queryKey: ["guest"] }),
  });
}

export function useGuestSignOut() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await api.guest["sign-out"].$post();
    },
    onSuccess: () => client.clear(),
  });
}
