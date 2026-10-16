import {
  type AlignmentPoints,
  type Anchor,
  type CarryStatus,
  type CreateProjectInput,
  type CreateReviewInput,
  type DeliveryProfileId,
  decodeLoudness,
  decodePeaks,
  decodeSpectrogram,
  type FileColumnLayout,
  type FileKind,
  type GroupInput,
  type GuestInput,
  type LoudnessSummary,
  type Mark,
  type MarkInput,
  type MediaInfo,
  type NotificationKind,
  type NotificationPreferences,
  narrowed,
  type OverviewSection,
  type ProjectPermission,
  type ProjectProfile,
  type QaFinding,
  type ReviewDecision,
  type ReviewerPermissions,
  type ReviewerPermissionsChange,
  type ReviewerState,
  type ReviewKind,
  type SavedSearchInput,
  type SearchRequest,
  searchResponse,
  type TrackState,
  type UpdateCarryInput,
} from "@hekate/shared";
import {
  infiniteQueryOptions,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
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
  queryFn: async () =>
    (await json<{ projects: Project[] }>(await api.projects.$get({ query: {} }))).projects,
});

/** The projects page: those in use or those archived, each with what its card shows. */
export const projectCardsQuery = (archived: boolean) =>
  queryOptions({
    queryKey: ["projects", "cards", archived],
    queryFn: async () =>
      (
        await json<{ projects: ProjectWithFigures[] }>(
          await api.projects.$get({
            query: { figures: "1", ...(archived ? { archived: "1" } : {}) },
          }),
        )
      ).projects,
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
  description: string | null;
  createdAt: string;
  archivedAt: string | null;
  /** What the signed-in member may do here. Only on a single project; the server checks again. */
  permissions?: ProjectPermission[];
  /** Whether they may archive or unarchive it (on a single project, and in the list). */
  mayArchive?: boolean;
  /** In the list: whether they are a member of it. */
  mine?: boolean;
}

/** What a project's card shows beside its name. */
export interface ProjectFigures {
  files: number;
  tracks: number;
  /** Tracks with at least one version, and of those, how many are approved at their latest. */
  versionedTracks: number;
  approvedTracks: number;
  openComments: number;
  openReviews: number;
  members: number;
  faces: { id: string; name: string }[];
}

export interface ProjectWithFigures extends Project {
  mine: boolean;
  mayArchive: boolean;
  figures: ProjectFigures & { lastActiveAt: string };
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
    mutationFn: async (input: CreateProjectInput) =>
      (await json<{ project: Project }>(await api.projects.$post({ json: input }))).project,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["projects"] });
      void client.invalidateQueries({ queryKey: homeQuery.queryKey });
    },
  });
}

/** Archive a project (its open reviews close), or unarchive one. */
export function useArchiveProject() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, archive }: { id: string; archive: boolean }) => {
      const res = await (archive
        ? api.projects[":id"].archive.$post({ param: { id } })
        : api.projects[":id"].unarchive.$post({ param: { id } }));
      if (!res.ok) await json(res);
    },
    onSuccess: () => {
      // Lists, the sidebar, the home page and every review list may change.
      void client.invalidateQueries();
    },
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

/** Rename the workspace; only owners may. */
export function useRenameWorkspace() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) =>
      json<{ organisation: { id: string; name: string } }>(
        await api.organisation.$patch({ json: { name } }),
      ),
    onSuccess: () => client.invalidateQueries({ queryKey: meQuery.queryKey }),
  });
}

export interface WorkspaceStorage {
  /** The workspace's choice; null follows the instance default. */
  backend: string | null;
  defaultBackend: string;
  available: string[];
}

export const workspaceStorageQuery = queryOptions({
  queryKey: ["organisation", "storage"],
  queryFn: async () => json<WorkspaceStorage>(await api.organisation.storage.$get()),
});

export function useWorkspaceStorage() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (backend: string | null) =>
      json(await api.organisation.storage.$put({ json: { backend } })),
    onSuccess: () => client.invalidateQueries({ queryKey: workspaceStorageQuery.queryKey }),
  });
}

/** A guest of the workspace: someone outside it who reviews through links. */
export interface WorkspaceGuest {
  id: string;
  name: string;
  email: string;
  label: string | null;
  lastLinkAt: string | null;
  /** A link or a signed-in browser still works for them. */
  live: boolean;
}

