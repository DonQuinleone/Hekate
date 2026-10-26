import {
  type AccessLevels,
  type AlignmentPoints,
  type Anchor,
  type ApprovalRule,
  analysisKey,
  type BillingCredit,
  type BillingGatewayStatus,
  type BillingOverview,
  type BillingReports,
  type Board,
  type BoardDisplay,
  type CalendarEvent,
  type CaptionFormat,
  type CaptionKind,
  type CaptionTrack,
  type CaptionUpdate,
  type CarryStatus,
  type CategoryHandling,
  type CategoryInput,
  type ChannelRow,
  type CommentAttachment,
  type CommentMention,
  type CommentReferences,
  type CompareAlignment,
  type CreateChannelInput,
  type CreateProjectInput,
  type CreateReviewInput,
  type CreateUploadRequestInput,
  type CreateVersionInput,
  type CreditInput,
  type CustomProfile,
  type CustomProfileInput,
  type DeletionConfirmation,
  type DirectorySettings,
  type DirectorySettingsInput,
  type DownloadKind,
  type DownloadLevel,
  decodeLoudness,
  decodePeaks,
  decodeSpectrogram,
  defaultAnalysis,
  defaultPreferences,
  type EditDecisions,
  type EditPlot,
  type EdlRate,
  type EmailTemplateId,
  type ErrorReport,
  type ErrorReportRow,
  type FileColumnLayout,
  type FileInspection,
  type FileKind,
  type FollowInput,
  type ForensicStatus,
  type GroupInput,
  type GuestInput,
  type HealthRange,
  type ImportMarkersInput,
  type InspectKind,
  type InstanceAccess,
  type InstanceEnvironment,
  type InstanceFlag,
  type InstanceMemberRow,
  type InstanceNotice,
  type InstanceOverview,
  type Plan as InstancePlan,
  type InstanceProjectRow,
  type InstanceSender,
  type InstanceSettings,
  type InstanceWorkspaceDetail,
  type InstanceWorkspaceKeys,
  type InstanceWorkspacePage,
  type InstanceWorkspaceSettings,
  type InstanceWorkspaceStorage,
  isDefaultAnalysis,
  itemWords,
  type LinkablePerson,
  type LogKind,
  type LogPage,
  type LogRange,
  type LoudnessSummary,
  type MailSuppression,
  type Mark,
  type MarkInput,
  type MediaInfo,
  type Normalisation,
  type NormalisationMode,
  type NotificationKind,
  type NotificationPreferences,
  narrowed,
  type OperatorRow,
  type OverviewSection,
  type PatchedChannel,
  type PatchRowChange,
  type PatchRowInput,
  type Personnel,
  type PersonnelInput,
  type PlanInput,
  type PlayerTool,
  type Preferences,
  type PrintedBar,
  type ProfileInput,
  type ProfileRef,
  type ProfileSource,
  type ProjectDeletion,
  type ProjectPermission,
  type ProjectProfile,
  type ProjectStatus,
  type ProjectTemplate,
  type ProjectTransfer,
  type PromoCode,
  type PromoCodeInput,
  type PublicBranding,
  permissionsOfLevels,
  type QaFinding,
  type QaSettings,
  type QueueJobDetail,
  type QueuesView,
  type ReviewDecision,
  type ReviewerPermissions,
  type ReviewerPermissionsChange,
  type ReviewerState,
  type ReviewInspection,
  type ReviewKind,
  type SavedSearchInput,
  type ScheduleDay,
  type ScheduleDayInput,
  type ScheduleRowInput,
  type ScoreMark,
  type ScoreMarkCategory,
  type ScoreMarkChange,
  type ScoreMarkInput,
  type SearchRequest,
  type SessionChange,
  type SessionDetail,
  type SessionInput,
  type SessionInspection,
  type SessionSummary,
  type SessionTodoChange,
  type SharedTake,
  type SignUpInfo,
  type SignUpInvitation,
  type SpectrogramAnalysis,
  type SsoServiceProvider,
  type SsoSettings,
  type SsoSettingsInput,
  type StageBox,
  type StageEdit,
  type StageItem,
  type StagePerson,
  type StagePlan,
  type StagePlanInput,
  type StandingGrant,
  type StartTake,
  type StoredBranding,
  type SupportModule,
  type SystemHealth,
  type SystemInformation,
  searchResponse,
  type TakeChange,
  type TakeDetail,
  type TakeImport,
  type TakeRow,
  type TaskChange,
  type TaskDetail,
  type TaskInput,
  type TaskSummary,
  type TraceResult,
  type TrackState,
  type TransferConfirmation,
  type TransferDestination,
  type TransferRequestInput,
  type TriageInput,
  type UnderlayInput,
  type UpdateCarryInput,
  type UpdateChannelInput,
  type UpdateProjectInput,
  type UpdateVariationInput,
  type UploadRequestState,
  type Venue,
  type VenueInput,
  versionLabel,
  type WatermarkPosition,
  type WatermarkSettings,
  type Work,
  type WorkflowChange,
  type WorkflowInput,
  type WorkflowRunInspection,
  type WorkflowStanding,
  type WorkflowStatus,
  type WorkflowSummary,
  type WorkInput,
  type WorkspaceBilling,
  type WorkspaceLimits,
  type WorkspaceMail,
  type WorkspaceMailInput,
  type WorkspaceOperations,
  type WorkspacePlan,
  type WorkspaceSettings,
  type WorkspaceSettingsInput,
  type WorkspaceState,
  type WorkspaceUsage,
} from "@hekate/shared";
import {
  infiniteQueryOptions,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { notMemberAddress } from "./hosts";
import { outboxStore } from "./outbox-store";
import { baseOf, outcomeOf, type PendingWrite, rolledAt } from "./take-outbox";
import { uuidv7 } from "./uuidv7";

/** The member's session is gone: it ran out, or was ended elsewhere. */
export class SignedOutError extends Error {}
/** The workspace asks for a second factor this member has not added yet. */
export class SecondFactorDueError extends Error {}
/** The workspace signs its members in only through its single sign-on. */
export class SsoRequiredError extends Error {}
/** The workspace does not take the way this session was signed in (decision 248). */
export class SignInMethodRefusedError extends Error {}
/** The instance's operators have suspended the workspace (#174). */
export class WorkspaceSuspendedError extends Error {}
/** A refusal with the server's code for it, for pages that answer each refusal differently. */
export class ApiError extends Error {
  readonly code: string | undefined;
  /** A failure's reference (#159), which the message asks them to quote. */
  readonly reference: string | undefined;
  constructor(message: string, code?: string, reference?: string) {
    super(message);
    this.code = code;
    this.reference = reference;
  }
}

/** A failure's message, with the reference to quote when it has one. */
export const quoting = (message: string, reference?: string) =>
  reference
    ? `${message.endsWith(".") ? message.slice(0, -1) : message}. Quote ${reference} to support.`
    : message;

export async function json<T>(res: Response): Promise<T> {
  if (res.status === 401) throw new SignedOutError("Your session has ended. Sign in again.");
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: { code?: string; message?: string; reference?: string };
    } | null;
    const reference = body?.error?.reference;
    const message = quoting(body?.error?.message ?? `Request failed (${res.status})`, reference);
    if (body?.error?.code === "second_factor_required") throw new SecondFactorDueError(message);
    if (body?.error?.code === "sso_required") throw new SsoRequiredError(message);
    if (body?.error?.code === "sign_in_method_refused") throw new SignInMethodRefusedError(message);
    if (body?.error?.code === "workspace_suspended") throw new WorkspaceSuspendedError(message);
    throw new ApiError(message, body?.error?.code, reference);
  }
  // Done, with nothing to say.
  if (res.status === 204) return undefined as T;
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
  user: {
    id: string;
    name: string;
    email: string;
    emailVerified?: boolean;
    locale?: string | null;
    timeZone?: string | null;
    preferences?: Preferences;
  };
  organisations: {
    id: string;
    name: string;
    /** Its address, which someone moving a project here gives (#240). */
    address: string;
    role: "owner" | "admin" | "member";
    /** The workspace's language, for members without their own. */
    locale?: string | null;
    /**
     * Suspended, and why: nobody gets in until it is reinstated. `payable` when billing
     * suspended it for a payment overdue (#178): its owners may still pay. `deleteAfter` when
     * its owners are deleting it (#186): they may keep it, or export it, until that day.
     */
    suspended?: { reason: string | null; payable?: boolean; deleteAfter?: string | null } | null;
    /** Where it answers, with workspace subdomains on (#176). */
    url?: string | null;
  }[];
  activeOrganisationId: string;
  /** The root's address, which keeps the instance's pages, with workspace subdomains on. */
  root?: string | null;
  /** The billing module is on (#178): the workspace's Billing settings show. */
  billing?: boolean;
  /** How the instance answers support (#181): the help menu and the Support page follow it. */
  support?: SupportModule;
  /**
   * Whether they have a code app and how many passkeys, what this workspace asks of a sign-in
   * (a second factor; a hardware security key), whether this sign-in met it, and recovery codes left.
   */
  secondFactor: {
    enabled: boolean;
    passkeys: number;
    required: boolean;
    securityKey: boolean;
    met: boolean;
    recoveryCodesLeft: number;
  };
}

/** The signed-in member, or null when signed out. */
export const meQuery = queryOptions({
  queryKey: ["me"],
  queryFn: async (): Promise<Me | null> => {
    const res = await api.me.$get();
    if (res.status === 401) return null;
    if (res.status === 403) {
      const body = (await res
        .clone()
        .json()
        .catch(() => null)) as { error?: { code?: string } } | null;
      // Signed in, but on another workspace's host (#176): go to the root, which sends them on
      // to their own.
      if (body?.error?.code === "not_member_here") {
        const { root } = await json<SignInMethods>(await api["sign-in-methods"].$get());
        if (root)
          return leaveFor(notMemberAddress(root, window.location.pathname, window.location.search));
      }
    }
    return json<Me>(res);
  },
  staleTime: 60_000,
});

/** Whether the server is still being installed: it then serves the installer and nothing else. */
export const installQuery = queryOptions({
  queryKey: ["install"],
  queryFn: async () => (await json<{ installing: boolean }>(await api.install.$get())).installing,
  staleTime: Number.POSITIVE_INFINITY,
});

export const setupQuery = queryOptions({
  queryKey: ["setup"],
  queryFn: async () => (await json<{ needed: boolean }>(await api.setup.$get())).needed,
  staleTime: Number.POSITIVE_INFINITY,
});

/** What the sign-in page offers, and on a workspace's own host (#176), which workspace it is. */
export interface SignInMethods {
  directory: boolean;
  sso: boolean;
  /** The workspace this host answers for: the page need not ask which. */
  workspace: {
    name: string;
    slug: string;
    providerId: string | null;
    /** Its logo and accent (#185), on its sign-in page. */
    branding: PublicBranding | null;
  } | null;
  /** The root's address, with workspace subdomains on. */
  root: string | null;
  /** Open sign-up (#184): anyone may make a workspace, from the root's sign-in. */
  signUp?: boolean;
}

export const signInMethodsQuery = queryOptions({
  queryKey: ["sign-in-methods"],
  queryFn: async () => json<SignInMethods>(await api["sign-in-methods"].$get()),
  staleTime: 5 * 60_000,
});

/** What the sign-up page offers (#184): the instance's registration, and the trial. */
export const signUpInfoQuery = queryOptions({
  queryKey: ["sign-up"],
  queryFn: async () => json<SignUpInfo>(await api["sign-up"].$get()),
  staleTime: 60_000,
});

/** Operators' invitations to make a workspace, still waiting (#184). */
export const signUpInvitationsQuery = queryOptions({
  queryKey: ["instance", "sign-up-invitations"],
  queryFn: async () =>
    (
      await json<{ invitations: SignUpInvitation[] }>(
        await api.instance["sign-up-invitations"].$get(),
      )
    ).invitations,
});

/** Go to another of the instance's addresses: nothing here settles meanwhile. */
export function leaveFor(address: string): Promise<never> {
  window.location.replace(address);
  return new Promise<never>(() => {});
}

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
  /** The player tools their role has on (#240). Only on a single project. */
  tools?: PlayerTool[];
  /** What deliveries are checked against; null suggests one from each file's channels. */
  deliveryProfile?: ProfileRef | null;
  /** The checks a new version must pass before it lands. */
  checkTruePeak?: boolean;
  requireEdl?: boolean;
  /** Whether threads carried to a new version show there until someone hides them. */
  carriedCommentsShown?: boolean;
  /** Its QA rules (#144); null keeps the defaults. */
  qaSettings?: QaSettings | null;
  /** What reviewers may type beside a comment (#240), the profile's until it chooses. */
  references?: CommentReferences;
  /** Whether recordings play at their delivery target's loudness (#240). */
  normalisation?: NormalisationMode;
  /** The visible watermark: whom it marks, where and how strongly (#31). */
  watermark?: WatermarkSettings;
  /** A deletion waiting for a second owner (#240); only on a single project. */
  deletion?: ProjectDeletion | null;
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
/** Whether the signed-in member's role has a player tool on in a project (#240). */
export function useProjectTool(projectId: string | undefined) {
  const { data } = useQuery({ ...projectQuery(projectId ?? ""), enabled: Boolean(projectId) });
  return (tool: PlayerTool) => Boolean(data?.tools?.includes(tool));
}

/** What the project calls its tracks, versions and variations (#16): deliverables, cuts and renditions in video. */
export function useItemWords(projectId: string | undefined) {
  const { data } = useQuery({ ...projectQuery(projectId ?? ""), enabled: Boolean(projectId) });
  return {
    words: itemWords(data?.profile),
    versionLabel: (n: number) => versionLabel(n, data?.profile),
    video: data?.profile === "video",
  };
}

export function useProjectCan(projectId: string | undefined) {
  const { data } = useQuery({ ...projectQuery(projectId ?? ""), enabled: Boolean(projectId) });
  return (permission: ProjectPermission) => Boolean(data?.permissions?.includes(permission));
}

