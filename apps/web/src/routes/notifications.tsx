import { useInfiniteQuery } from "@tanstack/react-query";
import { Empty } from "~/components/empty";
import { NotificationItem } from "~/components/notifications";
import { Page } from "~/components/page";
import { PageHeader } from "~/components/page-header";
import { Button } from "~/components/ui/button";
import { Failed, Loading } from "~/components/ui/states";
import { useNarrow } from "~/lib/narrow";
import { byDay } from "~/lib/notifications";
import { allNotificationsQuery, useNotificationActions } from "~/lib/queries";

/**
 * Every notification, by day, newest first. On a phone, Mark all read sits beside the first
 * day's heading rather than taking a row of the header to itself (#614).
 */
export function NotificationsPage() {
  const all = useInfiniteQuery(allNotificationsQuery);
  const { readAll } = useNotificationActions();
  const list = all.data?.pages.flatMap((p) => p.notifications) ?? [];
  const unread = all.data?.pages[0]?.unread ?? 0;
  const [measure, narrow] = useNarrow(768);
  const markAll = unread > 0 && (
    <Button variant="ghost" size="sm" onClick={() => readAll.mutate()}>
      Mark all read
    </Button>
  );
  return (
    <>
      <PageHeader title="Notifications" actions={narrow ? undefined : markAll} />
      <div ref={measure} />
      <Page width="narrow" className="gap-6">
        {all.error && <Failed what="Your notifications" error={all.error} retry={all.refetch} />}
        {all.isPending && <Loading />}
        {all.data && list.length === 0 && (
          <Empty
            title="No notifications"
            text="You are told here when someone asks for your review, decides, replies, mentions you or adds a version, and by mail as you choose in your account."
          />
        )}
        {byDay(list).map(([label, items], i) => (
          <section key={label} aria-label={label} className="flex flex-col gap-1">
            <div className="mb-1 flex items-center gap-2">
              <h2 className="eyebrow m-0">{label}</h2>
              {narrow && i === 0 && <span className="ml-auto">{markAll}</span>}
            </div>
            <ul className="m-0 flex list-none flex-col p-0">
              {items.map((n) => (
                <li key={n.id}>
                  <NotificationItem n={n} size={28} className="rounded-panel px-2 py-row-tight" />
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