export const workspaceGuestsQuery = queryOptions({
  queryKey: ["organisation", "guests"],
  queryFn: async () =>
    (await json<{ guests: WorkspaceGuest[] }>(await api.organisation.guests.$get())).guests,
});

/** End every link and signed-in browser a guest has. */
export function useRevokeGuest() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await api.organisation.guests[":id"].revoke.$post({ param: { id } });
      if (!res.ok) await json(res);
    },
    onSuccess: () => client.invalidateQueries({ queryKey: workspaceGuestsQuery.queryKey }),
  });
}

/** One line of the access log, as the API returns it. */
export interface AccessEvent {
  id: string;
  occurredAt: string;
  action: string;
  actorType: "member" | "guest" | "system";
  userId: string | null;
  actorLabel: string;
  projectId: string | null;
  fileId: string | null;
  reviewId: string | null;
  /** What the entry touched, by name; null once it has been deleted. */
  fileName: string | null;
  reviewTitle: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  details: Record<string, unknown> | null;
}

export interface AccessLogFilters {
  action?: string;
  projectId?: string;
}

/** The access log, newest first, a page at a time. */
export const accessLogQuery = (filters: AccessLogFilters) =>
  infiniteQueryOptions({
    queryKey: ["organisation", "audit", filters],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const query: Record<string, string> = { limit: "50" };
      if (filters.action) query.action = filters.action;
      if (filters.projectId) query.projectId = filters.projectId;
      if (pageParam) query.before = pageParam;
      return json<{ events: AccessEvent[]; nextBefore: string | null }>(
        await api.organisation.audit.$get({ query }),
      );
    },
    getNextPageParam: (page) => page.nextBefore ?? undefined,
  });

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
  /** A document's pages, drawn or not; null for anything without pages. */
  pageCount?: number | null;
  uploadedBy: string | null;
  uploadedById?: string | null;
  createdAt: string;
  /** Threads on it not yet resolved (in a project's file list). */
  openComments?: number;
  /** The workspace tags on it (in a project's file list). */
  tagIds?: string[];
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
    /** The track's score, when one is linked. */
    scoreFileId: string | null;
  } | null;
  /** The project's profile: it decides which tools the page offers, bars among them. */
  profile: ProjectProfile;
  /** For a guest, what their reviews let them do with this file; null for members. */
  grant: Pick<ReviewerPermissions, "comment" | "comments" | "tools"> | null;
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

/** One page of a document or picture as the server drew it, behind a session-bound link. */
export interface ViewPage {
  page: number;
  width: number;
  height: number;
  url: string;
  thumbUrl: string;
}

export interface DocumentView {
  expiresAt: string;
  /** Pages in the document; more than `pages` when only the first ones were drawn. */
  pageCount: number;
  pages: ViewPage[];
}

/** Links to a document's pages, bound to this browser's session; asked for again when they lapse. */
export const viewQuery = (fileId: string) =>
  queryOptions({
    queryKey: ["files", fileId, "view"],
    queryFn: async () =>
      json<DocumentView>(await api.files[":id"].view.$post({ param: { id: fileId } })),
    staleTime: 3 * 60 * 60 * 1000,
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
  /** Set on a thread carried here from an earlier version; its anchor is then the mapped one. */
  carry: CommentCarry | null;
  /** On a thread: where it began, and each version it was carried to. */
  history: CommentHistory | null;
}

export interface CommentCarry {
  id: string;
  status: CarryStatus;
  /** Shown on this version; hidden ones reach only those who triage. */
  visible: boolean;
  /** The file it was raised on, and where it pointed there. */
  from: { fileId: string; anchor: Anchor | null };
}

export interface CommentHistory {
  /** The version it was raised on, when that file is a variation. */
  versionNumber: number | null;
  hops: { fileId: string; versionNumber: number; status: CarryStatus }[];
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
    /** Triage on a carried thread; its status shows on every version, so all refresh. */
    carry: useMutation({
      mutationFn: async ({ id, ...change }: { id: string } & UpdateCarryInput) => {
        const res = await api["comment-carries"][":id"].$patch({ param: { id }, json: change });
        if (!res.ok) await json(res);
      },
      onSuccess: () =>
        client.invalidateQueries({
          predicate: (q) => q.queryKey[0] === "files" && q.queryKey[2] === "comments",
        }),
    }),
  };
}

