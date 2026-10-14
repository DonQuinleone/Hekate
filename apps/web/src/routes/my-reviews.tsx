import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { PageHeader } from "~/components/page-header";
import { reviewState } from "~/components/reviews";
import { StatusPill } from "~/components/ui/status";
import { type MyReview, myReviewsQuery } from "~/lib/queries";

const dateFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });

function Section({
  title,
  reviews,
  finished = false,
}: {
  title: string;
  reviews: MyReview[];
  /** Only a finished review's outcome is worth a status; open ones say what is asked. */
  finished?: boolean;
}) {
  if (reviews.length === 0) return null;
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <h2 className="label m-0">{title}</h2>
      <ul className="m-0 flex list-none flex-col border-t border-hairline p-0">
        {reviews.map((r) => (
          <li
            key={r.id}
            className="grid min-h-11 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-hairline px-2 py-2 hover:bg-surface sm:grid-cols-[minmax(0,1fr)_160px_80px_auto]"
          >
            <span className="flex min-w-0 flex-col">
              <Link
                to="/reviews/$reviewId"
                params={{ reviewId: r.id }}
                className="truncate text-sm text-ink no-underline hover:text-signal"
              >
                {r.title}
              </Link>
              <span className="truncate text-xs text-ink-3 sm:hidden">{r.projectName}</span>
            </span>
            <span className="hidden truncate text-xs text-ink-2 sm:block">{r.projectName}</span>
            <span className="tabular hidden text-xs text-ink-3 sm:block">
              {r.dueAt ? `Due ${dateFormat.format(new Date(r.dueAt))}` : ""}
            </span>
            {finished ? (
              <StatusPill state={reviewState(r)} />
            ) : (
              <span className="text-xs text-ink-3">
                {r.kind === "approval" ? "Approval" : "Feedback"}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Every review you take part in: what waits on you first, then what is still open, then the rest. */
export function MyReviewsPage() {
  const { data: reviews, error } = useQuery(myReviewsQuery);
  const waiting = reviews?.filter((r) => r.yourTurn) ?? [];
  const open = reviews?.filter((r) => r.status === "open" && !r.yourTurn) ?? [];
  const done = reviews?.filter((r) => r.status !== "open") ?? [];
  return (
    <>
      <PageHeader title="Reviews" />
      <div className="mx-auto flex max-w-5xl flex-col gap-8 px-4 py-6 sm:px-6">
        {error && <p className="m-0 text-signal">{error.message}</p>}
        {reviews && reviews.length === 0 && (
          <p className="m-0 text-[13px] text-ink-3">
            Nothing to review. When someone asks for your approval or feedback, it appears here.
          </p>
        )}
        <Section title="Waiting on you" reviews={waiting} />
        <Section title="In progress" reviews={open} />
        <Section title="Finished" reviews={done} finished />
      </div>
    </>
  );
}
