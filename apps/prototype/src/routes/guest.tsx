import { Link } from "@tanstack/react-router";
import { Page } from "~/components/page";
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
    <Page width="narrow" className="gap-6">
      <p className="text-ink-2">{organisation.name} asked you to look at these.</p>
      <StateGate
        empty={
          <Empty
            title="Nothing to review"
            text="When someone asks you to review something, it appears here and you get an email."
          />
        }
      >
        <ul className="flex list-none flex-col rounded-panel-lg border border-line bg-raised/40 p-0 shadow-1">
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
                className="flex items-center gap-4 rounded-panel px-3 py-3 transition-colors hover:bg-raised/60"
              >
                <Dot state={reviewDot(r.status, outcome)} />
                <div className="min-w-0 flex-1">
                  {closed ? (
                    <span className="text-[14px] font-medium text-ink-2">{r.title}</span>
                  ) : (
                    <Link
                      to="/g/reviews/$reviewId"
                      params={{ reviewId: r.id }}
                      className="text-[14px] font-medium text-ink no-underline hover:text-signal"
                    >
                      {r.title}
                    </Link>
                  )}
                  <div className="truncate text-[13px] text-ink-3">
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
    </Page>
  );
}