/** A recording's quality checks (#41), against its project's delivery profile. */
export interface QaReport {
  status: StreamStatus;
  profile: { id: DeliveryProfileId; label: string; chosen: boolean };
  findings: QaFinding[];
}

export const qaQuery = (fileId: string) =>
  queryOptions({
    queryKey: ["files", fileId, "qa"],
    queryFn: async () => json<QaReport>(await api.files[":id"].qa.$get({ param: { id: fileId } })),
    staleTime: 60_000,
    // The signal checks arrive with the analysis: ask again until it has finished.
    refetchInterval: (query) => (query.state.data?.status === "pending" ? 3000 : false),
  });

/** Choose what a project's recordings are checked against; every file's report follows. */
export function useDeliveryProfile(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (deliveryProfile: DeliveryProfileId | null) =>
      json(
        await api.projects[":id"].$patch({ param: { id: projectId }, json: { deliveryProfile } }),
      ),
    onSuccess: () =>
      client.invalidateQueries({
        predicate: (q) => q.queryKey[0] === "files" && q.queryKey[2] === "qa",
      }),
  });
}

/** Another file aligned with this one: where the same music sits there, from this file's times. */
export interface FileAlignment {
  fileId: string;
  points: AlignmentPoints;
  quality: number;
}

export const alignmentsQuery = (fileId: string) =>
  queryOptions({
    queryKey: ["files", fileId, "alignments"],
    queryFn: async () =>
      (
        await json<{ alignments: FileAlignment[] }>(
          await api.files[":id"].alignments.$get({ param: { id: fileId } }),
        )
      ).alignments,
    staleTime: 60_000,
  });

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
  /** The folder it sits in, like any folder; null is the top of the project. */
  folderId: string | null;
  position: number;
  createdAt: string;
  versions: Version[];
  /** In a project's track list: where it stands, and who it waits on while in review. */
  state?: TrackState;
  waitingOn?: OverviewPerson[];
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
      mutationFn: async (input: { name: string; folderId?: string | null }) =>
        (
          await json<{ track: Track }>(
            await api.projects[":id"].tracks.$post({ param: { id: projectId }, json: input }),
          )
        ).track,
      onSuccess: refresh,
    }),
    updateTrack: useMutation({
      mutationFn: async ({
        id,
        ...input
      }: {
        id: string;
        name?: string;
        folderId?: string | null;
        scoreFileId?: string | null;
      }) =>
        (
          await json<{ track: Track }>(
            await api.tracks[":id"].$patch({ param: { id }, json: input }),
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
    addVariation: useMutation({
      mutationFn: async (input: { versionId: string; fileId: string; name: string }) =>
        (
          await json<{ track: Track }>(
            await api.versions[":id"].variations.$post({
              param: { id: input.versionId },
              json: { fileId: input.fileId, name: input.name },
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
    /** Null for a guest. */
    userId: string | null;
    name: string;
    guest: boolean;
    /** A guest's role on the production, such as "Conductor". */
    label: string | null;
    /** Shown to members only; guests never see other reviewers' addresses. */
    email: string | null;
    /** The group they were asked through, if any. */
    group: { id: string; name: string | null } | null;
    /** Their step in the order: a group's members share one. */
    step: number;
    state: ReviewerState;
    decision: ReviewDecision | null;
    decidedAt: string | null;
    submittedAt: string | null;
    /** For those who manage reviewers, and for the reviewer themselves; otherwise null. */
    permissions: ReviewerPermissions | null;
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
    canManageReviewers: boolean;
    guest: boolean;
    /** What you may do here, when you are a reviewer of it. */
    permissions: ReviewerPermissions | null;
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
    // Whose turn it is changes with every response: the inbox and its count follow.
    void client.invalidateQueries({ queryKey: myReviewsQuery.queryKey });
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
    addReviewer: useMutation({
      mutationFn: async (input: { userId: string } | { groupId: string } | GuestInput) =>
        call(await api.reviews[":id"].reviewers.$post({ param: { id: reviewId }, json: input })),
      onSuccess: settle,
    }),
    /** Send a guest a fresh magic link; the last one stops working. */
    sendLink: useMutation({
      mutationFn: async (reviewerId: string) => {
        const res = await api.reviews[":id"].reviewers[":reviewerId"].link.$post({
          param: { id: reviewId, reviewerId },
        });
        if (!res.ok) await json(res);
      },
    }),
    /** Change what one reviewer may do in this review. */
    permissions: useMutation({
      mutationFn: async (input: { reviewerId: string; permissions: ReviewerPermissionsChange }) =>
        call(
          await api.reviews[":id"].reviewers[":reviewerId"].$patch({
            param: { id: reviewId, reviewerId: input.reviewerId },
            json: { permissions: input.permissions },
          }),
        ),
      onSuccess: settle,
    }),
    /** End a guest's links and signed-in browsers. */
    revoke: useMutation({
      mutationFn: async (reviewerId: string) => {
        const res = await api.reviews[":id"].reviewers[":reviewerId"].revoke.$post({
          param: { id: reviewId, reviewerId },
        });
        if (!res.ok) await json(res);
      },
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
    /** Their access window on it, and whether it is open now. */
    opensAt: string | null;
    closesAt: string | null;
    accessOpen: boolean;
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

export interface ProjectGroup {
  id: string;
  name: string;
  members: {
    userId: string | null;
    guestId: string | null;
    name: string;
    email: string;
    label: string | null;
    guest: boolean;
  }[];
}

/** A project's groups of reviewers, for example "Soloists". */
export const projectGroupsQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["projects", projectId, "groups"],
    queryFn: async () =>
      (
        await json<{ groups: ProjectGroup[] }>(
          await api.projects[":id"].groups.$get({ param: { id: projectId } }),
        )
      ).groups,
  });

export function useGroupMutations(projectId: string) {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: ["projects", projectId, "groups"] });
  return {
    create: useMutation({
      mutationFn: async (input: GroupInput) =>
        json(await api.projects[":id"].groups.$post({ param: { id: projectId }, json: input })),
      onSuccess: refresh,
    }),
    update: useMutation({
      mutationFn: async ({ groupId, ...input }: GroupInput & { groupId: string }) =>
        json(
          await api.projects[":id"].groups[":groupId"].$put({
            param: { id: projectId, groupId },
            json: input,
          }),
        ),
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: async (groupId: string) => {
        const res = await api.projects[":id"].groups[":groupId"].$delete({
          param: { id: projectId, groupId },
        });
        if (!res.ok) await json(res);
      },
      onSuccess: refresh,
    }),
  };
}

export interface Folder {
  id: string;
  parentId: string | null;
  name: string;
}

/** A project's folders, every level. */
export const projectFoldersQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["projects", projectId, "folders"],
    queryFn: async () =>
      (
        await json<{ folders: Folder[] }>(
          await api.projects[":id"].folders.$get({ param: { id: projectId } }),
        )
      ).folders,
  });

/** Making, renaming, moving and deleting folders and files. */
export function useOrganise(projectId: string) {
  const client = useQueryClient();
  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: ["projects", projectId, "folders"] }),
      client.invalidateQueries({ queryKey: ["projects", projectId, "files"] }),
      // Deleting a folder moves its tracks up, like its files.
      client.invalidateQueries({ queryKey: ["projects", projectId, "tracks"] }),
    ]);
  return {
    createFolder: useMutation({
      mutationFn: async (input: { name: string; parentId: string | null }) =>
        (
          await json<{ folder: Folder }>(
            await api.projects[":id"].folders.$post({ param: { id: projectId }, json: input }),
          )
        ).folder,
      onSuccess: refresh,
    }),
    updateFolder: useMutation({
      mutationFn: async ({
        id,
        ...input
      }: {
        id: string;
        name?: string;
        parentId?: string | null;
      }) => json(await api.folders[":id"].$patch({ param: { id }, json: input })),
      onSuccess: refresh,
    }),
    deleteFolder: useMutation({
      mutationFn: async (id: string) =>
        json<{ moved: number }>(await api.folders[":id"].$delete({ param: { id } })),
      onSuccess: refresh,
    }),
    updateFile: useMutation({
      mutationFn: async ({
        id,
        ...input
      }: {
        id: string;
        name?: string;
        folderId?: string | null;
        scoreFileId?: string | null;
      }) => json(await api.files[":id"].$patch({ param: { id }, json: input })),
      onSuccess: refresh,
    }),
    deleteFile: useMutation({
      mutationFn: async (id: string) => {
        const res = await api.files[":id"].$delete({ param: { id } });
        if (!res.ok) await json(res);
      },
      onSuccess: refresh,
    }),
  };
}

export interface MyReview {
  id: string;
  projectId: string;
  projectName: string;
  kind: ReviewKind;
  title: string;
  status: ReviewSummary["status"];
  outcome: ReviewSummary["outcome"];
  dueAt: string | null;
  createdAt: string;
  submittedAt: string | null;
  /** It is this member's turn to approve or give feedback. */
  yourTurn: boolean;
}

/** The reviews the signed-in member takes part in, open first: the sidebar's inbox. */
export const myReviewsQuery = queryOptions({
  queryKey: ["reviews", "mine"],
  queryFn: async () => (await json<{ reviews: MyReview[] }>(await api.reviews.$get())).reviews,
  refetchInterval: 60_000,
});

/** A project as the home page shows it: its figures and a few of its people. */
export interface HomeProject extends ProjectFigures {
  id: string;
  name: string;
  profile: ProjectProfile;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

type HomeWho = { id: string; name: string } | null;
export type HomeActivity =
  | {
      kind: "comment";
      id: string;
      at: string;
      who: HomeWho;
      projectId: string;
      fileId: string;
      fileName: string;
      /** Comments in a row by the same person on the same file. */
      count: number;
    }
  | {
      kind: "version";
      id: string;
      at: string;
      who: HomeWho;
      projectId: string;
      trackId: string;
      trackName: string;
      number: number;
    }
  | {
      kind: "review";
      id: string;
      at: string;
      who: HomeWho;
      projectId: string;
      reviewId: string;
      title: string;
    }
  | {
      kind: "review_completed";
      id: string;
      at: string;
      who: null;
      projectId: string;
      reviewId: string;
      title: string;
      outcome: string | null;
    };

export interface Home {
  projects: HomeProject[];
  openComments: number;
  newVersions: number;
  failed: { id: string; name: string; projectId: string }[];
  activity: HomeActivity[];
}

/** The home page's figures across the projects the member can see. */
export const homeQuery = queryOptions({
  queryKey: ["home"],
  queryFn: async () => json<Home>(await api.home.$get()),
  refetchInterval: 60_000,
});

export interface AppNotification {
  id: string;
  kind: NotificationKind;
  actorName: string | null;
  actorUserId: string | null;
  actorGuestId: string | null;
  text: string;
  link: string;
  readAt: string | null;
  createdAt: string;
}

type NotificationPage = {
  notifications: AppNotification[];
  unread: number;
  nextBefore: string | null;
};

/** The latest notifications and how many are unread: the bell. */
export const notificationsQuery = queryOptions({
  queryKey: ["notifications", "latest"],
  queryFn: async () =>
    json<NotificationPage>(await api.notifications.$get({ query: { limit: "8" } })),
  refetchInterval: 30_000,
});

/** Every notification, newest first, a page at a time. */
export const allNotificationsQuery = infiniteQueryOptions({
  queryKey: ["notifications", "all"],
  initialPageParam: undefined as string | undefined,
  queryFn: async ({ pageParam }) =>
    json<NotificationPage>(
      await api.notifications.$get({
        query: { limit: "40", ...(pageParam ? { before: pageParam } : {}) },
      }),
    ),
  getNextPageParam: (page) => page.nextBefore ?? undefined,
});

export function useNotificationActions() {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: ["notifications"] });
  return {
    read: useMutation({
      mutationFn: async (id: string) => {
        const res = await api.notifications[":id"].read.$post({ param: { id } });
        if (!res.ok) await json(res);
      },
      onSuccess: refresh,
    }),
    readAll: useMutation({
      mutationFn: async () => {
        const res = await api.notifications["read-all"].$post();
        if (!res.ok) await json(res);
      },
      onSuccess: refresh,
    }),
  };
}

export const notificationPreferencesQuery = queryOptions({
  queryKey: ["notifications", "preferences"],
  queryFn: async () =>
    (
      await json<{ preferences: NotificationPreferences }>(
        await api.notifications.preferences.$get(),
      )
    ).preferences,
});

export function useSaveNotificationPreferences() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (preferences: NotificationPreferences) =>
      (
        await json<{ preferences: NotificationPreferences }>(
          await api.notifications.preferences.$put({ json: preferences }),
        )
      ).preferences,
    onMutate: async (preferences) => {
      const key = notificationPreferencesQuery.queryKey;
      await client.cancelQueries({ queryKey: key });
      const before = client.getQueryData(key);
      client.setQueryData(key, preferences);
      return { before };
    },
    onError: (_error, _input, context) =>
      client.setQueryData(notificationPreferencesQuery.queryKey, context?.before),
    onSettled: () => client.invalidateQueries({ queryKey: notificationPreferencesQuery.queryKey }),
  });
}