export interface ProjectRole {
  id: string;
  name: string;
  permissions: ProjectPermission[];
  /** The same, as people choose it: a level in each area. */
  levels: AccessLevels;
  /** Its player tools (#240). */
  tools: PlayerTool[];
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
      mutationFn: async (input: { name: string; levels: AccessLevels; tools?: PlayerTool[] }) =>
        json<{ role: ProjectRole }>(
          await api.projects[":id"].roles.$post({ param: { id: projectId }, json: input }),
        ),
      onSuccess: refresh,
    }),
    updateRole: useMutation({
      // Each change sends the role's every level, so changes run one at a time, in
      // the order they were made: a slow earlier request can never overwrite a later one.
      scope: { id: `project-roles-${projectId}` },
      mutationFn: async (input: {
        id: string;
        name: string;
        levels: AccessLevels;
        tools?: PlayerTool[];
      }) =>
        json<{ role: ProjectRole }>(
          await api.projects[":id"].roles[":roleId"].$patch({
            param: { id: projectId, roleId: input.id },
            json: { name: input.name, levels: input.levels, tools: input.tools },
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
              ? {
                  ...role,
                  name: input.name,
                  levels: input.levels,
                  permissions: permissionsOfLevels(input.levels),
                  tools: input.tools ?? role.tools,
                }
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

/** Change a project's settings; its page, the lists and the sidebar follow. */
export function useUpdateProject(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (change: UpdateProjectInput) =>
      (
        await json<{ project: Project }>(
          await api.projects[":id"].$patch({ param: { id: projectId }, json: change }),
        )
      ).project,
    onSuccess: (project, change) => {
      client.setQueryData(projectQuery(projectId).queryKey, (before) =>
        before ? { ...before, ...project, permissions: before.permissions } : before,
      );
      void client.invalidateQueries({ queryKey: ["projects"] });
      // Every file's report follows the delivery profile and the project's QA rules.
      if (change.deliveryProfile !== undefined || change.qaSettings !== undefined)
        void client.invalidateQueries({
          predicate: (q) => q.queryKey[0] === "files" && q.queryKey[2] === "qa",
        });
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

/** Deleting a project (#240): asking, withdrawing, and a second owner's confirmation. */
export function useProjectDeletion(projectId: string) {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: projectQuery(projectId).queryKey });
  const ok = async (res: Response) => {
    if (!res.ok) await json(res);
  };
  return {
    request: useMutation({
      mutationFn: async () =>
        ok(await api.projects[":id"].deletion.$post({ param: { id: projectId } })),
      onSuccess: refresh,
    }),
    cancel: useMutation({
      mutationFn: async () =>
        ok(await api.projects[":id"].deletion.$delete({ param: { id: projectId } })),
      onSuccess: refresh,
    }),
    confirm: useMutation({
      mutationFn: async () =>
        ok(await api.projects[":id"].deletion.confirm.$post({ param: { id: projectId } })),
      // Archived now: lists, the sidebar, the home page and every review list change.
      onSuccess: () => void client.invalidateQueries(),
    }),
  };
}

/** The transfer waiting on a project, for its danger zone (#240). */
export const projectTransferQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["projects", projectId, "transfer"],
    queryFn: async () =>
      (
        await json<{ transfer: ProjectTransfer | null }>(
          await api.projects[":id"].transfer.$get({ param: { id: projectId } }),
        )
      ).transfer,
  });

/** Where this person may ask to move a project: their other workspaces (#240). */
export const transferDestinationsQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["projects", projectId, "transfer", "destinations"],
    queryFn: async () =>
      (
        await json<{ destinations: TransferDestination[] }>(
          await api.projects[":id"].transfer.destinations.$get({ param: { id: projectId } }),
        )
      ).destinations,
  });

/** The transfers naming the workspace, waiting first (#240). */
export const transfersQuery = queryOptions({
  queryKey: ["transfers"],
  queryFn: async () =>
    (await json<{ transfers: ProjectTransfer[] }>(await api.transfers.$get())).transfers,
});

/**
 * Moving a project between workspaces (#240): asking, approving, accepting, refusing and
 * withdrawing. A move changes what the workspace holds, so every list is fetched again.
 */
export function useTransferMutations() {
  const client = useQueryClient();
  const refresh = () => void client.invalidateQueries();
  const ok = async (res: Response) => {
    if (!res.ok) await json(res);
  };
  return {
    ask: useMutation({
      mutationFn: async ({ projectId, ...input }: TransferRequestInput & { projectId: string }) =>
        (
          await json<{ transfer: ProjectTransfer | null }>(
            await api.projects[":id"].transfer.$post({ param: { id: projectId }, json: input }),
          )
        ).transfer,
      onSuccess: refresh,
    }),
    approve: useMutation({
      mutationFn: async ({ id, ...input }: TransferConfirmation & { id: string }) =>
        ok(await api.transfers[":id"].approve.$post({ param: { id }, json: input })),
      onSuccess: refresh,
    }),
    accept: useMutation({
      mutationFn: async ({ id, ...input }: TransferConfirmation & { id: string }) =>
        ok(await api.transfers[":id"].accept.$post({ param: { id }, json: input })),
      onSuccess: refresh,
    }),
    refuse: useMutation({
      mutationFn: async (id: string) =>
        ok(await api.transfers[":id"].refuse.$post({ param: { id } })),
      onSuccess: refresh,
    }),
    withdraw: useMutation({
      mutationFn: async (id: string) => ok(await api.transfers[":id"].$delete({ param: { id } })),
      onSuccess: refresh,
    }),
  };
}

/** The workspace's project templates (#240), newest first. */
export const templatesQuery = queryOptions({
  queryKey: ["templates"],
  queryFn: async () =>
    (await json<{ templates: ProjectTemplate[] }>(await api.templates.$get())).templates,
});

/** Saving a project's set-up as a template, and removing one. */
export function useTemplateMutations() {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: templatesQuery.queryKey });
  return {
    save: useMutation({
      mutationFn: async ({ projectId, name }: { projectId: string; name: string }) =>
        (
          await json<{ template: ProjectTemplate }>(
            await api.projects[":id"].template.$post({ param: { id: projectId }, json: { name } }),
          )
        ).template,
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: async (id: string) => {
        const res = await api.templates[":id"].$delete({ param: { id } });
        if (!res.ok) await json(res);
      },
      onSuccess: refresh,
    }),
  };
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

/** The workspace's settings; every member reads them. */
/** The workspace's settings, with the instance's limits on them (its session length). */
export const workspaceSettingsWithLimitsQuery = queryOptions({
  queryKey: ["organisation", "settings"],
  queryFn: async () =>
    json<{ settings: WorkspaceSettings; instance: { sessionDays: number } }>(
      await api.organisation.settings.$get(),
    ),
});

export const workspaceSettingsQuery = queryOptions({
  ...workspaceSettingsWithLimitsQuery,
  select: (r: { settings: WorkspaceSettings }) => r.settings,
});

/** Change some workspace settings (admins). The language reaches every member, so `me` too. */
/** The workspace's directory (LDAP) for signing in; admins only. */
export const directoryQuery = queryOptions({
  queryKey: ["organisation", "directory"],
  queryFn: async () =>
    json<{ directory: DirectorySettings; workspace: string; entitled: boolean }>(
      await api.organisation.directory.$get(),
    ),
});

export function useSaveDirectory() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: DirectorySettingsInput) =>
      (
        await json<{ directory: DirectorySettings }>(
          await api.organisation.directory.$put({ json: input }),
        )
      ).directory,
    onSuccess: () => client.invalidateQueries({ queryKey: directoryQuery.queryKey }),
  });
}

/** Connect with the saved settings and say whether it worked. */
export function useTestDirectory() {
  return useMutation({
    mutationFn: async () =>
      json<{ ok: boolean; problem: string | null }>(await api.organisation.directory.test.$post()),
  });
}

/** Where the workspace's events go (#161): its channels and the events each carries; admins only. */
export const channelsQuery = queryOptions({
  queryKey: ["organisation", "channels"],
  queryFn: async () =>
    (await json<{ channels: ChannelRow[] }>(await api.organisation.channels.$get())).channels,
});

/** Add, change, remove and test a channel. A webhook's signing secret comes back once. */
export function useChannels() {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: channelsQuery.queryKey });
  return {
    add: useMutation({
      mutationFn: async (input: CreateChannelInput) =>
        json<{ channel: ChannelRow; secret?: string }>(
          await api.organisation.channels.$post({ json: input }),
        ),
      onSuccess: refresh,
    }),
    change: useMutation({
      mutationFn: async ({ id, ...input }: UpdateChannelInput & { id: string }) =>
        json<{ channel: ChannelRow; secret?: string }>(
          await api.organisation.channels[":id"].$patch({ param: { id }, json: input }),
        ),
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: async (id: string) => {
        const res = await api.organisation.channels[":id"].$delete({ param: { id } });
        if (!res.ok) await json(res);
      },
      onSuccess: refresh,
    }),
    test: useMutation({
      mutationFn: async (id: string) =>
        json<{ ok: boolean; result: string }>(
          await api.organisation.channels[":id"].test.$post({ param: { id } }),
        ),
    }),
  };
}

/**
 * The workspace's own mail (#161), or null where the instance's sends, and the instance's
 * sender beside it; admins only.
 */
export const workspaceMailSendersQuery = queryOptions({
  queryKey: ["organisation", "mail"],
  queryFn: async () =>
    json<{ mail: WorkspaceMail | null; instance?: InstanceSender }>(
      await api.organisation.mail.$get(),
    ),
});

/** The workspace's own mail alone. */
export const workspaceMailQuery = queryOptions({
  ...workspaceMailSendersQuery,
  select: (r: { mail: WorkspaceMail | null }) => r.mail,
});

/** Who the workspace's mail comes from: its own sender, or the instance's. */
export function useMailSender() {
  const { data } = useQuery(workspaceMailSendersQuery);
  const from = data?.mail?.from ?? data?.instance?.from;
  if (!data || !from) return null;
  return {
    from,
    own: Boolean(data.mail),
    logOnly: !data.mail && Boolean(data.instance?.logOnly),
  };
}

/** Set, test, resume or remove the workspace's own mail. */
export function useWorkspaceMail() {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: workspaceMailQuery.queryKey });
  return {
    save: useMutation({
      mutationFn: async (input: WorkspaceMailInput) =>
        (await json<{ mail: WorkspaceMail }>(await api.organisation.mail.$put({ json: input })))
          .mail,
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: async () => {
        const res = await api.organisation.mail.$delete();
        if (!res.ok) await json(res);
      },
      onSuccess: refresh,
    }),
    resume: useMutation({
      mutationFn: async () =>
        (await json<{ mail: WorkspaceMail }>(await api.organisation.mail.resume.$post())).mail,
      onSuccess: refresh,
    }),
    test: useMutation({
      mutationFn: async () =>
        json<{ ok: boolean; result: string }>(await api.organisation.mail.test.$post()),
      onSettled: refresh,
    }),
  };
}

/** Addresses the workspace's own provider reported as bounced or complaining (#161). */
export const workspaceSuppressionsQuery = queryOptions({
  queryKey: ["organisation", "mail", "suppressions"],
  queryFn: async () =>
    (
      await json<{ suppressions: MailSuppression[] }>(
        await api.organisation.mail.suppressions.$get(),
      )
    ).suppressions,
});

/** Addresses the instance's provider reported (#161); operators only. */
export const instanceSuppressionsQuery = queryOptions({
  queryKey: ["instance", "settings", "suppressions"],
  queryFn: async () =>
    (
      await json<{ suppressions: MailSuppression[] }>(
        await api.instance.settings.suppressions.$get(),
      )
    ).suppressions,
});

/** Send to a reported address again, in the workspace or on the instance. */
export function useSendAgain(scope: "workspace" | "instance") {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const res =
        scope === "workspace"
          ? await api.organisation.mail.suppressions[":id"].$delete({ param: { id } })
          : await api.instance.settings.suppressions[":id"].$delete({ param: { id } });
      if (!res.ok) await json(res);
    },
    onSuccess: () => {
      void client.invalidateQueries({
        queryKey:
          scope === "workspace" ? ["organisation", "mail"] : instanceSuppressionsQuery.queryKey,
      });
    },
  });
}

/** The workspace's billing (#179): its plan, the plans it may choose, the card, usage, invoices. */
export const billingQuery = queryOptions({
  queryKey: ["organisation", "billing"],
  queryFn: async () => json<WorkspaceBilling>(await api.organisation.billing.$get()),
});

/**
 * Change the plan: to the gateway's checkout the first time (the page is left for it), at once
 * on the subscription after that. Owners only.
 */
export function useChangePlan() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { planId: string; promoCode?: string }) =>
      json<{ url: string | null }>(await api.organisation.billing.checkout.$post({ json: input })),
    onSuccess: ({ url }) => {
      if (url) window.location.assign(url);
      else void client.invalidateQueries({ queryKey: billingQuery.queryKey });
    },
  });
}

/** The gateway's page for the card and billing details; the page is left for it. Owners only. */
export function useBillingPortal() {
  return useMutation({
    mutationFn: async () => json<{ url: string }>(await api.organisation.billing.portal.$post()),
    onSuccess: ({ url }) => window.location.assign(url),
  });
}

/** Cancel the plan at the end of its period, or keep it after all. Owners only. */
export function useCancelPlan() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (cancel: boolean) => {
      const res = cancel
        ? await api.organisation.billing.cancel.$post()
        : await api.organisation.billing.resume.$post();
      if (!res.ok) await json(res);
    },
    // The gateway's webhook confirms it a moment later.
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: billingQuery.queryKey });
      setTimeout(() => void client.invalidateQueries({ queryKey: billingQuery.queryKey }), 3000);
    },
  });
}

/** The workspace's single sign-on, and what its identity provider is to be told; admins only. */
export const ssoQuery = queryOptions({
  queryKey: ["organisation", "sso"],
  queryFn: async () =>
    json<{ sso: SsoSettings; serviceProvider: SsoServiceProvider; entitled: boolean }>(
      await api.organisation.sso.$get(),
    ),
});

export function useSaveSso() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: SsoSettingsInput) =>
      json<{ sso: SsoSettings; serviceProvider: SsoServiceProvider }>(
        await api.organisation.sso.$put({ json: input }),
      ),
    onSuccess: () => client.invalidateQueries({ queryKey: ssoQuery.queryKey }),
  });
}

/** The workspace's logo and accent (#185), as stored; every member reads them. */
export const brandingQuery = queryOptions({
  queryKey: ["organisation", "branding"],
  queryFn: async () =>
    (await json<{ branding: StoredBranding }>(await api.organisation.branding.$get())).branding,
});

/** The workspace's logo and accent (#185): owners and admins set them. */
export function useBranding() {
  const client = useQueryClient();
  const settle = (data: { branding: StoredBranding }) => {
    client.setQueryData(brandingQuery.queryKey, data.branding);
    void client.invalidateQueries({ queryKey: ["organisation", "email"] });
  };
  return {
    accent: useMutation({
      mutationFn: async (accent: string | null) =>
        json<{ branding: StoredBranding }>(
          await api.organisation.branding.accent.$put({ json: { accent } }),
        ),
      onSuccess: settle,
    }),
    upload: useMutation({
      mutationFn: async (file: File) =>
        json<{ branding: StoredBranding }>(
          await fetch("/api/organisation/branding/logo", {
            method: "POST",
            credentials: "same-origin",
            headers: { "content-type": file.type || "application/octet-stream" },
            body: file,
          }),
        ),
      onSuccess: settle,
    }),
    remove: useMutation({
      mutationFn: async () =>
        json<{ branding: StoredBranding }>(await api.organisation.branding.logo.$delete()),
      onSuccess: settle,
    }),
  };
}

export function useSaveWorkspaceSettings() {
  const client = useQueryClient();
  return useMutation({
    scope: { id: "workspace-settings" },
    mutationFn: async (change: WorkspaceSettingsInput) =>
      (
        await json<{ settings: WorkspaceSettings }>(
          await api.organisation.settings.$patch({ json: change }),
        )
      ).settings,
    onSuccess: (settings, change) => {
      client.setQueryData(workspaceSettingsWithLimitsQuery.queryKey, (before) =>
        before ? { ...before, settings } : before,
      );
      if (change.emailSubjects) client.invalidateQueries({ queryKey: ["organisation", "email"] });
      if (change.locale !== undefined) client.invalidateQueries({ queryKey: meQuery.queryKey });
      // Every file that inherits the workspace's profile is measured afresh, in every project.
      if (change.deliveryProfile !== undefined) {
        void client.invalidateQueries({
          predicate: (q) => q.queryKey[0] === "files" && q.queryKey[2] === "qa",
        });
        void client.invalidateQueries({ queryKey: ["projects"] });
      }
    },
  });
}

/** A message as the workspace sends it, with sample content, for one kind of mail client. */
export const emailPreviewQuery = (template: EmailTemplateId, scheme: "light" | "dark") =>
  queryOptions({
    queryKey: ["organisation", "email", template, scheme],
    queryFn: async () =>
      json<{ subject: string; text: string; html: string }>(
        await api.organisation.email[":template"].$get({
          param: { template },
          query: { scheme },
        }),
      ),
  });

/** Send a template to yourself, with sample content. */
export function useSendTestEmail() {
  return useMutation({
    mutationFn: async (template: EmailTemplateId) =>
      json<{ to: string }>(await api.organisation.email.test.$post({ json: { template } })),
  });
}

export interface WorkspaceStorage {
  /** The workspace's choice; null follows the instance default. */
  backend: string | null;
  defaultBackend: string;
  available: string[];
}

