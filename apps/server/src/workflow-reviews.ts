import { type Database, inOrg, schema } from "@hekate/db";
import {
  createReviewInput,
  type GuestInput,
  namedPeople,
  type OrganisationRole,
  type ReviewerInput,
  reviewerKey,
} from "@hekate/shared";
import { and, asc, desc, eq } from "drizzle-orm";
import { recordNotification } from "./notifications.ts";
import { type ReviewDeps, requestReview } from "./routes/reviews.ts";

const {
  groups,
  guests,
  members,
  projectMembers,
  projectRoles,
  reviews,
  tracks,
  versions,
  workflows,
} = schema;

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** The review a stage of a run asked for, still open: what a run cancels when it moves past it. */
export async function cancelStageReview(
  tx: Tx,
  organisationId: string,
  runId: string,
  nodeId: string,
) {
  const now = new Date();
  await tx
    .update(reviews)
    .set({
      status: "cancelled",
      cancelReason: "The workflow that asked for it moved on",
      completedAt: now,
      updatedAt: now,
    })
    .where(
      inOrg(
        reviews,
        organisationId,
        eq(reviews.workflowRunId, runId),
        eq(reviews.workflowNodeId, nodeId),
        eq(reviews.status, "open"),
      ),
    );
}

/** The days a stage gives, as a due date from now; none when it gives none. */
const dueIn = (days: string | undefined) => {
  const n = Number.parseFloat(days ?? "");
  return Number.isFinite(n) && n > 0
    ? new Date(Date.now() + n * 86_400_000).toISOString()
    : undefined;
};

/**
 * Asks for the review an approval or feedback stage stands for (#25, decision 118), or makes
 * the share a share stage stands for (decision 121), as the member the run started with (else
 * whoever made the workflow): of the track's version the run is about, for the people its `who`
 * (a share's `to`) names: roles and groups of the project by name, and guests by name or email
 * (`namedPeople`). A review is asked all at once or in turn, approved when everyone or any one
 * approves, due in its days; a share lasts its days. When it cannot be made (nobody named,
 * nobody to make it as), the run's starter is told why; a review's stage waits to be ended by
 * hand, and a share's run has already carried on.
 */