export interface Follow {
  id: string;
  trackId: string | null;
  reviewId: string | null;
  name: string;
  projectId: string;
  projectName: string;
}

export const followsQuery = queryOptions({
  queryKey: ["notifications", "follows"],
  queryFn: async () =>
    (await json<{ follows: Follow[] }>(await api.notifications.follows.$get())).follows,
});

export function useUnfollow() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await api.notifications.follows[":id"].$delete({ param: { id } });
      if (!res.ok) await json(res);
    },
    onSuccess: () => client.invalidateQueries({ queryKey: followsQuery.queryKey }),
  });
}

export interface OverviewPerson {
  id: string;
  name: string;
}

/** A project's first page, as `GET /api/projects/:id/overview` sends it. */
export interface ProjectOverview {
  figures: {
    tracks: number;
    versionedTracks: number;
    approvedTracks: number;
    files: number;
    openReviews: number;
    nextDueAt: string | null;
    /** Null for those who do not triage. */
    openComments: number | null;
    processing: number;
    members: number;
    faces: OverviewPerson[];
  };
  failed: { id: string; name: string }[];
  qaFailing: { id: string; name: string; summary: string }[];
  overdue: { id: string; title: string; dueAt: string | null; waitingOn: OverviewPerson[] }[];
  tracks: {
    id: string;
    name: string;
    version: { number: number; createdAt: string; fileId: string | null } | null;
    state: TrackState;
    waitingOn: OverviewPerson[];
  }[];
  activity: HomeActivity[];
  deliveryProfile: string | null;
  createdAt: string | null;
  role: string | null;
  layout: OverviewSection[] | null;
}