/** What the instance is doing for this workspace (#165), for its owner; read every 15 s. */
export const workspaceOperationsQuery = queryOptions({
  queryKey: ["organisation", "operations"],
  queryFn: async () => json<WorkspaceOperations>(await api.organisation.operations.$get()),
  refetchInterval: 15_000,
});

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

/** Forensic marking (#32): whether recordings' downloads are marked; the workspace's owners. */
export const forensicQuery = queryOptions({
  queryKey: ["organisation", "forensic"],
  queryFn: async () => json<ForensicStatus>(await api.organisation.forensic.$get()),
});

export function useForensic() {
  const client = useQueryClient();
  return {
    audio: useMutation({
      mutationFn: async (audio: boolean) =>
        json<ForensicStatus>(await api.organisation.forensic.$put({ json: { audio } })),
      onSuccess: (status) => client.setQueryData(forensicQuery.queryKey, status),
    }),
    /** A suspected leak, sent to be traced: examined, never kept, and logged. */
    trace: useMutation({
      mutationFn: async (file: File) =>
        json<TraceResult>(
          await fetch("/api/organisation/forensic/trace", {
            method: "POST",
            credentials: "same-origin",
            headers: {
              "content-type": "application/octet-stream",
              "x-file-name": encodeURIComponent(file.name),
            },
            body: file,
          }),
        ),
    }),
  };
}

/** Where a project's new files go, and how much it keeps (#240); workspace admins only. */
export interface ProjectStorage {
  /** The project's choice; null follows the workspace's. */
  backend: string | null;
  workspaceBackend: string;
  available: string[];
  bytes: number;
}

export const projectStorageQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["projects", projectId, "storage"],
    queryFn: async () =>
      json<ProjectStorage>(await api.projects[":id"].storage.$get({ param: { id: projectId } })),
  });

/** Choosing a project's backend for new files; workspace owners only. */
export function useProjectStorage(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (backend: string | null) =>
      json<ProjectStorage>(
        await api.projects[":id"].storage.$put({ param: { id: projectId }, json: { backend } }),
      ),
    onSuccess: (data) => client.setQueryData(projectStorageQuery(projectId).queryKey, data),
  });
}

/** What the workspace keeps in storage, and what the reconciliation found; admins only. */
export interface StorageUsage {
  backends: { name: string; bytes: number; objects: number }[];
  projects: { id: string; name: string; bytes: number }[];
  bytes: number;
  reconciliation: {
    removing: boolean;
    lastRun: { startedAt: string; finishedAt: string | null } | null;
    orphans: number;
    unused: number;
    missing: number;
    removed: number;
  };
  /** What it uses against its limits, and in the month so far (#175). */
  usage: WorkspaceUsage;
}

export const storageUsageQuery = queryOptions({
  queryKey: ["organisation", "storage", "usage"],
  queryFn: async () => json<StorageUsage>(await api.organisation.storage.usage.$get()),
});

/** Reconcile this workspace's storage now; what it finds is acted on only by a later run. */
export function useReconcile() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async () => json<StorageUsage>(await api.organisation.storage.reconcile.$post()),
    onSuccess: (usage) => client.setQueryData(storageUsageQuery.queryKey, usage),
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
  fileId?: string;
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
      if (filters.fileId) query.fileId = filters.fileId;
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
    onSuccess: (_, organisationId) => {
      // With workspace subdomains (#176), each workspace is at its own host: go there.
      const url = client
        .getQueryData(meQuery.queryKey)
        ?.organisations.find((o) => o.id === organisationId)?.url;
      if (url && new URL(url).host !== window.location.host) {
        window.location.assign(`${url}/`);
        return;
      }
      return client.invalidateQueries();
    },
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
  /** The file this one replaces, in a simple version chain (#149; in a project's file list). */
  previousFileId?: string | null;
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
  /**
   * Its simple version chain (#149), oldest first, as far as the viewer may open it; empty
   * for a file in none.
   */
  chain: { id: string; name: string; number: number; createdAt: string }[];
  /** The take it belongs to, if any: a take's file has no version chain. */
  takeId: string | null;
  /** The project's profile: it decides which tools the page offers, bars among them. */
  profile: ProjectProfile;
  /** For a guest, what their reviews let them do with this file; null for members. */
  grant:
    | (Pick<ReviewerPermissions, "comment" | "comments" | "tools"> & { listenOnly?: boolean })
    | null;
  /** For a member, the player tools their role has on (#240); null for a guest. */
  tools: PlayerTool[] | null;
  /** Normalised playback (#240), where it applies to this viewer: its mode and volume. */
  normalisation: Normalisation | null;
  /** The viewer's mark over a video, where the project marks them (#31). */
  watermark: { text: string; position: WatermarkPosition; opacity: number } | null;
  /** What a comment here may name as it is read from the score: page, bars, beats (#240). */
  references: CommentReferences;
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
  /** A video's frames along it (#16), through the same link; null where there is none. */
  filmstrip: { url: string; frames: number } | null;
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
  /** The bar numbers a score prints, in reading order, for going to a bar (#52). */
  bars: PrintedBar[];
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

/**
 * A file's spectrograms, one per channel plus mid and side, once the worker has made them:
 * with the analysis every file has, or a viewer's own, drawn when first asked for (#34).
 */
export const spectrogramsQuery = (
  fileId: string,
  analysis: SpectrogramAnalysis = defaultAnalysis,
) =>
  queryOptions({
    queryKey: ["files", fileId, "spectrograms", "list", analysisKey(analysis)],
    queryFn: async () =>
      json<{ status: StreamStatus; spectrograms: SpectrogramInfo[] }>(
        await api.files[":id"].spectrograms.$get({
          param: { id: fileId },
          query: isDefaultAnalysis(analysis) ? {} : analysis,
        }),
      ),
    refetchInterval: (query) => (query.state.data?.status === "pending" ? 3000 : false),
  });

/** Try again to draw spectrograms with settings that failed (#34). */
export function useRetrySpectrogram(fileId: string, analysis: SpectrogramAnalysis) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await api.files[":id"].spectrograms.retry.$post({
        param: { id: fileId },
        json: analysis,
      });
      if (!res.ok) await json(res);
    },
    onSuccess: () =>
      client.invalidateQueries({ queryKey: spectrogramsQuery(fileId, analysis).queryKey }),
  });
}

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
  /** Written by the viewer, whether a member or a guest. */
  mine: boolean;
  resolvedAt: string | null;
  resolvedByName: string | null;
  editedAt: string | null;
  createdAt: string;
  /** Set on a thread carried here from an earlier version; its anchor is then the mapped one. */
  carry: CommentCarry | null;
  /** On a thread: where it began, and each version it was carried to. */
  history: CommentHistory | null;
  /** Triage (#36): its kind, the stage it waits for, and who is to act on it. */
  categoryId: string | null;
  deferredTo: string | null;
  assigneeId: string | null;
  assigneeName: string | null;
  /** The members it mentions (#133), named as they were when it was written. */
  mentions: CommentMention[];
  /** Takes shared on it, a thread (#133); none on a reply. */
  takes: SharedTake[];
  /** Files attached to it (#133): names and sizes; the bytes only by a download. */
  attachments: CommentAttachment[];
  /** A thread made a task (#133, #140): the project's task, and when and by whom it was done. */
  todo: boolean;
  taskId: string | null;
  todoDoneAt: string | null;
  todoDoneByName: string | null;
  /** The channel it is about (#74), by its place in the file's order; null is all of them. */
  channel: number | null;
  /** The marker list it was imported from (#134), and who imported it (hidden from guests). */
  importedFrom: string | null;
  importedByName: string | null;
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
  /** Each version it was carried to: its status there, and whether its anchor was moved by hand. */
  hops: { fileId: string; versionNumber: number; status: CarryStatus; moved: boolean }[];
}

/** A kind of comment in a project (#36), and how its comments are handled by default. */
export interface CommentCategory {
  id: string;
  name: string;
  handling: CategoryHandling;
  stage: string | null;
  position: number;
}

export const categoriesQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["projects", projectId, "categories"],
    queryFn: async () =>
      (
        await json<{ categories: CommentCategory[] }>(
          await api.projects[":id"].categories.$get({ param: { id: projectId } }),
        )
      ).categories,
    staleTime: 60_000,
  });

/** Add, rename, re-handle or remove a project's comment categories. */
export function useCategoryMutations(projectId: string) {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: categoriesQuery(projectId).queryKey });
  return {
    create: useMutation({
      mutationFn: async (input: CategoryInput) =>
        json<{ category: CommentCategory }>(
          await api.projects[":id"].categories.$post({ param: { id: projectId }, json: input }),
        ),
      onSuccess: refresh,
    }),
    update: useMutation({
      mutationFn: async ({ id, ...input }: CategoryInput & { id: string }) =>
        json<{ category: CommentCategory }>(
          await api.categories[":id"].$patch({ param: { id }, json: input }),
        ),
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: async (id: string) => {
        const res = await api.categories[":id"].$delete({ param: { id } });
        if (!res.ok) await json(res);
      },
      onSuccess: refresh,
    }),
  };
}

/** The categories every new project in the workspace starts with (decision 247). */
export const workspaceCategoriesQuery = queryOptions({
  queryKey: ["organisation", "categories"],
  queryFn: async () =>
    (await json<{ categories: CommentCategory[] }>(await api.organisation.categories.$get()))
      .categories,
});

/** Add, change or remove one of the workspace's categories for new projects (admins). */
export function useWorkspaceCategoryMutations(): CategoryMutations {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: workspaceCategoriesQuery.queryKey });
  return {
    create: useMutation({
      mutationFn: async (input: CategoryInput) =>
        json<{ category: CommentCategory }>(
          await api.organisation.categories.$post({ json: input }),
        ),
      onSuccess: refresh,
    }),
    update: useMutation({
      mutationFn: async ({ id, ...input }: CategoryInput & { id: string }) =>
        json<{ category: CommentCategory }>(
          await api.organisation.categories[":id"].$patch({ param: { id }, json: input }),
        ),
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: async (id: string) => {
        const res = await api.organisation.categories[":id"].$delete({ param: { id } });
        if (!res.ok) await json(res);
      },
      onSuccess: refresh,
    }),
  };
}

/** Making, changing and removing categories: a project's, or the workspace's set. */
export type CategoryMutations = ReturnType<typeof useCategoryMutations>;

/** What swapping a track's score carried to the new one (#52), and what stayed. */
export interface ScoreRehomed {
  marks: number;
  takes: number;
  stayed: number;
  /** The new score is still being drawn: its marks follow their bars once it is. */
  waiting?: boolean;
}

/** What someone may download of a file, and what each kind would be (#136). */
export interface DownloadChoices {
  level: DownloadLevel;
  proxy: { available: boolean; detail: string };
  original: { available: boolean; detail: string };
  /** Whether the download carries the recipient's mark. */
  marked: boolean;
  /** A recording's mark is inaudible rather than drawn (#32). */
  inaudible?: boolean;
}

export const downloadsQuery = (fileId: string) =>
  queryOptions({
    queryKey: ["files", fileId, "downloads"],
    queryFn: async () =>
      json<DownloadChoices>(await api.files[":id"].downloads.$get({ param: { id: fileId } })),
  });

/**
 * Ask for a download: a link that works once, in this session, for five minutes. A track's
 * score may be asked for with the track's score marks drawn over it (#52).
 */
export function useRequestDownload(fileId: string) {
  return useMutation({
    mutationFn: async ({ kind, marks }: { kind: DownloadKind; marks?: string }) =>
      json<{ url: string }>(
        await api.files[":id"].downloads.$post({
          param: { id: fileId },
          json: marks ? { kind, marks } : { kind },
        }),
      ),
  });
}

/** Ask for every track's score in a project with its marks, as one PDF (#52). */
export function useRequestScoresDownload(projectId: string) {
  return useMutation({
    mutationFn: async (kind: DownloadKind) =>
      json<{ url: string }>(
        await api.projects[":id"]["score-downloads"].$post({
          param: { id: projectId },
          json: { kind },
        }),
      ),
  });
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

/** Whom this member may mention on a file (#133): its project's people. None for guests. */
export const mentionableQuery = (fileId: string) =>
  queryOptions({
    queryKey: ["files", fileId, "mentionable"],
    queryFn: async () =>
      (
        await json<{ people: CommentMention[] }>(
          await api.files[":id"].mentionable.$get({ param: { id: fileId } }),
        )
      ).people,
    staleTime: 5 * 60_000,
  });

export function useCommentMutations(fileId: string) {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: ["files", fileId, "comments"] });
  return {
    create: useMutation({
      mutationFn: async (input: {
        body: string;
        anchor?: Anchor | null;
        parentId?: string;
        mentions?: string[];
        categoryId?: string | null;
      }) =>
        json<{ comment: Comment }>(
          await api.files[":id"].comments.$post({ param: { id: fileId }, json: input }),
        ),
      onSuccess: refresh,
    }),
    /** Markers read from another application's list, as comments (#134). */
    importMarkers: useMutation({
      mutationFn: async (input: ImportMarkersInput) =>
        json<{ imported: number }>(
          await api.files[":id"].comments.import.$post({ param: { id: fileId }, json: input }),
        ),
      onSuccess: refresh,
    }),
    edit: useMutation({
      mutationFn: async ({ id, ...change }: { id: string; body: string; mentions?: string[] }) =>
        json<{ comment: Comment }>(
          await api.comments[":id"].$patch({ param: { id }, json: change }),
        ),
      onSuccess: refresh,
    }),
    /** A file attached to a comment just written (#133). */
    attach: useMutation({
      mutationFn: async ({ commentId, file }: { commentId: string; file: File }) =>
        json(
          await fetch(`/api/files/${fileId}/comments/${commentId}/attachments`, {
            method: "POST",
            credentials: "same-origin",
            headers: {
              "content-type": file.type || "application/octet-stream",
              "x-file-name": encodeURIComponent(file.name),
            },
            body: file,
          }),
        ),
      onSettled: refresh,
    }),
    /** Sharing takes on a thread (#133), or no longer: everyone who sees it hears them. */
    shareTakes: useMutation({
      mutationFn: async ({ commentId, takeIds }: { commentId: string; takeIds: string[] }) =>
        json(
          await api.comments[":id"].takes.$post({ param: { id: commentId }, json: { takeIds } }),
        ),
      onSuccess: refresh,
    }),
    unshareTake: useMutation({
      mutationFn: async ({ commentId, takeId }: { commentId: string; takeId: string }) => {
        const res = await api.comments[":id"].takes[":takeId"].$delete({
          param: { id: commentId, takeId },
        });
        if (!res.ok) await json(res);
      },
      onSuccess: refresh,
    }),
    /** Removing a file from your own comment. */
    detach: useMutation({
      mutationFn: async (attachmentId: string) =>
        json(
          await api.files[":id"].attachments[":attachmentId"].$delete({
            param: { id: fileId, attachmentId },
          }),
        ),
      onSuccess: refresh,
    }),
    /** A one-time download of an attachment, made for this person, opened at once. */
    download: useMutation({
      mutationFn: async (attachmentId: string) =>
        json<{ url: string }>(
          await api.files[":id"].attachments[":attachmentId"].download.$post({
            param: { id: fileId, attachmentId },
          }),
        ),
      onSuccess: ({ url }) => window.location.assign(url),
    }),
    /** A thread as a task (#133), and done or not. */
    todo: useMutation({
      mutationFn: async ({ id, ...change }: { id: string; todo: boolean; done?: boolean }) =>
        json<{ comment: Comment }>(
          await api.comments[":id"].todo.$post({ param: { id }, json: change }),
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
    /**
     * Triage on one thread or a selection (#36, #132): category, deferral, assignee or
     * resolved. The answer is the file's threads as they now stand.
     */
    triage: useMutation({
      mutationFn: async (input: TriageInput) =>
        (
          await json<{ comments: Comment[] }>(
            await api.files[":id"].comments.triage.$post({ param: { id: fileId }, json: input }),
          )
        ).comments,
      onSuccess: (comments) => client.setQueryData(["files", fileId, "comments"], comments),
    }),
    /** Send someone the open threads on this file assigned to them. */
    sendList: useMutation({
      mutationFn: async (userId: string) =>
        json<{ sent: number }>(
          await api.files[":id"].comments["send-list"].$post({
            param: { id: fileId },
            json: { userId },
          }),
        ),
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
  profile: { id: ProfileRef; label: string; source: ProfileSource; chosen: boolean };
  /** What the file would be measured against without a profile of its own. */
  inherited: { id: ProfileRef; label: string; source: ProfileSource };
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

/** What the checks found fixed and new since the previous version of a track (#43). */
export interface QaChanges {
  previous: { number: number; name: string } | null;
  measured: boolean;
  fixed: QaFinding[];
  new: QaFinding[];
}

export const qaChangesQuery = (fileId: string) =>
  queryOptions({
    // Under the report's key, so a profile changed refreshes it with the report.
    queryKey: ["files", fileId, "qa", "changes"],
    queryFn: async () =>
      json<QaChanges>(await api.files[":id"].qa.changes.$get({ param: { id: fileId } })),
    staleTime: 60_000,
    // While either version is still being measured, look again now and then, for a few
    // minutes: one whose analysis failed is never measured, and is not waited on for ever.
    refetchInterval: (query) =>
      query.state.data?.previous && !query.state.data.measured && query.state.dataUpdateCount < 40
        ? 5000
        : false,
  });

/** Every file's QA report may change when a profile does. */
const refreshReports = (client: ReturnType<typeof useQueryClient>) =>
  client.invalidateQueries({
    predicate: (q) => q.queryKey[0] === "files" && q.queryKey[2] === "qa",
  });

/** Choose what one file is measured against, over its track's and project's (#144). */
export function useFileDeliveryProfile(fileId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (deliveryProfile: ProfileRef | null) => {
      const res = await api.files[":id"]["delivery-profile"].$put({
        param: { id: fileId },
        json: { deliveryProfile },
      });
      if (!res.ok) await json(res);
    },
    onSuccess: () => refreshReports(client),
  });
}

/** Choose what a track's versions are measured against, over the project's (#144). */
export function useTrackDeliveryProfile(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({
      trackId,
      deliveryProfile,
    }: {
      trackId: string;
      deliveryProfile: ProfileRef | null;
    }) =>
      json(
        await api.tracks[":id"]["delivery-profile"].$put({
          param: { id: trackId },
          json: { deliveryProfile },
        }),
      ),
    onSuccess: () => {
      void refreshReports(client);
      void client.invalidateQueries({ queryKey: projectTracksQuery(projectId).queryKey });
    },
  });
}

/** Choose the references a track's comments may name, over the project's (#240). */
/** A track's own normalised playback (#98), or null to keep the project's. */
export function useTrackNormalisation(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({
      trackId,
      normalisation,
    }: {
      trackId: string;
      normalisation: NormalisationMode | null;
    }) =>
      json(
        await api.tracks[":id"].normalisation.$put({
          param: { id: trackId },
          json: { normalisation },
        }),
      ),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: projectTracksQuery(projectId).queryKey });
      // A file of the track learns how it plays when next opened.
      void client.invalidateQueries({
        predicate: (q) => q.queryKey[0] === "files" && q.queryKey.length === 2,
      });
    },
  });
}