export async function askForStageReview(
  deps: { db: Database; reviews: ReviewDeps },
  at: {
    organisationId: string;
    projectId: string;
    trackId: string;
    runId: string;
    nodeId: string;
    nodeName: string;
    kind: "approval" | "feedback" | "share";
    config: Record<string, string>;
    versionId: string | null;
    startedBy: string | null;
    workflowId: string | null;
  },
) {
  const { db } = deps;
  const { organisationId, projectId } = at;
  const [made] = at.workflowId
    ? await db
        .select({ createdBy: workflows.createdBy })
        .from(workflows)
        .where(inOrg(workflows, organisationId, eq(workflows.id, at.workflowId)))
    : [];
  const asWho = at.startedBy ?? made?.createdBy ?? null;
  const tell = async (why: string) => {
    if (!asWho) return;
    await recordNotification(db, {
      organisationId,
      kind: "workflow",
      recipients: [asWho],
      actor: null,
      projectId,
      trackId: at.trackId,
      text:
        at.kind === "share"
          ? `${at.nodeName} could not share the track`
          : `${at.nodeName} could not ask for its review`,
      detail: at.kind === "share" ? why : `${why} It waits to be ended by hand.`,
      link: `/tracks/${at.trackId}`,
    });
  };
  const [member] = asWho
    ? await db
        .select({ role: members.role })
        .from(members)
        .where(inOrg(members, organisationId, eq(members.userId, asWho)))
    : [];
  if (!asWho || !member) return tell("Nobody who started the run is still in the workspace.");

  const named = namedPeople(at.kind === "share" ? at.config.to : at.config.who);
  const lower = named.flatMap((n) => (n.kind === "name" ? [n.name.toLowerCase()] : []));
  const byRole = await db
    .select({ userId: projectMembers.userId, role: projectRoles.name })
    .from(projectMembers)
    .innerJoin(
      projectRoles,
      and(
        eq(projectRoles.id, projectMembers.roleId),
        eq(projectRoles.organisationId, organisationId),
      ),
    )
    .where(inOrg(projectMembers, organisationId, eq(projectMembers.projectId, projectId)))
    // In turn, they are asked in the order they joined the project.
    .orderBy(asc(projectMembers.createdAt), asc(projectMembers.id));
  const people = [
    ...new Set(byRole.filter((r) => lower.includes(r.role.toLowerCase())).map((r) => r.userId)),
  ];
  const projectGroups = await db
    .select({ id: groups.id, name: groups.name })
    .from(groups)
    .where(inOrg(groups, organisationId, eq(groups.projectId, projectId)));
  const teams = projectGroups.filter((g) => lower.includes(g.name.toLowerCase())).map((g) => g.id);
  // Guests are the workspace's, found by the name they are known by or by email; someone new
  // by email becomes one, as when a person asks them.
  const known = named.some((n) => n.kind !== "name")
    ? await db
        .select({ name: guests.name, email: guests.email })
        .from(guests)
        .where(inOrg(guests, organisationId))
    : [];
  const outside: GuestInput[] = named.flatMap((n): GuestInput[] => {
    if (n.kind === "guest") {
      const guest = known.find((g) => g.name.toLowerCase() === n.name.toLowerCase());
      return guest ? [{ name: guest.name, email: guest.email }] : [];
    }
    if (n.kind !== "email") return [];
    const guest = known.find((g) => g.email === n.email);
    return [{ name: guest?.name ?? n.name ?? n.email.split("@")[0] ?? n.email, email: n.email }];
  });
  const everyone: ReviewerInput[] = [
    ...people,
    ...outside,
    ...teams.map((groupId) => ({ groupId })),
  ];
  const reviewers = everyone.filter(
    (r, i) => everyone.findIndex((o) => reviewerKey(o) === reviewerKey(r)) === i,
  );
  if (reviewers.length === 0)
    return tell(
      `No role, group or guest of the project is called ${
        named.map((n) => ("email" in n ? n.email : n.name)).join(", ") || "anything it names"
      }.`,
    );

  const [version] = at.versionId
    ? [{ id: at.versionId }]
    : await db
        .select({ id: versions.id })
        .from(versions)
        .where(inOrg(versions, organisationId, eq(versions.trackId, at.trackId)))
        .orderBy(desc(versions.number))
        .limit(1);
  const [track] = await db
    .select({ name: tracks.name })
    .from(tracks)
    .where(inOrg(tracks, organisationId, eq(tracks.id, at.trackId)));
  const expires = dueIn(at.config.expires);
  const parsed = createReviewInput.safeParse({
    kind: at.kind,
    title: `${at.nodeName}: ${track?.name ?? "a track"}`.slice(0, 160),
    order: /turn/i.test(at.config.order ?? "") ? "sequence" : "parallel",
    ...(at.kind === "approval" ? { rule: /any/i.test(at.config.rule ?? "") ? "any" : "all" } : {}),
    dueAt: at.kind === "share" ? undefined : dueIn(at.config.due),
    items: [{ trackId: at.trackId, ...(version ? { versionId: version.id } : {}) }],
    reviewers,
    ...(at.kind === "share" && expires ? { permissions: { expiresAt: expires } } : {}),
  });
  if (!parsed.success)
    return tell(parsed.error.issues[0]?.message ?? "The review did not fit together.");
  try {
    await requestReview(
      deps.reviews,
      { organisationId, userId: asWho, organisationRole: member.role as OrganisationRole },
      projectId,
      parsed.data,
      {},
      // A share asks nothing, so nothing waits on it: the run has already carried on.
      at.kind === "share" ? undefined : { runId: at.runId, nodeId: at.nodeId },
    );
  } catch (failure) {
    await tell(failure instanceof Error ? `${failure.message}.`.replace(/\.\.$/, ".") : "");
  }
}

/** A review's outcome as the outcome of the stage that asked for it. */
export function stageOutcome(outcome: string | null): string | null {
  if (outcome === "approved") return "approved";
  if (outcome === "changes_requested") return "changes";
  if (outcome === "submitted") return "done";
  return null;
}
