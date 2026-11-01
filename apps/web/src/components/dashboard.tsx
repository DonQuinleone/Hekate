import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Avatar } from "~/components/avatar";
import { Icon } from "~/components/icons";
import { SectionHead } from "~/components/page";
import { cn } from "~/lib/cn";
import { ago } from "~/lib/comments";
import { activityText } from "~/lib/home";
import { type HomeActivity, meQuery, projectsQuery } from "~/lib/queries";

/** A figure on a dashboard: what it counts, the number, a line of context. */
export function Stat({
  label,
  value,
  hint,
  flag = false,
}: {
  label: string;
  value: number | string;
  hint: string;
  flag?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col rounded-panel-lg border border-line bg-raised/25 px-4 py-3.5 shadow-1">
      <span className="truncate text-[13px] text-ink-3">{label}</span>
      <span
        className={cn(
          "tabular mt-1 block text-[28px] leading-[32px] font-semibold tracking-[-0.02em]",
          flag ? "text-signal" : "text-ink",
        )}
      >
        {value}
      </span>
      <span className="mt-1 block truncate text-[12px] text-ink-3">{hint}</span>
    </div>
  );
}

/** A titled part of a dashboard. */
export function Section({
  title,
  hint,
  action,
  children,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className="flex min-w-0 flex-col gap-3">
      <SectionHead title={title} hint={hint} action={action} />
      {children}
    </section>
  );
}

/**
 * One line of what has happened: who ("You" for the viewer), what, in its project's words, and
 * when, opening where it happened.
 */
export function ActivityRow({ a }: { a: HomeActivity }) {
  const { data: me } = useQuery(meQuery);
  const { data: projects } = useQuery(projectsQuery);
  const profile = projects?.find((p) => p.id === a.projectId)?.profile;
  const who = a.who && (a.who.id === me?.user.id ? "You" : a.who.name);
  const body = (
    <>
      {a.who ? (
        <Avatar person={a.who.id} name={a.who.name} size={24} />
      ) : (
        <span className="flex size-6 shrink-0 items-center justify-center text-ink-3">
          <Icon name="review" size={14} />
        </span>
      )}
      <span className="min-w-0 flex-1 truncate text-[13px] text-ink-2">
        {who && <span className="text-ink">{who} </span>}
        {activityText(a, profile)}
      </span>
      <span className="tabular shrink-0 text-[12px] text-ink-3">{ago(a.at)}</span>
    </>
  );
  const cls =
    "flex items-center gap-3 rounded-panel px-3 py-2 transition-colors hover:bg-raised/60";
  return (
    <li>
      {a.kind === "comment" ? (
        <Link to="/files/$fileId" params={{ fileId: a.fileId }} className={cls}>
          {body}
        </Link>
      ) : a.kind === "version" ? (
        <Link to="/tracks/$trackId" params={{ trackId: a.trackId }} className={cls}>
          {body}
        </Link>
      ) : (
        <Link to="/reviews/$reviewId" params={{ reviewId: a.reviewId }} className={cls}>
          {body}
        </Link>
      )}
    </li>
  );
}