export function useTrackReferences(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({
      trackId,
      references,
    }: {
      trackId: string;
      references: CommentReferences | null;
    }) =>
      json(
        await api.tracks[":id"].references.$put({
          param: { id: trackId },
          json: { references },
        }),
      ),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: projectTracksQuery(projectId).queryKey });
      // A file of the track learns its references again when next opened.
      void client.invalidateQueries({
        predicate: (q) => q.queryKey[0] === "files" && q.queryKey.length === 2,
      });
    },
  });
}

/** The workspace's own delivery profiles, beside the built-in ones (#144). */
export const customProfilesQuery = queryOptions({
  queryKey: ["organisation", "delivery-profiles"],
  queryFn: async () =>
    (await json<{ profiles: CustomProfile[] }>(await api.organisation["delivery-profiles"].$get()))
      .profiles,
  staleTime: 60_000,
});

/** Make, change or remove one of the workspace's own profiles. Admins only. */
export function useCustomProfileMutations() {
  const client = useQueryClient();
  const refresh = () => {
    void client.invalidateQueries({ queryKey: customProfilesQuery.queryKey });
    void refreshReports(client);
  };
  return {
    create: useMutation({
      mutationFn: async (input: CustomProfileInput) =>
        (
          await json<{ profile: CustomProfile }>(
            await api.organisation["delivery-profiles"].$post({ json: input }),
          )
        ).profile,
      onSuccess: refresh,
    }),
    update: useMutation({
      mutationFn: async ({ id, ...input }: CustomProfileInput & { id: string }) =>
        (
          await json<{ profile: CustomProfile }>(
            await api.organisation["delivery-profiles"][":id"].$put({ param: { id }, json: input }),
          )
        ).profile,
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: async (id: string) => {
        const res = await api.organisation["delivery-profiles"][":id"].$delete({ param: { id } });
        if (!res.ok) await json(res);
      },
      onSuccess: () => {
        refresh();
        // Whatever chose it chooses nothing now.
        void client.invalidateQueries({ queryKey: ["projects"] });
        void client.invalidateQueries({ queryKey: workspaceSettingsQuery.queryKey });
      },
    }),
  };
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
  /** A rendition's treatment (#16): null until someone says. */
  subtitled: boolean | null;
  graded: boolean | null;
  /** The picture, where the file has one: its shape and codec. */
  video: MediaInfo["video"] | null;
}

export interface Version {
  id: string;
  number: number;
  /** Who added it, by name; null once their account is gone. */
  createdByName: string | null;
  /** Who sent its file through an upload request, where no member added it (#425). */
  sentBy?: string | null;
  /** How it was cut from the takes: an edit decision list in the project. */
  edlFileId: string | null;
  /** Who let it in past the project's version checks, when someone had to. */
  letThroughBy: string | null;
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
  /** What its versions are measured against, over the project's; null takes the project's. */
  deliveryProfile: ProfileRef | null;
  /** The references its comments may name, over the project's; null keeps the project's (#240). */
  commentReferences: CommentReferences | null;
  /** How its recordings play normalised, over the project's; null keeps the project's (#98). */
  normalisation: NormalisationMode | null;
  createdAt: string;
  versions: Version[];
  /** In a project's track list: where it stands, and who it waits on while in review. */
  state?: TrackState;
  waitingOn?: OverviewPerson[];
  /** In a project's track list, for those who may see takes: how many it has. */
  takes?: number;
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

/** A thread the next version of a track would carry over, to confirm or correct. */
export interface CarryCandidate {
  commentId: string;
  body: string;
  authorName: string | null;
  anchor: Anchor | null;
  /** The variation it was raised or carried on. */
  variation: string | null;
}

export const carryQuery = (trackId: string) =>
  queryOptions({
    queryKey: ["tracks", trackId, "carry"],
    queryFn: async () =>
      (
        await json<{ threads: CarryCandidate[] }>(
          await api.tracks[":id"].carry.$get({ param: { id: trackId } }),
        )
      ).threads,
  });

/**
 * What a file can be compared with (#44): its track's versions and variations, as far as the
 * person may open them.
 */
export interface CompareFamily {
  versions: {
    id: string;
    number: number;
    variations: Pick<Variation, "fileId" | "name" | "isPrimary" | "position" | "streamStatus">[];
  }[];
}

export const compareFamilyQuery = (fileId: string) =>
  queryOptions({
    queryKey: ["files", fileId, "compare"],
    queryFn: async () =>
      json<CompareFamily>(await api.files[":id"].compare.$get({ param: { id: fileId } })),
  });

export const trackQuery = (trackId: string) =>
  queryOptions({
    queryKey: ["tracks", trackId],
    queryFn: async () =>
      (await json<{ track: Track }>(await api.tracks[":id"].$get({ param: { id: trackId } })))
        .track,
  });

/** Where a track stands in its workflow (#26): its status, the step it waits at, and the next. */
export const trackStandingQuery = (trackId: string) =>
  queryOptions({
    queryKey: ["tracks", trackId, "workflow-standing"],
    queryFn: async () =>
      json<WorkflowStanding>(
        await api.tracks[":id"]["workflow-standing"].$get({ param: { id: trackId } }),
      ),
  });

/** A track's takes (#21, #46), in order. */
export const trackTakesQuery = (trackId: string) =>
  queryOptions({
    queryKey: ["tracks", trackId, "takes"],
    queryFn: async () =>
      (
        await json<{ takes: TakeRow[] }>(
          await api.tracks[":id"].takes.$get({ param: { id: trackId }, query: {} }),
        )
      ).takes,
  });

/** One take for its page: its track, session, and the session's other takes of the track. */
export const takeQuery = (takeId: string) =>
  queryOptions({
    queryKey: ["takes", takeId],
    queryFn: async () =>
      (await json<{ take: TakeDetail }>(await api.takes[":id"].$get({ param: { id: takeId } })))
        .take,
  });

/**
 * A track's edit decisions (#56): the latest version's edit decision list matched to its
 * takes, read at a timecode rate where the list leaves it unsure; or a given version's list.
 * Null where there is none.
 */
export const editDecisionsQuery = (trackId: string, rate?: EdlRate, version?: string) =>
  queryOptions({
    queryKey: ["tracks", trackId, "edit-decisions", rate ?? null, version ?? null],
    queryFn: async () =>
      (
        await json<{ decisions: EditDecisions | null }>(
          await api.tracks[":id"]["edit-decisions"].$get({
            param: { id: trackId },
            query: { ...(rate ? { rate: String(rate) } : {}), ...(version ? { version } : {}) },
          }),
        )
      ).decisions,
  });

/** Making files into a track's takes, changing a take, and no longer counting one. */
/** A project's recording sessions (#21, #45), newest first. */
export const projectSessionsQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["projects", projectId, "sessions"],
    queryFn: async () =>
      (
        await json<{ sessions: SessionSummary[] }>(
          await api.projects[":id"].sessions.$get({ param: { id: projectId } }),
        )
      ).sessions,
  });

/** One recording session, with the takes recorded in it. */
export const sessionQuery = (sessionId: string) =>
  queryOptions({
    queryKey: ["sessions", sessionId],
    queryFn: async () =>
      (
        await json<{ session: SessionDetail }>(
          await api.sessions[":id"].$get({ param: { id: sessionId } }),
        )
      ).session,
  });

/** A project's sessions lists, whichever project: they count takes recorded in them. */
const sessionsKey = (query: { queryKey: readonly unknown[] }) => query.queryKey[2] === "sessions";

/** Making, changing and removing a project's sessions. */
export function useSessionMutations(projectId: string) {
  const client = useQueryClient();
  const refresh = () => {
    void client.invalidateQueries({ queryKey: projectSessionsQuery(projectId).queryKey });
    void client.invalidateQueries({ queryKey: ["sessions"] });
  };
  return {
    create: useMutation({
      mutationFn: async (input: SessionInput) =>
        (
          await json<{ session: SessionSummary }>(
            await api.projects[":id"].sessions.$post({ param: { id: projectId }, json: input }),
          )
        ).session,
      onSuccess: refresh,
    }),
    change: useMutation({
      mutationFn: async ({ id, ...change }: SessionChange & { id: string }) =>
        (
          await json<{ session: SessionSummary }>(
            await api.sessions[":id"].$patch({ param: { id }, json: change }),
          )
        ).session,
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: async (id: string) => {
        const res = await api.sessions[":id"].$delete({ param: { id } });
        if (!res.ok) await json(res);
      },
      onSuccess: () => {
        refresh();
        // Its takes no longer name it.
        void client.invalidateQueries({ queryKey: ["tracks"] });
      },
    }),
    /** Files already uploaded made the takes an import proposed (#45). */
    importTakes: useMutation({
      mutationFn: async (input: TakeImport) =>
        json<{ imported: number; skipped: number }>(
          await api.projects[":id"].takes.import.$post({ param: { id: projectId }, json: input }),
        ),
      onSuccess: () => {
        refresh();
        void client.invalidateQueries({ queryKey: ["tracks"] });
      },
    }),
  };
}

/** One write from the take log's outbox, to the server. */
function sendWrite(sessionId: string, write: PendingWrite) {
  switch (write.kind) {
    case "start":
      return api.sessions[":id"].takes.$post({ param: { id: sessionId }, json: write.body });
    case "change":
      return api.takes[":id"].$patch({ param: { id: write.takeId }, json: write.body });
    case "notes":
      return api.sessions[":id"].$patch({ param: { id: sessionId }, json: write.body });
    case "todo-add":
      return api.sessions[":id"].todos.$post({
        param: { id: sessionId },
        json: { id: write.todoId, ...write.body },
      });
    case "todo-change":
      return api.sessions[":id"].todos[":todoId"].$patch({
        param: { id: sessionId, todoId: write.todoId },
        json: write.body,
      });
    case "todo-remove":
      return api.sessions[":id"].todos[":todoId"].$delete({
        param: { id: sessionId, todoId: write.todoId },
      });
  }
}

/**
 * The take log's writes (#51), local first: each is kept in this browser's outbox and shown at
 * once, then sent in order. While the server cannot be reached they wait, and go when it
 * returns; one the server refuses is let go, and `problem` says why.
 */
export function useTakeOutbox(sessionId: string) {
  const client = useQueryClient();
  const key = sessionQuery(sessionId).queryKey;
  const store = outboxStore();
  const [pending, setPending] = useState<PendingWrite[]>([]);
  const [waiting, setWaiting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const sending = useRef(false);

  const flush = useCallback(async () => {
    if (sending.current) return;
    sending.current = true;
    let sent = false;
    try {
      for (const write of await store.list(sessionId)) {
        let status: number | "offline";
        let refusal: string | null = null;
        try {
          const res = await sendWrite(sessionId, write);
          // Someone else already removed it: what this write asked for is so.
          status = write.kind === "todo-remove" && res.status === 404 ? 204 : res.status;
          if (outcomeOf(status) === "refused")
            refusal = await json(res).then(
              () => null,
              (error: Error) => error.message,
            );
        } catch {
          status = "offline";
        }
        if (outcomeOf(status) === "retry") {
          setWaiting(true);
          return;
        }
        setWaiting(false);
        if (refusal) setProblem(refusal);
        if (write.seq !== undefined) await store.remove(write.seq);
        setPending((all) => all.filter((w) => w.seq !== write.seq));
        sent = true;
      }
    } finally {
      sending.current = false;
      if (sent) {
        void client.invalidateQueries({ queryKey: key });
        void client.invalidateQueries({ queryKey: ["tracks"] });
      }
    }
  }, [client, key, sessionId, store]);

  // What an earlier visit left unsent, then sent; again whenever the browser is back online,
  // and every few seconds while anything waits.
  useEffect(() => {
    let live = true;
    void store.list(sessionId).then((writes) => {
      if (!live) return;
      setPending(writes);
      void flush();
    });
    const online = () => void flush();
    window.addEventListener("online", online);
    return () => {
      live = false;
      window.removeEventListener("online", online);
    };
  }, [sessionId, store, flush]);
  const count = pending.length;
  useEffect(() => {
    if (count === 0) return;
    const timer = setInterval(() => void flush(), 5000);
    return () => clearInterval(timer);
  }, [count, flush]);

  const write = async (made: PendingWrite) => {
    setProblem(null);
    setPending((all) => [...all, made]);
    try {
      const kept = await store.add(made);
      setPending((all) => all.map((w) => (w === made ? kept : w)));
    } catch {
      // Not even memory took it: it is not shown as waiting when nothing holds it.
      setPending((all) => all.filter((w) => w !== made));
      setProblem("That was not saved; try again");
      return;
    }
    void flush();
  };

  return {
    /** Writes not yet confirmed, to lay over the session. */
    pending,
    /** Whether writes are waiting for the server to be reached again. */
    waiting,
    problem,
    /** Whether waiting writes outlive the page; not once this browser's storage has failed. */
    durable: store.durable(),
    /**
     * The next take, numbered as the log shows it until the server numbers it; named by the
     * caller where it must act on the take before the log shows it (a recorder, decision 240).
     */
    start: (input: StartTake, number: number) => {
      const at = new Date().toISOString();
      const takeId = input.id ?? uuidv7();
      return write({
        kind: "start",
        sessionId,
        takeId,
        number,
        body: { ...input, id: takeId, at },
      });
    },
    /** The session's notes, or the producer's quick reference: kept here, then sent. */
    notes: (body: Pick<SessionChange, "notes" | "reference">) =>
      write({ kind: "notes", sessionId, body }),
    /** Something to do, named here so that, sent twice, it is made once. */
    addTodo: (text: string) =>
      write({ kind: "todo-add", sessionId, todoId: uuidv7(), body: { text } }),
    changeTodo: (todoId: string, body: SessionTodoChange) =>
      write({ kind: "todo-change", sessionId, todoId, body }),
    removeTodo: (todoId: string) => write({ kind: "todo-remove", sessionId, todoId }),
    /** A change to a take, with what the log last saw of the fields it sets. */
    change: (take: SessionDetail["takeRows"][number], change: TakeChange) => {
      const at = new Date().toISOString();
      return write({
        kind: "change",
        sessionId,
        takeId: take.id,
        body: { ...rolledAt(take, change, at), base: baseOf(take, change), at },
      });
    },
  };
}

/** A project's patch list (#54): its stage boxes, each with its inputs and outputs. */
export const patchQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["projects", projectId, "patch"],
    queryFn: async () =>
      (
        await json<{ boxes: StageBox[] }>(
          await api.projects[":id"].patch.$get({ param: { id: projectId } }),
        )
      ).boxes,
  });

