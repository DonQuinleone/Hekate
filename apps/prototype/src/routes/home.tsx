import { Link, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { Avatar } from "~/components/avatar";
import { Icon } from "~/components/icons";
import { usePageHeader } from "~/components/page-header";
import { Dot, type DotState, reviewDot } from "~/components/status";
import { Button } from "~/components/ui/button";
import {
  comments,
  fileById,
  personById,
  projectById,
  type Review,
  reviewById,
  tasks,
  tracks,
  variationOf,
} from "~/data";
import { cn } from "~/lib/cn";
import { ago, dueIn } from "~/lib/format";
import { needsYou, responded, reviewOutcome } from "~/lib/reviews";
import { useViewer } from "~/viewer/context";
import { Empty, StateGate } from "~/viewer/state-gate";
import { outcomeCopy, ReviewBody } from "./review.tsx";

type Filter = "needs" | "following" | "done";

interface Item {
  id: string;
  kind: "review" | "comment" | "triage" | "task" | "processing";
  title: string;
  detail: string;
  at: string;
  dot?: DotState;
  personId?: string;
  reviewId?: string;
  href?: { to: string; params?: Record<string, string>; search?: Record<string, string> };
  urgent?: boolean;
}

const reviewItem = (
  r: Review,
  me: ReturnType<ReturnType<typeof useViewer>["reviewerIn"]>,
): Item => {
  const due = r.dueAt ? dueIn(r.dueAt) : null;
  const ask =
    r.status !== "open"
      ? outcomeCopy(r)
      : me && needsYou(r, me)
        ? r.kind === "approval"
          ? me.permissions.decide
            ? "Your decision"
            : "Your comments"
          : "Your feedback"
        : `${responded(r)} of ${r.reviewers.length} responded`;
  return {
    id: r.id,
    kind: "review",
    title: r.title,
    detail: [ask, projectById(r.projectId)?.name, r.status === "open" && due ? due.label : null]
      .filter(Boolean)
      .join(" · "),
    at: r.requestedAt,
    dot: reviewDot(r.status, reviewOutcome(r)),
    reviewId: r.id,
    urgent: Boolean(r.status === "open" && due && due.days < 0),
  };
};

function Row({ item, active, onOpen }: { item: Item; active: boolean; onOpen: () => void }) {
  const lead = item.personId ? (
    <Avatar personId={item.personId} size={24} />
  ) : (
    <span className="flex size-6 items-center justify-center">
      {item.kind === "processing" ? (
        <Icon name="warning" size={14} className="text-signal" />
      ) : item.kind === "triage" ? (
        <Icon name="comment" size={14} className="text-ink-3" />
      ) : (
        <Dot state={item.dot ?? "in_review"} />
      )}
    </span>
  );
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        aria-current={active ? "true" : undefined}
        className={cn(
          "flex w-full items-start gap-3 rounded-panel px-3 py-2.5 text-left transition-colors duration-150",
          active ? "bg-raised shadow-1" : "hover:bg-raised/50",
        )}
      >
        <span className="mt-0.5">{lead}</span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">
              {item.title}
            </span>
            <span className="tabular shrink-0 text-[12px] text-ink-3">{ago(item.at)}</span>
          </span>
          <span
            className={cn("block truncate text-[13px]", item.urgent ? "text-signal" : "text-ink-3")}
          >
            {item.detail}
          </span>
        </span>
      </button>
    </li>
  );
}

