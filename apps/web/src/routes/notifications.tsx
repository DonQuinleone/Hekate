import { useInfiniteQuery } from "@tanstack/react-query";
import { Empty } from "~/components/empty";
import { NotificationItem } from "~/components/notifications";
import { Page } from "~/components/page";
import { PageHeader } from "~/components/page-header";
import { Button } from "~/components/ui/button";
import { byDay } from "~/lib/notifications";
import { allNotificationsQuery, useNotificationActions } from "~/lib/queries";

/** Every notification, by day, newest first. */
export function NotificationsPage() {
  const all = useInfiniteQuery(allNotificationsQuery);
  const { readAll } = useNotificationActions();
  const list = all.data?.pages.flatMap((p) => p.notifications) ?? [];
  const unread = all.data?.pages[0]?.unread ?? 0;
  return (
    <>
      <PageHeader
        title="Notifications"
        actions={
          unread > 0 && (
            <Button variant="ghost" size="sm" onClick={() => readAll.mutate()}>
              Mark all read
            </Button>
          )
        }
      />
      <Page width="narrow" className="gap-6">
        {all.error && <p className="m-0 text-signal">{all.error.message}</p>}
        {all.isPending && <p className="m-0 text-ink-3">Loading</p>}
        {all.data && list.length === 0 && (
          <Empty
            title="Nothing new"
            text="Reviews asked of you, decisions, replies, mentions and new versions arrive here, and by mail as you choose."
          />
        )}
        {byDay(list).map(([label, items]) => (
          <section key={label} aria-label={label} className="flex flex-col gap-1">
            <h2 className="eyebrow m-0 mb-1">{label}</h2>
            <ul className="m-0 flex list-none flex-col p-0">
              {items.map((n) => (
                <li key={n.id}>
                  <NotificationItem n={n} size={28} className="rounded-panel px-2 py-2.5" />
                </li>
              ))}
            </ul>
          </section>
        ))}
        {all.hasNextPage && (
          <div>
            <Button
              variant="ghost"
              size="sm"
              disabled={all.isFetchingNextPage}
              onClick={() => void all.fetchNextPage()}
            >
              Show older
            </Button>
          </div>
        )}
      </Page>
    </>
  );
}