/** Adding, renaming and removing stage boxes, and patching their channels. */
export function usePatchList(projectId: string) {
  const client = useQueryClient();
  const refresh = () => void client.invalidateQueries({ queryKey: patchQuery(projectId).queryKey });
  return {
    addBox: useMutation({
      mutationFn: async (name: string) =>
        json(
          await api.projects[":id"]["stage-boxes"].$post({
            param: { id: projectId },
            json: { name },
          }),
        ),
      onSettled: refresh,
    }),
    renameBox: useMutation({
      mutationFn: async ({ id, name }: { id: string; name: string }) =>
        json(await api["stage-boxes"][":id"].$patch({ param: { id }, json: { name } })),
      onSettled: refresh,
    }),
    removeBox: useMutation({
      mutationFn: async (id: string) => {
        const res = await api["stage-boxes"][":id"].$delete({ param: { id } });
        if (!res.ok) await json(res);
      },
      onSettled: refresh,
    }),
    addRow: useMutation({
      mutationFn: async ({ boxId, ...row }: PatchRowInput & { boxId: string }) =>
        json(await api["stage-boxes"][":id"].rows.$post({ param: { id: boxId }, json: row })),
      onSettled: refresh,
    }),
    changeRow: useMutation({
      mutationFn: async ({ id, ...change }: PatchRowChange & { id: string }) =>
        json(await api["patch-rows"][":id"].$patch({ param: { id }, json: change })),
      onSettled: refresh,
    }),
    removeRow: useMutation({
      mutationFn: async (id: string) => {
        const res = await api["patch-rows"][":id"].$delete({ param: { id } });
        if (!res.ok) await json(res);
      },
      onSettled: refresh,
    }),
  };
}

/** A project's repertoire and venues (#48), with the tracks a work may hold. */
export const repertoireQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["projects", projectId, "repertoire"],
    queryFn: async () =>
      json<{
        works: Work[];
        venues: Venue[];
        tracks: { id: string; name: string }[];
        scores: { id: string; name: string }[];
      }>(await api.projects[":id"].repertoire.$get({ param: { id: projectId } })),
  });

/** Adding, changing and removing works and venues. */
export function useRepertoire(projectId: string) {
  const client = useQueryClient();
  const refresh = () =>
    void client.invalidateQueries({ queryKey: repertoireQuery(projectId).queryKey });
  const removed = async (res: Response) => {
    if (!res.ok) await json(res);
  };
  return {
    addWork: useMutation({
      mutationFn: async (input: WorkInput) =>
        json(await api.projects[":id"].works.$post({ param: { id: projectId }, json: input })),
      onSettled: refresh,
    }),
    changeWork: useMutation({
      mutationFn: async ({ id, ...input }: WorkInput & { id: string }) =>
        json(await api.works[":id"].$put({ param: { id }, json: input })),
      onSettled: refresh,
    }),
    /** One track's number alone, as typed in place. */
    numberTrack: useMutation({
      mutationFn: async ({
        workId,
        trackId,
        number,
      }: {
        workId: string;
        trackId: string;
        number: string;
      }) =>
        json(
          await api.works[":id"].tracks[":trackId"].$patch({
            param: { id: workId, trackId },
            json: { number },
          }),
        ),
      onSettled: refresh,
    }),
    removeWork: useMutation({
      mutationFn: async (id: string) => removed(await api.works[":id"].$delete({ param: { id } })),
      onSettled: refresh,
    }),
    addVenue: useMutation({
      mutationFn: async (input: VenueInput) =>
        json(await api.projects[":id"].venues.$post({ param: { id: projectId }, json: input })),
      onSettled: refresh,
    }),
    changeVenue: useMutation({
      mutationFn: async ({ id, ...input }: VenueInput & { id: string }) =>
        json(await api.venues[":id"].$put({ param: { id }, json: input })),
      onSettled: refresh,
    }),
    removeVenue: useMutation({
      mutationFn: async (id: string) => removed(await api.venues[":id"].$delete({ param: { id } })),
      onSettled: refresh,
    }),
  };
}

/** A project's schedule (#50), with the works, tracks and venues it refers to. */
export const scheduleQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["projects", projectId, "schedule"],
    queryFn: async () =>
      json<{
        days: ScheduleDay[];
        works: { id: string; title: string; abbreviation: string; trackIds: string[] }[];
        tracks: { id: string; name: string }[];
        venues: { id: string; name: string }[];
      }>(await api.projects[":id"].schedule.$get({ param: { id: projectId } })),
  });

/** Adding, changing, moving, ticking off and removing days and rows. */
export function useSchedule(projectId: string) {
  const client = useQueryClient();
  const refresh = () =>
    void client.invalidateQueries({ queryKey: scheduleQuery(projectId).queryKey });
  const removed = async (res: Response) => {
    if (!res.ok) await json(res);
  };
  return {
    addDay: useMutation({
      mutationFn: async (input: ScheduleDayInput) =>
        json(
          await api.projects[":id"]["schedule-days"].$post({
            param: { id: projectId },
            json: input,
          }),
        ),
      onSettled: refresh,
    }),
    changeDay: useMutation({
      mutationFn: async ({ id, ...input }: ScheduleDayInput & { id: string }) =>
        json(await api["schedule-days"][":id"].$put({ param: { id }, json: input })),
      onSettled: refresh,
    }),
    removeDay: useMutation({
      mutationFn: async (id: string) =>
        removed(await api["schedule-days"][":id"].$delete({ param: { id } })),
      onSettled: refresh,
    }),
    addRow: useMutation({
      mutationFn: async ({
        dayId,
        after,
        ...input
      }: ScheduleRowInput & { dayId: string; after?: string }) =>
        json(
          await api["schedule-days"][":id"].rows.$post({
            param: { id: dayId },
            query: after ? { after } : {},
            json: input,
          }),
        ),
      onSettled: refresh,
    }),
    changeRow: useMutation({
      mutationFn: async ({ id, ...input }: ScheduleRowInput & { id: string }) =>
        json(await api["schedule-rows"][":id"].$put({ param: { id }, json: input })),
      onSettled: refresh,
    }),
    /** Ticked at once on screen, and back if it was not saved. */
    tick: useMutation({
      mutationFn: async ({ id, done }: { id: string; done: boolean }) =>
        json(await api["schedule-rows"][":id"].done.$patch({ param: { id }, json: { done } })),
      onMutate: async ({ id, done }) => {
        const key = scheduleQuery(projectId).queryKey;
        await client.cancelQueries({ queryKey: key });
        client.setQueryData(key, (data) =>
          data
            ? {
                ...data,
                days: data.days.map((d) => ({
                  ...d,
                  rows: d.rows.map((r) => (r.id === id ? { ...r, done } : r)),
                })),
              }
            : data,
        );
      },
      onSettled: refresh,
    }),
    moveRow: useMutation({
      mutationFn: async ({ id, direction }: { id: string; direction: "up" | "down" }) =>
        removed(
          await api["schedule-rows"][":id"].move.$post({ param: { id }, json: { direction } }),
        ),
      onSettled: refresh,
    }),
    removeRow: useMutation({
      mutationFn: async (id: string) =>
        removed(await api["schedule-rows"][":id"].$delete({ param: { id } })),
      onSettled: refresh,
    }),
  };
}

/** A project's personnel (#49), and the members and guests an entry may be linked to. */
export const personnelQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["projects", projectId, "personnel"],
    queryFn: async () =>
      json<{ personnel: Personnel[]; people: LinkablePerson[] }>(
        await api.projects[":id"].personnel.$get({ param: { id: projectId } }),
      ),
  });

/** Adding, changing and removing someone on the production. */
export function usePersonnel(projectId: string) {
  const client = useQueryClient();
  const refresh = () =>
    void client.invalidateQueries({ queryKey: personnelQuery(projectId).queryKey });
  return {
    add: useMutation({
      mutationFn: async (input: PersonnelInput) =>
        json(await api.projects[":id"].personnel.$post({ param: { id: projectId }, json: input })),
      onSettled: refresh,
    }),
    change: useMutation({
      mutationFn: async ({ id, ...input }: PersonnelInput & { id: string }) =>
        json(await api.personnel[":id"].$put({ param: { id }, json: input })),
      onSettled: refresh,
    }),
    remove: useMutation({
      mutationFn: async (id: string) => {
        const res = await api.personnel[":id"].$delete({ param: { id } });
        if (!res.ok) await json(res);
      },
      onSettled: refresh,
    }),
  };
}

/** A project's stage plans (#53), with the patch channels their items may link to. */
export const stagePlansQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["projects", projectId, "stage-plans"],
    queryFn: async () =>
      json<{ plans: StagePlan[]; channels: PatchedChannel[]; people: StagePerson[] }>(
        await api.projects[":id"]["stage-plans"].$get({ param: { id: projectId } }),
      ),
  });

/** Adding, resizing and removing stage plans, and sending a step on one. */
export function useStagePlans(projectId: string) {
  const client = useQueryClient();
  const key = stagePlansQuery(projectId).queryKey;
  const refresh = () => void client.invalidateQueries({ queryKey: key });
  return {
    addPlan: useMutation({
      mutationFn: async (input: StagePlanInput) =>
        (
          await json<{ plan: StagePlan }>(
            await api.projects[":id"]["stage-plans"].$post({
              param: { id: projectId },
              json: input,
            }),
          )
        ).plan,
      onSettled: refresh,
    }),
    changePlan: useMutation({
      mutationFn: async ({
        id,
        ...change
      }: Partial<StagePlanInput> & { id: string; underlay?: UnderlayInput | null }) =>
        json(await api["stage-plans"][":id"].$patch({ param: { id }, json: change })),
      onSettled: refresh,
    }),
    removePlan: useMutation({
      mutationFn: async (id: string) => {
        const res = await api["stage-plans"][":id"].$delete({ param: { id } });
        if (!res.ok) await json(res);
      },
      onSettled: refresh,
    }),
    /** What the server holds now, fetched afresh: after a step it refused, the editor starts again from it. */
    reload: async (): Promise<StagePlan[]> =>
      (await client.fetchQuery({ ...stagePlansQuery(projectId), staleTime: 0 })).plans,
    /** One step, as the editor already shows it: what the server holds after it. */
    sendStep: async (planId: string, step: StageEdit): Promise<StageItem[]> =>
      (
        await json<{ items: StageItem[] }>(
          await api["stage-plans"][":id"].edits.$post({ param: { id: planId }, json: step }),
        )
      ).items,
    refresh,
  };
}

/** A track's score marks (#52): the marks, the project's categories and the edit plot. */
export const scoreMarksQuery = (trackId: string) =>
  queryOptions({
    queryKey: ["tracks", trackId, "score-marks"],
    queryFn: async () =>
      json<{
        marks: ScoreMark[];
        categories: ScoreMarkCategory[];
        plot: EditPlot;
        /** The PDF pages the track runs over in its work's score (#48), when they are set. */
        pages: { from: number; to: number } | null;
      }>(await api.tracks[":id"]["score-marks"].$get({ param: { id: trackId } })),
  });

/** Making, changing and rubbing out a track's score marks. */
export function useScoreMarks(trackId: string) {
  const client = useQueryClient();
  const key = scoreMarksQuery(trackId).queryKey;
  const refresh = () => void client.invalidateQueries({ queryKey: key });
  return {
    add: useMutation({
      mutationFn: async (input: ScoreMarkInput) =>
        (
          await json<{ mark: ScoreMark }>(
            await api.tracks[":id"]["score-marks"].$post({ param: { id: trackId }, json: input }),
          )
        ).mark,
      onSettled: refresh,
    }),
    change: useMutation({
      mutationFn: async ({ id, ...change }: ScoreMarkChange & { id: string }) =>
        json(await api["score-marks"][":id"].$patch({ param: { id }, json: change })),
      onMutate: async ({ id, ...change }) => {
        await client.cancelQueries({ queryKey: key });
        client.setQueryData(key, (data) =>
          data
            ? {
                ...data,
                marks: data.marks.map((m) => (m.id === id ? { ...m, ...change } : m)),
              }
            : data,
        );
      },
      onSettled: refresh,
    }),
    remove: useMutation({
      mutationFn: async (id: string) => {
        const res = await api["score-marks"][":id"].$delete({ param: { id } });
        if (!res.ok) await json(res);
      },
      onSettled: refresh,
    }),
  };
}

export function useTakeMutations(trackId: string) {
  const client = useQueryClient();
  const key = trackTakesQuery(trackId).queryKey;
  const refresh = () => {
    void client.invalidateQueries({ queryKey: key });
    void client.invalidateQueries({ queryKey: ["files"] });
    // The edit decisions are matched against the takes, their files, bars and points (#56).
    void client.invalidateQueries({ queryKey: ["tracks", trackId, "edit-decisions"] });
  };
  return {
    add: useMutation({
      mutationFn: async (fileIds: string[]) =>
        (
          await json<{ takes: TakeRow[] }>(
            await api.tracks[":id"].takes.$post({ param: { id: trackId }, json: { fileIds } }),
          )
        ).takes,
      onSuccess: (takes) => {
        client.setQueryData(key, takes);
        refresh();
      },
    }),
    change: useMutation({
      mutationFn: async ({ id, ...change }: TakeChange & { id: string }) =>
        (
          await json<{ take: TakeRow }>(
            await api.takes[":id"].$patch({ param: { id }, json: change }),
          )
        ).take,
      onSuccess: (take) => {
        client.setQueryData(key, (list: TakeRow[] | undefined) =>
          list?.map((t) => (t.id === take.id ? take : t)),
        );
        // A session counts the takes recorded in it; the take's own page shows it.
        void client.invalidateQueries({ queryKey: ["sessions"] });
        void client.invalidateQueries({ queryKey: ["takes", take.id] });
        void client.invalidateQueries({ queryKey: ["projects"], predicate: sessionsKey });
      },
    }),
    remove: useMutation({
      mutationFn: async (id: string) => {
        const res = await api.takes[":id"].$delete({ param: { id } });
        if (!res.ok) await json(res);
      },
      onSuccess: refresh,
    }),
  };
}