export function HomePage({ item: selectedId }: { item?: string }) {
  const viewer = useViewer();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<Filter>("needs");
  const mine = viewer.reviews();
  const me = (r: Review) => viewer.reviewerIn(r);

  const needs: Item[] = [
    ...mine.filter((r) => needsYou(r, me(r))).map((r) => reviewItem(r, me(r))),
    ...comments
      .filter(
        (c) =>
          c.assigneeId === viewer.personId &&
          !c.resolved &&
          viewer.canSee(fileById(c.fileId)?.projectId ?? ""),
      )
      .map(
        (c): Item => ({
          id: c.id,
          kind: "comment",
          title: c.body,
          detail: `Assigned to you by ${personById(c.authorId).name} · ${
            variationOf(c.fileId)?.track.name ?? fileById(c.fileId)?.name
          }`,
          at: c.createdAt,
          personId: c.authorId,
          href: { to: "/files/$fileId", params: { fileId: c.fileId }, search: { comment: c.id } },
        }),
      ),
    ...viewer
      .projects()
      .filter((p) => viewer.can(p.id, "triage"))
      .flatMap((p) => {
        const open = comments.filter(
          (c) =>
            !c.parentId &&
            !c.resolved &&
            !c.deferredToStage &&
            !c.categoryId &&
            fileById(c.fileId)?.projectId === p.id,
        );
        if (open.length === 0) return [];
        const names = [
          ...new Set(
            open.map((c) => variationOf(c.fileId)?.track.name ?? fileById(c.fileId)?.name),
          ),
        ];
        return [
          {
            id: `triage-${p.id}`,
            kind: "triage" as const,
            title: `${open.length} comments to triage`,
            detail: names.join(", "),
            at:
              open
                .map((c) => c.createdAt)
                .sort()
                .at(-1) ?? "",
            href: {
              to: "/files/$fileId",
              params: { fileId: open[0]?.fileId ?? "" },
              search: { view: "triage" },
            },
          },
        ];
      }),
    ...tasks
      .filter(
        (t) =>
          t.assigneeId === viewer.personId && t.status !== "done" && viewer.canSee(t.projectId),
      )
      .map(
        (t): Item => ({
          id: t.id,
          kind: "task",
          title: t.title,
          detail: `Task · ${projectById(t.projectId)?.name}${
            t.dueAt ? ` · ${dueIn(`${t.dueAt}T23:59:00Z`).label}` : ""
          }`,
          at: t.dueAt ? `${t.dueAt}T09:00:00Z` : "2026-10-10T09:00:00Z",
          dot: t.priority === "high" ? "changes_requested" : "invited",
          href: {
            to: "/projects/$projectId/$view",
            params: { projectId: t.projectId, view: "tasks" },
          },
          urgent: Boolean(t.dueAt && dueIn(`${t.dueAt}T23:59:00Z`).days < 0),
        }),
      ),
    ...tracks
      .filter((t) => viewer.canSee(t.projectId) && viewer.can(t.projectId, "upload"))
      .flatMap((t) =>
        t.versions
          .filter((v) => v.state === "failed")
          .map(
            (v): Item => ({
              id: v.id,
              kind: "processing",
              title: `${t.name} V${v.number} could not be analysed`,
              detail: "The container says 96 kHz but holds 44.1 kHz frames · replace the file",
              at: v.uploadedAt,
              href: { to: "/tracks/$trackId", params: { trackId: t.id } },
            }),
          ),
      ),
  ];
  const following = mine
    .filter((r) => r.status === "open" && !needsYou(r, me(r)))
    .map((r) => reviewItem(r, me(r)));
  const done = mine.filter((r) => r.status !== "open").map((r) => reviewItem(r, me(r)));
  const lists: Record<Filter, Item[]> = { needs: needs, following, done };
  const list = lists[filter];

  const chosen =
    (selectedId && reviewById(selectedId) ? selectedId : null) ??
    list.find((i) => i.reviewId)?.reviewId ??
    null;
  const chosenReview = chosen ? reviewById(chosen) : undefined;

  const phone = viewer.settings.width === "phone";
  usePageHeader({
    crumbs: chosenReview && !phone ? [{ label: "Inbox", to: "/" }] : undefined,
    title: chosenReview && !phone ? chosenReview.title : "Inbox",
    heading: chosenReview && !phone ? "page" : "bar",
  });

  const open = (item: Item) => {
    if (item.href) {
      navigate({ to: item.href.to, params: item.href.params, search: item.href.search });
      return;
    }
    if (item.reviewId) navigate({ to: "/", search: { item: item.reviewId } });
  };

  const filters: { id: Filter; label: string; count: number }[] = [
    { id: "needs", label: "Needs you", count: needs.length },
    { id: "following", label: "Following", count: following.length },
    { id: "done", label: "Done", count: done.length },
  ];

  const column = (children: ReactNode) => (
    <div className="flex min-h-0 flex-col border-line @3xl/app:w-[380px] @3xl/app:shrink-0 @3xl/app:border-r">
      <div className="flex h-11 shrink-0 items-center gap-1 px-3">
        {filters.map((f) => (
          <button
            key={f.id}
            type="button"
            aria-pressed={filter === f.id}
            onClick={() => setFilter(f.id)}
            className={cn(
              "flex h-7 items-center gap-1.5 rounded-control px-2.5 text-[13px] transition-colors",
              filter === f.id ? "bg-raised text-ink shadow-1" : "text-ink-3 hover:text-ink",
            )}
          >
            {f.label}
            {f.count > 0 && (
              <span
                className={cn("tabular text-[12px]", filter === f.id ? "text-ink-2" : "text-ink-3")}
              >
                {f.count}
              </span>
            )}
          </button>
        ))}
      </div>
      <div className="scroll-quiet min-h-0 flex-1 overflow-auto px-2 pb-4">{children}</div>
    </div>
  );

  return (
    <StateGate
      empty={
        <div className="p-8">
          <Empty
            title="Nothing waiting on you"
            text="Reviews you are asked for, comments assigned to you and anything to triage arrive here."
            action={
              viewer.projects().length === 0 ? (
                <Button variant="primary" asChild>
                  <Link to="/projects">Start a project</Link>
                </Button>
              ) : undefined
            }
          />
        </div>
      }
    >
      <div className="flex h-full min-h-0 flex-col @3xl/app:flex-row">
        {column(
          list.length === 0 ? (
            <p className="px-3 py-10 text-center text-[13px] text-ink-3">
              {filter === "needs"
                ? "You are all caught up."
                : filter === "following"
                  ? "Nothing in progress."
                  : "Nothing finished yet."}
            </p>
          ) : (
            <ul className="fade-in flex flex-col gap-px">
              {list.map((item) => (
                <Row
                  key={item.id}
                  item={item}
                  active={Boolean(chosen && item.reviewId === chosen)}
                  onOpen={() =>
                    viewer.settings.width === "phone" && item.reviewId
                      ? navigate({ to: "/reviews/$reviewId", params: { reviewId: item.reviewId } })
                      : open(item)
                  }
                />
              ))}
            </ul>
          ),
        )}
        <div className="scroll-quiet hidden min-h-0 min-w-0 flex-1 overflow-auto @3xl/app:block">
          {chosen ? (
            <ReviewBody key={chosen} reviewId={chosen} embedded />
          ) : (
            <div className="flex h-full items-center justify-center text-[14px] text-ink-3">
              Choose something on the left.
            </div>
          )}
        </div>
      </div>
    </StateGate>
  );
}