export const projectOverviewQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["projects", projectId, "overview"],
    queryFn: async () =>
      json<ProjectOverview>(await api.projects[":id"].overview.$get({ param: { id: projectId } })),
  });

/** Keep someone's arrangement of a project's overview. */
export function useOverviewLayout(projectId: string) {
  const client = useQueryClient();
  const key = projectOverviewQuery(projectId).queryKey;
  return useMutation({
    mutationFn: async (sections: OverviewSection[]) => {
      const res = await api.projects[":id"].overview.layout.$put({
        param: { id: projectId },
        json: { sections },
      });
      if (!res.ok) await json(res);
    },
    // The page shows the new order at once; a failure puts the old one back.
    onMutate: async (sections) => {
      await client.cancelQueries({ queryKey: key });
      const before = client.getQueryData(key);
      client.setQueryData(key, (o) => (o ? { ...o, layout: sections } : o));
      return { before };
    },
    onError: (_e, _s, ctx) => client.setQueryData(key, ctx?.before),
  });
}

/** What matches a search's words and filters, across everything the member may see. */
export const searchQuery = (search: SearchRequest) =>
  queryOptions({
    queryKey: ["search", search],
    queryFn: async () => {
      const { q, ...filters } = search;
      // Only the filters that are set reach the address.
      const query = Object.fromEntries(Object.entries({ q, ...filters }).filter(([, v]) => v));
      // Read through the shared schema, so a change to the contract shows here at once.
      return searchResponse.parse(await json(await api.search.$get({ query }))).results;
    },
    enabled: search.q.trim().length > 0 || narrowed(search),
    staleTime: 30_000,
  });