export function useTrackMutations(projectId: string) {
  const client = useQueryClient();
  const refresh = (track?: Track) => {
    void client.invalidateQueries({ queryKey: ["projects", projectId, "tracks"] });
    if (track) client.setQueryData(trackQuery(track.id).queryKey, track);
    void client.invalidateQueries({ queryKey: ["files"] });
  };
  return {
    /**
     * Link the track's score, or swap it for another edition (#52): what was placed on the old
     * one follows its bars, and the answer says how much did.
     */
    chooseScore: useMutation({
      mutationFn: async ({ id, scoreFileId }: { id: string; scoreFileId: string | null }) =>
        json<{ track: Track; rehomed?: ScoreRehomed }>(
          await api.tracks[":id"].$patch({ param: { id }, json: { scoreFileId } }),
        ),
      onSuccess: ({ track }) => {
        refresh(track);
        void client.invalidateQueries({ queryKey: ["tracks", track.id] });
      },
    }),
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
      mutationFn: async ({ trackId, ...input }: CreateVersionInput & { trackId: string }) =>
        (
          await json<{ track: Track }>(
            await api.tracks[":id"].versions.$post({ param: { id: trackId }, json: input }),
          )
        ).track,
      onSuccess: (track) => {
        refresh(track);
        void client.invalidateQueries({ queryKey: ["tracks", track.id, "carry"] });
      },
    }),
    addVariation: useMutation({
      mutationFn: async (input: {
        versionId: string;
        fileId: string;
        name: string;
        primary?: boolean;
      }) =>
        (
          await json<{ track: Track }>(
            await api.versions[":id"].variations.$post({
              param: { id: input.versionId },
              json: { fileId: input.fileId, name: input.name, primary: input.primary },
            }),
          )
        ).track,
      onSuccess: refresh,
    }),
    /** A corrected export in place of a variation's file; its threads move with it. */
    // A version's edit decision list, given after it was made, changed or taken off (#56).
    setEdl: useMutation({
      mutationFn: async (input: { versionId: string; fileId: string | null }) =>
        (
          await json<{ track: Track }>(
            await api.versions[":id"].edl.$put({
              param: { id: input.versionId },
              json: { fileId: input.fileId },
            }),
          )
        ).track,
      onSuccess: (track: Track) => {
        refresh(track);
        void client.invalidateQueries({ queryKey: ["tracks", track.id, "edit-decisions"] });
      },
    }),
    replaceFile: useMutation({
      mutationFn: async (input: { variationId: string; fileId: string }) =>
        (
          await json<{ track: Track }>(
            await api.variations[":id"].replace.$post({
              param: { id: input.variationId },
              json: { fileId: input.fileId },
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
    updateVariation: useMutation({
      mutationFn: async ({ id, ...input }: UpdateVariationInput & { id: string }) =>
        (
          await json<{ track: Track }>(
            await api.variations[":id"].$patch({ param: { id }, json: input }),
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
  /** How many have opened it; a share's list line says so (#138). */
  opened: number;
  /** A share's: how many items it shares; null for a review. */
  items: number | null;
  /** A share's: when the last of its people loses access; null while anyone's has no end. */
  until: string | null;
  youReview: boolean;
}

export interface ReviewDetail {
  id: string;
  projectId: string;
  /** Its project's profile, which names its items (#16): deliverables and cuts in video. */
  profile: ProjectProfile;
  kind: ReviewKind;
  title: string;
  message: string | null;
  dueAt: string | null;
  order: "parallel" | "sequence";
  rule: ApprovalRule | null;
  /** With the share rule: the percentage whose approval is enough. */
  share: number | null;
  remind: boolean;
  status: ReviewSummary["status"];
  outcome: ReviewSummary["outcome"];
  /** Who asked for it; null once their account is gone. */
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
  completedAt: string | null;
  /** Who cancelled it, and the reason its reviewers were given. */
  cancelledByName: string | null;
  cancelReason: string | null;
  items: ((
    | { id: string; kind: "file"; fileId: string; name: string; fileKind: string }
    | {
        id: string;
        kind: "track";
        trackId: string;
        name: string;
        follows: "version" | "latest";
        version: { id: string; number: number; variations: string[] } | null;
        fileId: string | null;
      }
  ) & {
    /** Open threads on the item's file; null for guests. */
    openComments: number | null;
  })[];
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
    viewedAt: string | null;
    /** Their latest decision's note, or what they said with their feedback. */
    note: string | null;
    /** Their comments on the items since the review was asked, and the first; members only. */
    comments: { count: number; fileId: string; commentId: string } | null;
    /** For those who manage reviewers, and for the reviewer themselves; otherwise null. */
    permissions: ReviewerPermissions | null;
    /** In a share, for those who run it: how often they played and downloads they took (#138). */
    usage: { plays: number; downloads: number } | null;
  }[];
  decisions: {
    id: string;
    reviewerId: string;
    reviewerName: string | null;
    decision: ReviewDecision;
    note: string | null;
    createdAt: string;
  }[];
  /** Who did what, newest first; members only. */
  activity: ReviewActivity[];
  you: {
    reviewerId: string | null;
    /** The items you have opened. */
    opened: string[];
    active: boolean;
    canDecide: boolean;
    canSubmit: boolean;
    canManage: boolean;
    canManageReviewers: boolean;
    /** Their grant lets them invite others by email (#55). */
    canInvite: boolean;
    guest: boolean;
    /** What you may do here, when you are a reviewer of it. */
    permissions: ReviewerPermissions | null;
  };
}

export interface ReviewActivity {
  id: string;
  action:
    | "review.create"
    | "review.decision"
    | "review.submit"
    | "review.cancel"
    | "review.remind"
    | "review.due"
    | "review.reviewer_add"
    | "review.reviewer_remove"
    | "guest.link"
    | "guest.view"
    | "guest.revoke";
  name: string;
  at: string;
  decision: ReviewDecision | null;
  /** Who it concerned: the reviewer added, removed, reminded or revoked. */
  subject: string | null;
  note: string | null;
  dueAt: string | null;
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

/** A guest the project has asked before, to ask again without typing their address. */
export interface KnownGuest {
  id: string;
  name: string;
  email: string;
  label: string | null;
  /** This project's reviews that ask them, and how many of those are open. */
  reviews: number;
  openReviews: number;
  /** When they were last sent a link, anywhere in the workspace. */
  lastLinkAt: string | null;
  /** Whether a link or a signed-in browser still works for them. */
  live: boolean;
}

export const projectGuestsQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["projects", projectId, "guests"],
    queryFn: async () =>
      (
        await json<{ guests: KnownGuest[] }>(
          await api.projects[":id"].guests.$get({ param: { id: projectId } }),
        )
      ).guests,
  });

/** Act on one of a project's guests from its People page. */
export function useProjectGuestMutations(projectId: string) {
  const client = useQueryClient();
  const refresh = () =>
    client.invalidateQueries({ queryKey: projectGuestsQuery(projectId).queryKey });
  const ok = async (res: Response) => {
    if (!res.ok) await json(res);
  };
  const param = (guestId: string) => ({ id: projectId, guestId });
  return {
    sendLink: useMutation({
      mutationFn: async (guestId: string) =>
        ok(await api.projects[":id"].guests[":guestId"].link.$post({ param: param(guestId) })),
      onSuccess: refresh,
    }),
    relabel: useMutation({
      mutationFn: async ({ guestId, label }: { guestId: string; label: string | null }) =>
        ok(
          await api.projects[":id"].guests[":guestId"].$patch({
            param: param(guestId),
            json: { label },
          }),
        ),
      onSuccess: () => {
        void refresh();
        void client.invalidateQueries({ queryKey: ["projects", projectId, "groups"] });
      },
    }),
    revoke: useMutation({
      mutationFn: async (guestId: string) =>
        ok(await api.projects[":id"].guests[":guestId"].revoke.$post({ param: param(guestId) })),
      onSuccess: refresh,
    }),
  };
}

/** What the project's People page says each person may do in its reviews (#55). */
export interface StandingGrantRow {
  userId: string | null;
  guestId: string | null;
  grant: StandingGrant;
}

export const projectReviewerGrantsQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["projects", projectId, "reviewer-grants"],
    queryFn: async () =>
      (
        await json<{ grants: StandingGrantRow[] }>(
          await api.projects[":id"]["reviewer-grants"].$get({ param: { id: projectId } }),
        )
      ).grants,
  });

/** Set or clear what one person may do in every review of a project (#55). */
export function useProjectReviewerGrant(projectId: string) {
  const client = useQueryClient();
  const refresh = () =>
    client.invalidateQueries({ queryKey: projectReviewerGrantsQuery(projectId).queryKey });
  const ok = async (res: Response) => {
    if (!res.ok) await json(res);
  };
  type Person = { kind: "member" | "guest"; personId: string };
  return {
    set: useMutation({
      mutationFn: async ({ kind, personId, grant }: Person & { grant: StandingGrant }) =>
        ok(
          await api.projects[":id"]["reviewer-grants"][":kind"][":personId"].$put({
            param: { id: projectId, kind, personId },
            json: grant,
          }),
        ),
      onSuccess: refresh,
    }),
    clear: useMutation({
      mutationFn: async ({ kind, personId }: Person) =>
        ok(
          await api.projects[":id"]["reviewer-grants"][":kind"][":personId"].$delete({
            param: { id: projectId, kind, personId },
          }),
        ),
      onSuccess: refresh,
    }),
  };
}

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
      mutationFn: async (input: { note?: string } = {}) =>
        call(await api.reviews[":id"].submit.$post({ param: { id: reviewId }, json: input })),
      onSuccess: settle,
    }),
    cancel: useMutation({
      mutationFn: async (input: { reason?: string } = {}) =>
        call(await api.reviews[":id"].cancel.$post({ param: { id: reviewId }, json: input })),
      onSuccess: settle,
    }),
    /** Move the due date, or take it away. */
    due: useMutation({
      mutationFn: async (dueAt: string | null) =>
        call(await api.reviews[":id"].$patch({ param: { id: reviewId }, json: { dueAt } })),
      onSuccess: settle,
    }),
    /** Remind everyone the review waits on, or one reviewer; returns how many were told. */
    remind: useMutation({
      mutationFn: async (reviewerId?: string) =>
        (
          await json<{ reminded: number }>(
            await api.reviews[":id"].remind.$post({
              param: { id: reviewId },
              json: reviewerId ? { reviewerId } : {},
            }),
          )
        ).reminded,
      onSuccess: () => void client.invalidateQueries({ queryKey: reviewQuery(reviewId).queryKey }),
    }),
    /** Take a reviewer who has not responded off the review. */
    removeReviewer: useMutation({
      mutationFn: async (reviewerId: string) =>
        call(
          await api.reviews[":id"].reviewers[":reviewerId"].$delete({
            param: { id: reviewId, reviewerId },
          }),
        ),
      onSuccess: settle,
    }),
    addReviewer: useMutation({
      mutationFn: async (input: { userId: string } | { groupId: string } | GuestInput) =>
        call(await api.reviews[":id"].reviewers.$post({ param: { id: reviewId }, json: input })),
      onSuccess: settle,
    }),
    /** As a reviewer allowed to, invite someone by email (#55). */
    invite: useMutation({
      mutationFn: async (input: GuestInput) =>
        call(await api.reviews[":id"].invite.$post({ param: { id: reviewId }, json: input })),
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
  /** The workspace's logo and accent (#185). */
  branding: PublicBranding | null;
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

/** A passkey or hardware security key, as the account page lists it. */
export interface PasskeyRow {
  id: string;
  name: string | null;
  /** "singleDevice" for a hardware key, "multiDevice" for a passkey that syncs. */
  deviceType: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export const passkeysQuery = queryOptions({
  queryKey: ["me", "passkeys"],
  queryFn: async () => json<{ passkeys: PasskeyRow[]; max: number }>(await api.me.passkeys.$get()),
});

/** Delete the signed-in account: its address typed out, and its password. */
/** How deleting this account is confirmed: a password, or a fresh sign-in (#37). */
export const deletionQuery = queryOptions({
  queryKey: ["me", "deletion"],
  queryFn: async () => json<DeletionConfirmation>(await api.me.deletion.$get()),
});

export function useDeleteAccount() {
  return useMutation({
    mutationFn: async (input: { email: string; password?: string }) => {
      const res = await api.me.$delete({ json: input });
      if (res.status !== 204) await json(res);
    },
  });
}

/** A guest signed in: who, and the reviews they are in. */
export type GuestSignedIn = Omit<GuestMe, "guest"> & { guest: { id: string } };
/** Where the workspace asks for a code: one went to this address, shown masked. */
export interface GuestCodeSent {
  verify: "code";
  sentTo: string;
  /** The workspace whose review it opens, and its logo and accent (#185), on the page. */
  organisation: string | null;
  branding: PublicBranding | null;
}

/**
 * Exchange a magic link for a guest session in this browser, or, where the workspace asks
 * for one, have a code sent first.
 */
export function useGuestSignIn() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (token: string) =>
      json<GuestSignedIn | GuestCodeSent>(await api.guest.sessions.$post({ json: { token } })),
    onSuccess: (data) => {
      if (!("verify" in data)) void client.invalidateQueries({ queryKey: ["guest"] });
    },
  });
}

/** The code a guest was sent: another, when asked for, and the one typed. */
export function useGuestCode(token: string) {
  const client = useQueryClient();
  return {
    resend: useMutation({
      mutationFn: async () =>
        json<GuestCodeSent>(await api.guest.sessions.code.$post({ json: { token } })),
    }),
    verify: useMutation({
      mutationFn: async (code: string) =>
        json<GuestSignedIn>(await api.guest.sessions.verify.$post({ json: { token, code } })),
      onSuccess: () => client.invalidateQueries({ queryKey: ["guest"] }),
    }),
  };
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
  // A group can bring guests into the project's reviewers, or leave them out of it.
  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: ["projects", projectId, "groups"] }),
      client.invalidateQueries({ queryKey: ["projects", projectId, "guests"] }),
    ]);
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
    /** Makes one file the next version of another, in its chain (#149). */
    nextVersion: useMutation({
      mutationFn: async ({ id, fileId }: { id: string; fileId: string }) =>
        json(await api.files[":id"].next.$post({ param: { id }, json: { fileId } })),
      onSuccess: (_, { id, fileId }) =>
        Promise.all([
          refresh(),
          // The chain both files show; not what hangs below them, such as their comments.
          client.invalidateQueries({ queryKey: ["files", id], exact: true }),
          client.invalidateQueries({ queryKey: ["files", fileId], exact: true }),
        ]),
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

/** Following a track or a review by choice (#110), as adding a version or being asked already does. */
export function useFollow() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: FollowInput) => {
      const res = await api.notifications.follows.$post({ json: input });
      if (!res.ok) await json(res);
    },
    onSuccess: () => client.invalidateQueries({ queryKey: followsQuery.queryKey }),
  });
}

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
  /** Its name, a workspace's own profile included. */
  deliveryProfileLabel: string | null;
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
    // One save at a time, in order, so an earlier layout never lands after a later one.
    scope: { id: "file-columns" },
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

