import { Link } from "@tanstack/react-router";
import { usePageHeader } from "~/components/page-header";
import { Dot, reviewDot } from "~/components/status";
import { organisation } from "~/data";
import { ago, dueIn } from "~/lib/format";
import { reviewOutcome } from "~/lib/reviews";
import { useViewer } from "~/viewer/context";
import { Empty, StateGate } from "~/viewer/state-gate";

export function GuestHomePage() {
  const viewer = useViewer();
  usePageHeader({ title: "Your reviews" });
  const mine = viewer.reviews();
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6 @3xl/app:px-6">
      <p className="m-0 text-ink-2">{organisation.name} asked you to look at these.</p>
      <StateGate
        empty={
          <Empty
            title="Nothing to review"
            text="When someone asks you to review something, it appears here and you get an email."
          />
        }
      >
        <ul className="m-0 flex list-none flex-col rounded-panel-lg border border-hairline bg-surface p-0 shadow-1">
          {mine.map((r) => {
            const me = viewer.reviewerIn(r);
            const outcome = reviewOutcome(r);
            const closed =
              r.status !== "open" ||
              (me?.permissions.expiresAt &&
                new Date(me.permissions.expiresAt) < new Date("2026-10-14T21:00:00Z"));
            return (
              <li
                key={r.id}
                className="flex items-center gap-4 border-b border-hairline-soft px-4 py-3 last:border-b-0"
              >
                <Dot state={reviewDot(r.status, outcome)} />
                <div className="min-w-0 flex-1">
                  {closed ? (
                    <span className="text-[13px] font-medium text-ink-2">{r.title}</span>
                  ) : (
                    <Link
                      to="/g/reviews/$reviewId"
                      params={{ reviewId: r.id }}
                      className="text-[13px] font-medium text-ink no-underline hover:text-signal"
                    >
                      {r.title}
                    </Link>
                  )}
                  <div className="truncate text-xs text-ink-3">
                    {r.kind === "approval"
                      ? "Approval"
                      : r.kind === "feedback"
                        ? "Feedback"
                        : "Shared with you"}
                    {r.dueAt && ` · due in ${dueIn(r.dueAt).label}`}
                    {me?.submittedAt && ` · you responded ${ago(me.submittedAt)}`}
                    {me?.permissions.expiresAt &&
                      ` · open until ${new Date(me.permissions.expiresAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </StateGate>
    </div>
  );
}