export interface SavedSearch {
  id: string;
  name: string;
  search: SearchRequest;
}

export const savedSearchesQuery = queryOptions({
  queryKey: ["search", "saved"],
  queryFn: async () => (await json<{ saved: SavedSearch[] }>(await api.search.saved.$get())).saved,
});

export function useSavedSearchMutations() {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: savedSearchesQuery.queryKey });
  const save = useMutation({
    mutationFn: async (input: SavedSearchInput) =>
      (await json<{ saved: SavedSearch }>(await api.search.saved.$post({ json: input }))).saved,
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: async (id: string) => {
      const res = await api.search.saved[":id"].$delete({ param: { id } });
      if (!res.ok) await json(res);
    },
    onSuccess: refresh,
  });
  return { save, remove };
}

export interface Tag {
  id: string;
  name: string;
  /** How many files carry it, across the workspace. */
  files: number;
}

export const tagsQuery = queryOptions({
  queryKey: ["tags"],
  queryFn: async () => (await json<{ tags: Tag[] }>(await api.tags.$get())).tags,
  staleTime: 60_000,
});

/** Make a workspace tag, and set the tags on a file. */
export function useTagMutations(projectId: string) {
  const client = useQueryClient();
  const create = useMutation({
    mutationFn: async (name: string) =>
      (await json<{ tag: Tag }>(await api.tags.$post({ json: { name } }))).tag,
    onSuccess: () => client.invalidateQueries({ queryKey: tagsQuery.queryKey }),
  });
  const setOnFile = useMutation({
    mutationFn: async ({ fileId, tagIds }: { fileId: string; tagIds: string[] }) => {
      const res = await api.files[":id"].tags.$put({ param: { id: fileId }, json: { tagIds } });
      if (!res.ok) await json(res);
    },
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: projectFilesQuery(projectId).queryKey }),
        client.invalidateQueries({ queryKey: tagsQuery.queryKey }),
      ]),
  });
  return { create, setOnFile };
}