/** Everything known about one file, for its details sheet. */
export interface FileDetails {
  file: ProjectFile & { projectId: string; pageCount: number | null };
  storage: {
    backend: string;
    sha256: string | null;
    encrypted: boolean;
    keyVersion: number;
    keySince: string | null;
  };
  renditions: {
    name: string;
    codecs: string;
    bandwidth: number;
    width: number | null;
    height: number | null;
    segments: number;
  }[];
  pages: { total: number; drawn: number } | null;
  /** How many frames the video's filmstrip holds (#16); null where it has none. */
  filmstrip: number | null;
  analysis: { status: StreamStatus; peaks: boolean; loudness: boolean; spectrogram: boolean };
  usedIn: {
    versions: {
      trackId: string;
      track: string;
      number: number;
      variation: string;
      primary: boolean;
      latest: boolean;
    }[];
    /** The take it is, for those who may see takes. */
    take: { number: number; label: string | null; trackId: string; track: string } | null;
    reviews: { id: string; title: string; status: "open" | "completed" | "cancelled" }[];
  };
  can: { organise: boolean; upload: boolean; log: boolean; delete: boolean };
}

export const fileDetailsQuery = (fileId: string) =>
  queryOptions({
    queryKey: ["files", fileId, "details"],
    queryFn: async () =>
      json<FileDetails>(await api.files[":id"].details.$get({ param: { id: fileId } })),
  });

/** A video's or a recording's caption tracks (#146, #201), cues and all. */
export const captionsQuery = (fileId: string) =>
  queryOptions({
    queryKey: ["files", fileId, "captions"],
    queryFn: async () =>
      (
        await json<{ captions: CaptionTrack[] }>(
          await api.files[":id"].captions.$get({ param: { id: fileId } }),
        )
      ).captions,
  });

/**
 * Where a track exports from (#201): written afresh in the format asked for, as an
 * attachment, logged. Opened by a link, so the browser saves it as it arrives.
 */
export const captionExportHref = (fileId: string, captionId: string, format: CaptionFormat) =>
  `/api/files/${fileId}/captions/${captionId}/export?format=${format}`;

/** Saves a track as a sidecar file, from a menu where there is no link to follow. */
export function exportCaptions(fileId: string, captionId: string, format: CaptionFormat) {
  const link = document.createElement("a");
  link.href = captionExportHref(fileId, captionId, format);
  link.download = "";
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
}

/**
 * Adding a caption track to a video or a recording, named for the player's menu with its
 * language and kind; renaming one or saying them again; removing one.
 */
export function useCaptionMutations(fileId: string) {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: ["files", fileId, "captions"] });
  return {
    add: useMutation({
      mutationFn: async ({
        file,
        label,
        language,
        kind,
      }: {
        file: File;
        label: string;
        language: string | null;
        kind: CaptionKind;
      }) => {
        const query = new URLSearchParams({ label, kind, ...(language ? { language } : {}) });
        return json<{ caption: CaptionTrack }>(
          await fetch(`/api/files/${fileId}/captions?${query}`, {
            method: "POST",
            credentials: "same-origin",
            headers: {
              "content-type": "application/octet-stream",
              "x-file-name": encodeURIComponent(file.name),
            },
            body: file,
          }),
        );
      },
      onSuccess: refresh,
    }),
    update: useMutation({
      mutationFn: async ({ captionId, ...change }: CaptionUpdate & { captionId: string }) =>
        json<{ caption: CaptionTrack }>(
          await api.files[":id"].captions[":captionId"].$patch({
            param: { id: fileId, captionId },
            json: change,
          }),
        ),
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: async (captionId: string) => {
        const res = await api.files[":id"].captions[":captionId"].$delete({
          param: { id: fileId, captionId },
        });
        if (!res.ok) await json(res);
      },
      onSuccess: refresh,
    }),
  };
}

/** Change one's own name, language or time zone. */
export function useUpdateProfile() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: ProfileInput) => {
      const res = await api.me.$patch({ json: input });
      if (!res.ok) await json(res);
    },
    onSuccess: () => client.invalidateQueries({ queryKey: meQuery.queryKey }),
  });
}

export interface SignedInSession {
  id: string;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  lastUsedAt: string;
  current: boolean;
}

export const sessionsQuery = queryOptions({
  queryKey: ["me", "sessions"],
  queryFn: async () =>
    (await json<{ sessions: SignedInSession[] }>(await api.me.sessions.$get())).sessions,
});

/** Sign out one other session, or (with no id) every other one. */
export function useSignOutSession() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (id?: string) => {
      const res = id
        ? await api.me.sessions[":id"].$delete({ param: { id } })
        : await api.me.sessions.$delete();
      if (!res.ok) await json(res);
    },
    onSuccess: () => client.invalidateQueries({ queryKey: sessionsQuery.queryKey }),
  });
}

/** The signed-in member's preferences; the defaults for guests and while loading. */
export function usePreferences(): Preferences {
  const { data: me } = useQuery(meQuery);
  return me?.user.preferences ?? defaultPreferences;
}

/** Change some preferences: shown at once, put back if refused. */
export function useSavePreferences() {
  const client = useQueryClient();
  const key = meQuery.queryKey;
  return useMutation({
    scope: { id: "preferences" },
    mutationFn: async (change: Partial<Preferences>) => {
      const res = await api.me.preferences.$patch({ json: change });
      if (!res.ok) await json(res);
    },
    onMutate: async (change) => {
      await client.cancelQueries({ queryKey: key });
      const before = client.getQueryData(key);
      client.setQueryData(key, (me) =>
        me
          ? {
              ...me,
              user: {
                ...me.user,
                preferences: { ...(me.user.preferences ?? defaultPreferences), ...change },
              },
            }
          : me,
      );
      return { before };
    },
    onError: (_e, _c, ctx) => client.setQueryData(key, ctx?.before),
  });
}

/**
 * Who the viewer is on the instance side (#155): operator, owner of some workspaces, or
 * neither (null), in which case the instance side is not offered.
 */
export const instanceAccessQuery = queryOptions({
  queryKey: ["instance", "me"],
  queryFn: async () => {
    const res = await api.instance.me.$get();
    if (res.status === 403) return null;
    return json<InstanceAccess>(res);
  },
  staleTime: 60_000,
});

export const instanceOverviewQuery = queryOptions({
  queryKey: ["instance", "overview"],
  queryFn: async () => json<InstanceOverview>(await api.instance.overview.$get()),
});

/** The workspaces on the instance, a page at a time, found by name or subdomain. */
export const instanceWorkspacesQuery = (filters: { q?: string; state?: WorkspaceState }) =>
  infiniteQueryOptions({
    queryKey: ["instance", "workspaces", filters],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const query: Record<string, string> = { limit: "50" };
      if (filters.q) query.q = filters.q;
      if (filters.state) query.state = filters.state;
      if (pageParam) query.after = pageParam;
      return json<InstanceWorkspacePage>(await api.instance.workspaces.$get({ query }));
    },
    getNextPageParam: (page) => page.next ?? undefined,
  });

export const instanceWorkspaceQuery = (id: string) =>
  queryOptions({
    queryKey: ["instance", "workspace", id],
    queryFn: async () =>
      json<InstanceWorkspaceDetail>(await api.instance.workspaces[":id"].$get({ param: { id } })),
  });

export const instanceMembersQuery = (id: string) =>
  queryOptions({
    queryKey: ["instance", "workspace", id, "members"],
    queryFn: async () =>
      (
        await json<{ members: InstanceMemberRow[] }>(
          await api.instance.workspaces[":id"].members.$get({ param: { id } }),
        )
      ).members,
  });

export const instanceStorageQuery = (id: string) =>
  queryOptions({
    queryKey: ["instance", "workspace", id, "storage"],
    queryFn: async () =>
      json<InstanceWorkspaceStorage>(
        await api.instance.workspaces[":id"].storage.$get({ param: { id } }),
      ),
  });

/** An operator sets a workspace's limits (#175); its Storage tab reads them again. */
export function useWorkspaceLimits(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (limits: WorkspaceLimits) =>
      json<WorkspaceUsage>(
        await api.instance.workspaces[":id"].limits.$put({ param: { id }, json: limits }),
      ),
    onSuccess: () => client.invalidateQueries({ queryKey: ["instance"] }),
  });
}

/** The instance's Billing overview (#180): what workspaces pay and owe. */
export const instanceBillingQuery = queryOptions({
  queryKey: ["instance", "billing", "overview"],
  queryFn: async () => json<BillingOverview>(await api.instance.billing.overview.$get()),
});

/** How the instance takes payment (#180): the gateway's account, its webhook's health. */
export const instanceGatewayQuery = queryOptions({
  queryKey: ["instance", "billing", "gateway"],
  queryFn: async () => json<BillingGatewayStatus>(await api.instance.billing.gateway.$get()),
});

/** The instance's Billing reports (#180), in its currency. */
export const instanceReportsQuery = queryOptions({
  queryKey: ["instance", "billing", "reports"],
  queryFn: async () => json<BillingReports>(await api.instance.billing.reports.$get()),
});

/** Save the instance's settings whole, as the Settings page and billing's rules do. */
export function useSaveInstanceSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (next: InstanceSettings) =>
      json<{ settings: InstanceSettings; environment: InstanceEnvironment }>(
        await api.instance.settings.$put({ json: next }),
      ),
    onSuccess: (next) => client.setQueryData(instanceOwnSettingsQuery.queryKey, next),
  });
}

/** The instance's plans (#177), for its operators. */
export const instancePlansQuery = queryOptions({
  queryKey: ["instance", "billing", "plans"],
  queryFn: async () =>
    json<{ plans: InstancePlan[]; billing: boolean }>(await api.instance.plans.$get()),
});

export function useSavePlan() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, input }: { id?: string; input: PlanInput }) =>
      json<{ plans: InstancePlan[] }>(
        id
          ? await api.instance.plans[":id"].$put({ param: { id }, json: input })
          : await api.instance.plans.$post({ json: input }),
      ),
    onSuccess: () => client.invalidateQueries({ queryKey: ["instance"] }),
  });
}

export function useRetirePlan() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await api.instance.plans[":id"].retire.$post({ param: { id } });
      if (!res.ok) await json(res);
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ["instance"] }),
  });
}

/** The instance's promo codes (#178). */
export const instancePromosQuery = queryOptions({
  queryKey: ["instance", "billing", "promos"],
  queryFn: async () => json<{ promos: PromoCode[] }>(await api.instance.promos.$get()),
});

export const promoUsesQuery = (id: string) =>
  queryOptions({
    queryKey: ["instance", "billing", "promos", id, "uses"],
    queryFn: async () =>
      json<{
        uses: {
          workspace: { id: string; name: string };
          plan: string | null;
          status: "held" | "taken" | "released";
          at: string;
        }[];
      }>(await api.instance.promos[":id"].uses.$get({ param: { id } })),
  });

export function useSavePromo() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, input }: { id?: string; input: PromoCodeInput }) =>
      json<{ promo: PromoCode }>(
        id
          ? await api.instance.promos[":id"].$put({ param: { id }, json: input })
          : await api.instance.promos.$post({ json: input }),
      ),
    onSuccess: () => client.invalidateQueries({ queryKey: ["instance", "billing"] }),
  });
}

export function useEndPromo() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      json<{ promo: PromoCode }>(await api.instance.promos[":id"].end.$post({ param: { id } })),
    onSuccess: () => client.invalidateQueries({ queryKey: ["instance", "billing"] }),
  });
}

/** An operator puts a workspace on a plan (#177, #180). */
export function usePutWorkspacePlan(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { planId: string | null }) =>
      json<WorkspacePlan>(
        await api.instance.workspaces[":id"].plan.$put({ param: { id }, json: input }),
      ),
    onSuccess: () => client.invalidateQueries({ queryKey: ["instance"] }),
  });
}

/** Waive what a workspace owes (#180). */
export function useWaive(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (reason: string) =>
      json<{ voided: number; reinstated: boolean }>(
        await api.instance.workspaces[":id"].waive.$post({ param: { id }, json: { reason } }),
      ),
    onSuccess: () => client.invalidateQueries({ queryKey: ["instance"] }),
  });
}

/** Apply one of the instance's codes to a workspace's subscription (#445). */
export function useApplyPromo(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (code: string) =>
      json<{ code: string; plan: string }>(
        await api.instance.workspaces[":id"].promo.$post({ param: { id }, json: { code } }),
      ),
    onSuccess: () => client.invalidateQueries({ queryKey: ["instance", "billing"] }),
  });
}

/** A credit toward what a workspace next owes (#445). */
export function useIssueCredit(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreditInput) =>
      json<{ credit: BillingCredit }>(
        await api.instance.workspaces[":id"].credits.$post({ param: { id }, json: input }),
      ),
    onSuccess: () => client.invalidateQueries({ queryKey: ["instance", "billing"] }),
  });
}

/** Send a workspace's owners its latest invoice again (#445). */
export function useSendLatestInvoice(id: string) {
  return useMutation({
    mutationFn: async () =>
      json<{ number: string | null; sent: number }>(
        await api.instance.workspaces[":id"].invoices.latest.send.$post({ param: { id } }),
      ),
  });
}

export const instanceSettingsQuery = (id: string) =>
  queryOptions({
    queryKey: ["instance", "workspace", id, "settings"],
    queryFn: async () =>
      json<InstanceWorkspaceSettings>(
        await api.instance.workspaces[":id"].settings.$get({ param: { id } }),
      ),
  });

export const instanceKeysQuery = (id: string) =>
  queryOptions({
    queryKey: ["instance", "workspace", id, "keys"],
    queryFn: async () =>
      json<InstanceWorkspaceKeys>(
        await api.instance.workspaces[":id"].keys.$get({ param: { id } }),
      ),
    // While a rewrap runs, its progress shows.
    refetchInterval: (q) => ((q.state.data?.pending ?? 0) > 0 ? 5000 : false),
  });

/** An operator moves a project to another workspace (#240), confirmed with its name and their password. */
export function useOperatorMove(workspaceId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({
      projectId,
      ...input
    }: {
      projectId: string;
      to: string;
      name: string;
      password?: string;
    }) => {
      const res = await api.instance.workspaces[":id"].projects[":projectId"].move.$post({
        param: { id: workspaceId, projectId },
        json: input,
      });
      if (!res.ok) await json(res);
    },
    onSuccess: () => void client.invalidateQueries({ queryKey: ["instance"] }),
  });
}

export const instanceProjectsQuery = (id: string) =>
  queryOptions({
    queryKey: ["instance", "workspace", id, "projects"],
    queryFn: async () =>
      (
        await json<{ projects: InstanceProjectRow[] }>(
          await api.instance.workspaces[":id"].projects.$get({ param: { id } }),
        )
      ).projects,
  });

/** What failed since a moment, a day ago by this browser's clock (#159). */
export const instanceErrorsQuery = (since: string) =>
  queryOptions({
    queryKey: ["instance", "errors", "since", since],
    queryFn: async () =>
      (
        await json<{ errors: ErrorReportRow[] }>(
          await api.instance.errors.$get({ query: { since } }),
        )
      ).errors,
  });

/** The whole story behind a reference; null when none has it. */
export const instanceErrorQuery = (reference: string) =>
  queryOptions({
    queryKey: ["instance", "errors", reference],
    queryFn: async () => {
      const res = await api.instance.errors[":reference"].$get({ param: { reference } });
      if (res.status === 404) return null;
      return json<ErrorReport>(res);
    },
  });

/** The instance's settings (#160), and what the environment sets beside them. */
export const instanceOwnSettingsQuery = queryOptions({
  queryKey: ["instance", "own-settings"],
  queryFn: async () =>
    json<{ settings: InstanceSettings; environment: InstanceEnvironment }>(
      await api.instance.settings.$get(),
    ),
});

/** System information (#158): the release running, newer releases, the environment. */
export const instanceSystemQuery = queryOptions({
  queryKey: ["instance", "system"],
  queryFn: async () => json<SystemInformation>(await api.instance.system.$get()),
});

