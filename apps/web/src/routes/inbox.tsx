import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Empty } from "~/components/empty";
import { Icon } from "~/components/icons";
import { PageHeader } from "~/components/page-header";
import { reviewState } from "~/components/reviews";
import { Button } from "~/components/ui/button";
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
  "flex w-full items-start gap-3 rounded-panel px-3 py-2.5 text-left transition-colors duration-150";

function Row({ item, active, show }: { item: InboxItem; active: boolean; show: InboxFilter }) {
  const body = (
    <>
      <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center">
        {item.kind === "failed" ? (
          <Icon name="warning" size={14} className="text-signal" />
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

  if (error) return <p className="p-8 text-signal">{error.message}</p>;
  if (!mine.data || !home.data) {
    return (
      <>
        <PageHeader title="Inbox" />
        <p className="p-8 text-ink-3">Loading</p>
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
            title="Nothing waiting on you"
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
      {chosen ? (
        <PageHeader
          crumbs={[
            {
              key: "inbox",
              link: (
                <Link to="/inbox" search={{ show }}>
                  Inbox
                </Link>
              ),
            },
          ]}
          title={chosen.title}
        />
      ) : (
        <PageHeader title="Inbox" />
      )}
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
                  className={cn(
                    "flex h-8 items-center gap-1.5 rounded-control px-2.5 text-[13px] transition-colors",
                    show === f.id ? "bg-raised text-ink shadow-1" : "text-ink-3 hover:text-ink",
                  )}
                >
                  {f.label}
                  {count > 0 && <span className="tabular text-[12px] text-ink-3">{count}</span>}
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
            <ReviewBody key={shown} reviewId={shown} embedded titled={shown === selected} />
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