export const projectMarksQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["projects", projectId, "marks"],
    queryFn: async () =>
      (
        await json<{ marks: Mark[] }>(
          await api.projects[":id"].marks.$get({ param: { id: projectId } }),
        )
      ).marks,
  });

/** Pin, keep as a favourite, or mark as seen: shown at once, put back if refused. */
export function useMarks(projectId: string) {
  const client = useQueryClient();
  const key = projectMarksQuery(projectId).queryKey;
  return useMutation({
    mutationFn: async (input: MarkInput) => {
      const res = await api.projects[":id"].marks.$post({ param: { id: projectId }, json: input });
      if (!res.ok) await json(res);
    },
    onMutate: async (input) => {
      await client.cancelQueries({ queryKey: key });
      const before = client.getQueryData(key);
      client.setQueryData(key, (marks = []) => {
        const next = [...marks];
        for (const item of input.items) {
          const at = next.findIndex((m) => m.kind === item.kind && m.id === item.id);
          const was = next[at] ?? { ...item, pinned: false, favourite: false, viewed: false };
          const mark = {
            ...was,
            pinned: input.pinned ?? was.pinned,
            favourite: input.favourite ?? was.favourite,
            viewed: input.viewed ?? was.viewed,
          };
          if (at >= 0) next[at] = mark;
          else next.push(mark);
        }
        return next;
      });
      return { before };
    },
    onError: (_e, _i, ctx) => client.setQueryData(key, ctx?.before),
    onSettled: () => client.invalidateQueries({ queryKey: key }),
  });
}

/** The file browser's columns as the member arranged them here; null for the default. */
export const fileColumnsQuery = queryOptions({
  queryKey: ["me", "file-columns"],
  queryFn: async () =>
    (await json<{ columns: FileColumnLayout | null }>(await api.me["file-columns"].$get())).columns,
  staleTime: Number.POSITIVE_INFINITY,
});

/** Keep a new arrangement of columns: shown at once, put back if refused. */
export function useFileColumns() {
  const client = useQueryClient();
  const key = fileColumnsQuery.queryKey;
  return useMutation({
    mutationFn: async (columns: FileColumnLayout) => {
      const res = await api.me["file-columns"].$put({ json: { columns } });
      if (!res.ok) await json(res);
    },
    onMutate: async (columns) => {
      await client.cancelQueries({ queryKey: key });
      const before = client.getQueryData(key);
      client.setQueryData(key, columns);
      return { before };
    },
    onError: (_e, _c, ctx) => client.setQueryData(key, ctx?.before),
  });
}

/** Prepare a file again after its preparation failed. */
export function useRetryFile(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (fileId: string) => {
      const res = await api.files[":id"].retry.$post({ param: { id: fileId } });
      if (!res.ok) await json(res);
    },
    onSuccess: () => client.invalidateQueries({ queryKey: projectFilesQuery(projectId).queryKey }),
  });
}