/** The instance's filters for a log (#157), as the query string has them. */
export function logQueryString(filters: { q?: string; range: LogRange; workspace?: string }) {
  const query: Record<string, string> = { range: filters.range };
  if (filters.q) query.q = filters.q;
  if (filters.workspace) query.workspace = filters.workspace;
  return query;
}

/** One of the instance's logs (#157), newest first, a page at a time. */
export const instanceLogQuery = <K extends LogKind>(
  kind: K,
  filters: { q?: string; range: LogRange; workspace?: string },
) =>
  infiniteQueryOptions({
    queryKey: ["instance", "logs", kind, filters],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const query: Record<string, string> = { ...logQueryString(filters), limit: "50" };
      if (pageParam) query.before = pageParam;
      return json<LogPage<K>>(await api.instance.logs[":kind"].$get({ param: { kind }, query }));
    },
    getNextPageParam: (last) => last.next ?? undefined,
  });

/** System health (#156): the machine now, a range's minutes, services and metrics. */
export const instanceHealthQuery = (range: HealthRange) =>
  queryOptions({
    queryKey: ["instance", "health", range],
    queryFn: async () => json<SystemHealth>(await api.instance.health.$get({ query: { range } })),
    // Services are checked every 15 seconds; so is the page.
    refetchInterval: 15_000,
  });

/** The instance's queues (decision 250), read every five seconds while the page is open. */
export const instanceQueuesQuery = queryOptions({
  queryKey: ["instance", "queues"],
  queryFn: async () => json<QueuesView>(await api.instance.queues.$get()),
  refetchInterval: 5_000,
});

/** One job in full, for its Details. */
export const instanceQueueJobQuery = (name: string, id: string) =>
  queryOptions({
    queryKey: ["instance", "queues", name, "jobs", id],
    queryFn: async () =>
      json<QueueJobDetail>(
        await api.instance.queues[":name"].jobs[":id"].$get({ param: { name, id } }),
      ),
  });

/** What everyone is told about the instance: maintenance mode's notice (#154). */
export const noticeQuery = queryOptions({
  queryKey: ["notice"],
  queryFn: async () => json<InstanceNotice>(await api.notice.$get()),
  // Read again every minute, so a notice turned on or off reaches someone already here.
  refetchInterval: 60_000,
  staleTime: 30_000,
});

/** The instance's flags (#159). */
export const instanceFlagsQuery = queryOptions({
  queryKey: ["instance", "flags"],
  queryFn: async () =>
    (await json<{ flags: InstanceFlag[] }>(await api.instance.flags.$get())).flags,
});

/**
 * Debug tools' inspectors (#159). Each look is recorded on the server, so a result is kept
 * while it is shown rather than fetched again on focus, and each press of Inspect (`look`)
 * is a new look, fetched and recorded again.
 */
export type Inspection =
  | { kind: "file"; found: FileInspection }
  | { kind: "run"; found: WorkflowRunInspection }
  | { kind: "review"; found: ReviewInspection }
  | { kind: "session"; found: SessionInspection };

export const instanceInspectQuery = (kind: InspectKind, id: string, look: number) =>
  queryOptions({
    queryKey: ["instance", "inspect", kind, id, look],
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    queryFn: async (): Promise<Inspection | null> => {
      const param = { param: { id } };
      const inspect = api.instance.inspect;
      const res =
        kind === "file"
          ? await inspect.file[":id"].$get(param)
          : kind === "run"
            ? await inspect.run[":id"].$get(param)
            : kind === "review"
              ? await inspect.review[":id"].$get(param)
              : await inspect.session[":id"].$get(param);
      if (res.status === 404) return null;
      return { kind, found: await json(res) } as Inspection;
    },
  });

export const instanceOperatorsQuery = queryOptions({
  queryKey: ["instance", "operators"],
  queryFn: async () =>
    (await json<{ operators: OperatorRow[] }>(await api.instance.operators.$get())).operators,
});

/** One side of a comparison: a version, heard through its primary variation. */
export interface CompareSide {
  versionId: string;
  number: number;
  notes: string | null;
  fileId: string;
  name: string;
  ready: boolean;
  /** Its stream could not be made, so it cannot be heard. */
  failed: boolean;
  /** Seconds, once measured. */
  duration: number | null;
}

/** Two versions of a track side by side (#137), as the server lines them up. */
export interface TrackComparison {
  track: { id: string; name: string; projectId: string };
  versions: { number: number; name: string }[];
  a: CompareSide;
  b: CompareSide;
  alignment: CompareAlignment;
  findings: { measured: boolean; laterNumber: number; fixed: QaFinding[]; new: QaFinding[] };
  /** A's open threads at a moment, and where that falls in B once aligned. */
  comments: { id: string; body: string; start: number; mapped: number | null }[];
}

export const trackCompareQuery = (trackId: string, a?: number, b?: number) =>
  queryOptions({
    queryKey: ["tracks", trackId, "compare", a ?? null, b ?? null],
    queryFn: async () =>
      json<TrackComparison>(
        await api.tracks[":id"].compare.$get({
          param: { id: trackId },
          query: {
            ...(a ? { a: String(a) } : {}),
            ...(b ? { b: String(b) } : {}),
          },
        }),
      ),
    // While the music is being lined up, or a version made ready to play, look again now and then.
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return false;
      const waiting = [data.a, data.b].some((side) => !side.ready && !side.failed);
      return data.alignment.status === "aligning" || waiting ? 4000 : false;
    },
  });

/** Work out again where the music sits between two versions. */
export function useRealign(trackId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { a: number; b: number }) =>
      json<{ queued: number }>(
        await api.tracks[":id"].compare.realign.$post({ param: { id: trackId }, json: input }),
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["tracks", trackId, "compare"] }),
  });
}

/** A project's workflows (#25, #26): its own, then the tracks' own, each with what it breaks. */
export const projectWorkflowsQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["projects", projectId, "workflows"],
    queryFn: async () =>
      (
        await json<{ workflows: WorkflowSummary[] }>(
          await api.projects[":id"].workflows.$get({ param: { id: projectId } }),
        )
      ).workflows,
  });

/**
 * Making, changing and removing a project's workflows (#26). A change is worked out from the
 * workflow as it stands when its turn comes, and carries the version it was made from: changes
 * run one at a time, so each builds on the last, and one made over someone else's is refused.
 */
export function useWorkflowMutations(projectId: string) {
  const client = useQueryClient();
  const key = projectWorkflowsQuery(projectId).queryKey;
  const put = (workflow: WorkflowSummary) =>
    client.setQueryData(key, (list) =>
      list?.some((w) => w.id === workflow.id)
        ? list.map((w) => (w.id === workflow.id ? workflow : w))
        : [...(list ?? []), workflow],
    );
  return {
    create: useMutation({
      mutationFn: async (input: WorkflowInput) =>
        (
          await json<{ workflow: WorkflowSummary }>(
            await api.projects[":id"].workflows.$post({ param: { id: projectId }, json: input }),
          )
        ).workflow,
      onSuccess: put,
    }),
    change: useMutation({
      scope: { id: `project-workflows-${projectId}` },
      mutationFn: async ({
        id,
        change,
      }: {
        id: string;
        change: (current: WorkflowSummary) => Omit<WorkflowChange, "version">;
      }) => {
        const current = client.getQueryData(key)?.find((w) => w.id === id);
        if (!current) throw new Error("That workflow is no longer here");
        return (
          await json<{ workflow: WorkflowSummary }>(
            await api.workflows[":id"].$patch({
              param: { id },
              json: { ...change(current), version: current.version },
            }),
          )
        ).workflow;
      },
      onSuccess: put,
      // Refused (someone else's change came first, or it cannot run): show it as it is now.
      onError: () => client.invalidateQueries({ queryKey: key }),
    }),
    remove: useMutation({
      mutationFn: async (id: string) => {
        const res = await api.workflows[":id"].$delete({ param: { id } });
        if (!res.ok) await json(res);
      },
      onSuccess: (_done, id) =>
        client.setQueryData(key, (list) => list?.filter((w) => w.id !== id)),
    }),
  };
}

/** A project's tasks (#140), in the list's order, and whom one may be given to. */
export const projectTasksQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["projects", projectId, "tasks"],
    queryFn: async () =>
      json<{ tasks: TaskSummary[]; people: { id: string; name: string }[] }>(
        await api.projects[":id"].tasks.$get({ param: { id: projectId } }),
      ),
  });

/** One task in full: the comment it came from and its activity. */
export const taskQuery = (taskId: string) =>
  queryOptions({
    queryKey: ["tasks", taskId],
    queryFn: async () =>
      (await json<{ task: TaskDetail }>(await api.tasks[":id"].$get({ param: { id: taskId } })))
        .task,
  });

/** Making, changing, noting and deleting a project's tasks. */
export function useTaskMutations(projectId: string) {
  const client = useQueryClient();
  const refresh = (task?: TaskDetail) => {
    void client.invalidateQueries({ queryKey: projectTasksQuery(projectId).queryKey });
    if (task) client.setQueryData(taskQuery(task.id).queryKey, task);
    // A thread's task shows on its comment; a workflow's moves its run on.
    void client.invalidateQueries({ queryKey: ["files"] });
    void client.invalidateQueries({ queryKey: ["tracks"] });
  };
  return {
    create: useMutation({
      mutationFn: async (input: TaskInput) =>
        (
          await json<{ task: TaskDetail }>(
            await api.projects[":id"].tasks.$post({ param: { id: projectId }, json: input }),
          )
        ).task,
      onSuccess: refresh,
    }),
    change: useMutation({
      mutationFn: async ({ id, ...change }: TaskChange & { id: string }) =>
        (
          await json<{ task: TaskDetail }>(
            await api.tasks[":id"].$patch({ param: { id }, json: change }),
          )
        ).task,
      onSuccess: refresh,
    }),
    note: useMutation({
      mutationFn: async ({ id, note }: { id: string; note: string }) =>
        (
          await json<{ task: TaskDetail }>(
            await api.tasks[":id"].notes.$post({ param: { id }, json: { note } }),
          )
        ).task,
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: async (id: string) => {
        const res = await api.tasks[":id"].$delete({ param: { id } });
        if (!res.ok) await json(res);
      },
      onSuccess: () => refresh(),
    }),
  };
}

/** A project's board (#141): its tracks as cards, and the columns of both groupings. */
/** A project's statuses (#26): its set, then any only a step sets. */
export const projectWorkflowStatusesQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["projects", projectId, "workflow-statuses"],
    queryFn: async () =>
      (
        await json<{ statuses: ProjectStatus[] }>(
          await api.projects[":id"]["workflow-statuses"].$get({ param: { id: projectId } }),
        )
      ).statuses,
  });

/** Keeping a project's status set (#26), all of it at once; the board's columns follow. */
export function useSaveWorkflowStatuses(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (statuses: WorkflowStatus[]) =>
      (
        await json<{ statuses: ProjectStatus[] }>(
          await api.projects[":id"]["workflow-statuses"].$put({
            param: { id: projectId },
            json: { statuses },
          }),
        )
      ).statuses,
    onSuccess: (statuses) => {
      client.setQueryData(projectWorkflowStatusesQuery(projectId).queryKey, statuses);
      void client.invalidateQueries({ queryKey: projectBoardQuery(projectId).queryKey });
    },
  });
}

export const projectBoardQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["projects", projectId, "board"],
    queryFn: async () =>
      json<Board>(await api.projects[":id"].board.$get({ param: { id: projectId } })),
    // Transitions made elsewhere (a decision, a stage ended) show within seconds.
    refetchInterval: 15_000,
  });

/**
 * Set the project's own arrangement of its board (decision 256), for those who may manage the
 * project: what everyone sees until they choose theirs.
 */
export function useSetBoardDefault(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (display: BoardDisplay) =>
      (
        await json<{ display: BoardDisplay }>(
          await api.projects[":id"].board.display.$put({
            param: { id: projectId },
            json: { display },
          }),
        )
      ).display,
    onSuccess: (display) =>
      client.setQueryData(projectBoardQuery(projectId).queryKey, (board) =>
        board ? { ...board, display } : board,
      ),
  });
}

/** A month of a project's calendar (#141), and whether the viewer has a feed of it. */
export const projectCalendarQuery = (projectId: string, month: string) =>
  queryOptions({
    queryKey: ["projects", projectId, "calendar", month],
    queryFn: async () =>
      json<{
        events: CalendarEvent[];
        feed: { createdAt: string; readAt: string | null } | null;
      }>(await api.projects[":id"].calendar.$get({ param: { id: projectId }, query: { month } })),
  });

/** Getting a feed of a project's calendar (a new link replacing any before), or stopping it. */
export function useCalendarFeed(projectId: string) {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: ["projects", projectId, "calendar"] });
  return {
    create: useMutation({
      mutationFn: async () =>
        (
          await json<{ url: string }>(
            await api.projects[":id"].calendar.feed.$post({ param: { id: projectId } }),
          )
        ).url,
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: async () => {
        const res = await api.projects[":id"].calendar.feed.$delete({ param: { id: projectId } });
        if (!res.ok) await json(res);
      },
      onSuccess: refresh,
    }),
  };
}

/** An upload request as its project's members see it (#139): never its link, which is shown once. */
export interface UploadRequest {
  id: string;
  projectId: string;
  folderId: string | null;
  /** A track whose next version each file becomes once processed (#425); null for a folder. */
  trackId: string | null;
  name: string;
  wanted: string;
  fileLimit: number;
  expiresAt: string;
  closedAt: string | null;
  hasPassword: boolean;
  createdAt: string;
  arrived: number;
  state: UploadRequestState;
}

export interface UploadRequestArrival {
  fileId: string;
  sender: string;
  arrivedAt: string;
  name: string;
  byteSize: number;
}

export const uploadRequestsQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["projects", projectId, "upload-requests"],
    queryFn: async () =>
      json<{ requests: UploadRequest[] }>(
        await api.projects[":projectId"]["upload-requests"].$get({ param: { projectId } }),
      ),
  });

export const uploadRequestQuery = (id: string) =>
  queryOptions({
    queryKey: ["upload-requests", id],
    queryFn: async () =>
      json<{ request: UploadRequest; arrived: UploadRequestArrival[] }>(
        await api["upload-requests"][":id"].$get({ param: { id } }),
      ),
  });

/** Making an upload request, closing one, or giving it a new link (each link shown once). */
export function useUploadRequests(projectId: string) {
  const client = useQueryClient();
  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: ["projects", projectId, "upload-requests"] }),
      client.invalidateQueries({ queryKey: ["upload-requests"] }),
    ]);
  return {
    create: useMutation({
      mutationFn: async (input: CreateUploadRequestInput) =>
        json<{ request: UploadRequest; link: string }>(
          await api.projects[":projectId"]["upload-requests"].$post({
            param: { projectId },
            json: input,
          }),
        ),
      onSuccess: refresh,
    }),
    close: useMutation({
      mutationFn: async (id: string) =>
        json<{ request: UploadRequest }>(
          await api["upload-requests"][":id"].close.$post({ param: { id } }),
        ),
      onSuccess: refresh,
    }),
    relink: useMutation({
      mutationFn: async (id: string) =>
        (
          await json<{ link: string }>(
            await api["upload-requests"][":id"].link.$post({ param: { id } }),
          )
        ).link,
    }),
  };
}

/** What an upload request's link shows the person sending (#139). */
export interface UploadLinkRequest {
  name: string;
  wanted: string;
  workspace: string;
  fileLimit: number;
  arrived: number;
  expiresAt: string;
  needsPassword: boolean;
  state: UploadRequestState;
}

export const uploadLinkQuery = (token: string) =>
  queryOptions({
    queryKey: ["upload-links", token],
    queryFn: async () =>
      json<{ request: UploadLinkRequest }>(
        await api["upload-links"][":token"].$get({ param: { token } }),
      ),
    retry: false,
  });
