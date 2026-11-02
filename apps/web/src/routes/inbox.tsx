import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Empty } from "~/components/empty";
import { Icon } from "~/components/icons";
import { NeedsYouDot } from "~/components/needs-you";
import { PageHeader } from "~/components/page-header";
import { reviewState } from "~/components/reviews";
import { Button } from "~/components/ui/button";
import { Count } from "~/components/ui/chip";
import { filterTab } from "~/components/ui/filter-tabs";
import { Failed, Loading } from "~/components/ui/states";
import { StatusDot } from "~/components/ui/status";
import { cn } from "~/lib/cn";
import { ago } from "~/lib/comments";
import { type InboxFilter, type InboxItem, inboxLists } from "~/lib/inbox";
import { homeQuery, myReviewsQuery } from "~/lib/queries";
import { ReviewBody } from "~/routes/review";

const filters: { id: InboxFilter; label: string; none: string }[] = [
  { id: "needs", label: "Needs you", none: "You are all caught up." },
  { id: "following", label: "Following", none: "Nothing in progress." },
  { id: "done", label: "Done", none: "Nothing finished yet." },
];

const rowClass =
  "flex w-full items-start gap-3 rounded-panel px-3 py-row-tight text-left transition-colors duration-150";

function Row({ item, active, show }: { item: InboxItem; active: boolean; show: InboxFilter }) {
  const body = (
    <>
      <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center">
        {item.kind === "failed" ? (
          <Icon name="warning" size={14} className="text-signal" />
        ) : item.review?.yourTurn && item.review.status === "open" ? (
          // Your turn: the signal, as for whatever needs a person (#613).
          <NeedsYouDot />
        ) : (
          item.review && <StatusDot state={reviewState(item.review)} />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">
            {item.title}
          </span>
          {item.at && (
            <span className="tabular shrink-0 text-[12px] text-ink-3">{ago(item.at)}</span>
          )}
        </span>
        <span
          className={cn("block truncate text-[13px]", item.urgent ? "text-signal" : "text-ink-3")}
        >
          {item.detail}
        </span>
      </span>
    </>
  );
  return (
    <li>
      {item.kind === "failed" ? (
        <Link
          to="/files/$fileId"
          params={{ fileId: item.id }}
          className={cn(rowClass, "hover:bg-raised/50")}
        >
          {body}
        </Link>
      ) : (
        <Link
          to="/inbox"
          search={{ item: item.id, show }}
          aria-current={active ? "true" : undefined}
          className={cn(rowClass, active ? "bg-raised shadow-1" : "hover:bg-raised/50")}
        >
          {body}
        </Link>
      )}
    </li>
  );
}

/**
 * The inbox: reviews that need you, those you follow and those done, with the chosen one
 * open beside the list. On a phone the list and the review take turns.
 */
export function InboxPage({ item, show = "needs" }: { item?: string; show?: InboxFilter }) {
  const mine = useQuery(myReviewsQuery);
  const home = useQuery(homeQuery);
  const error = mine.error ?? home.error;

  if (error)
    return (
      <>
        <PageHeader title="Inbox" />
        <Failed
          what="Your inbox"
          error={error}
          retry={() => Promise.all([mine.refetch(), home.refetch()])}
        />
      </>
    );
  if (!mine.data || !home.data) {
    return (
      <>
        <PageHeader title="Inbox" />
        <Loading />
      </>
    );
  }
  const lists = inboxLists(mine.data, home.data.failed);
  if (mine.data.length === 0 && home.data.failed.length === 0) {
    return (
      <>
        <PageHeader title="Inbox" />
        <div className="p-5 @3xl/app:p-8">
          <Empty
            title="Nothing needs you"
            text="Reviews you are asked for, and files that need replacing, arrive here."
            action={
              <Button variant="primary" asChild>
                <Link to="/projects">Go to projects</Link>
              </Button>
            }
          />
        </div>
      </>
    );
  }
  const list = lists[show];
  const known = mine.data.some((r) => r.id === item);
  const selected = known ? item : undefined;
  // On a wide screen the first review opens beside the list until you choose another.
  const shown = selected ?? list.find((i) => i.kind === "review")?.id;

  const chosen = selected ? mine.data.find((r) => r.id === selected) : undefined;
  return (
    <>
      {/* The trail stays the inbox's (#575): the review's title heads its pane. Chosen on a
          phone, where the list is hidden, the name leads back to it. */}
      <PageHeader
        title={
          chosen ? (
            <Link
              to="/inbox"
              search={{ show }}
              className="inline-flex items-center gap-1 text-ink no-underline"
            >
              <Icon name="chevronLeft" size={14} className="shrink-0 @3xl/app:hidden" />
              Inbox
            </Link>
          ) : (
            "Inbox"
          )
        }
      />
      <div className="flex h-full min-h-0 flex-col @3xl/app:flex-row">
        <div
          className={cn(
            "min-h-0 flex-col border-line @3xl/app:flex @3xl/app:w-[380px] @3xl/app:shrink-0 @3xl/app:border-r",
            selected ? "hidden" : "flex",
          )}
        >
          <nav aria-label="Inbox lists" className="flex h-11 shrink-0 items-center gap-1 px-3">
            {filters.map((f) => {
              const count = lists[f.id].length;
              return (
                <Link
                  key={f.id}
                  to="/inbox"
                  search={{ show: f.id }}
                  aria-current={show === f.id ? "true" : undefined}
                  className={filterTab(show === f.id)}
                >
                  {f.label}
                  {count > 0 && <Count>{count}</Count>}
                </Link>
              );
            })}
          </nav>
          <div className="scroll-quiet min-h-0 flex-1 overflow-auto px-2 pb-4">
            {list.length === 0 ? (
              <p className="px-3 py-10 text-center text-[13px] text-ink-3">
                {filters.find((f) => f.id === show)?.none}
              </p>
            ) : (
              <ul className="fade-in m-0 flex list-none flex-col gap-px p-0">
                {list.map((i) => (
                  <Row key={i.id} item={i} active={i.id === shown} show={show} />
                ))}
              </ul>
            )}
          </div>
        </div>
        <section
          aria-label="Review"
          className={cn(
            "scroll-quiet min-h-0 min-w-0 flex-1 overflow-auto @3xl/app:block",
            selected ? "block" : "hidden",
          )}
        >
          {shown ? (
            <ReviewBody
              key={shown}
              reviewId={shown}
              embedded
              // Shown only because it came first (and hidden on a phone): not yet looked at.
              markViewed={shown === selected}
            />
          ) : (
            <div className="flex h-full items-center justify-center p-8 text-[14px] text-ink-3">
              Choose a review on the left.
            </div>
          )}
        </section>
      </div>
    </>
  );
}
