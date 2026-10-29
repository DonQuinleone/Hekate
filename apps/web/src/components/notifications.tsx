import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { MouseEvent } from "react";
import { Avatar } from "~/components/avatar";
import { Mark } from "~/components/brand";
import { Icon } from "~/components/icons";
import { Button } from "~/components/ui/button";
import { Floating } from "~/components/ui/floating";
import { usePopover } from "~/components/ui/menu";
import { cn } from "~/lib/cn";
import { ago } from "~/lib/comments";
import { notificationIcon } from "~/lib/notifications";
import { type AppNotification, notificationsQuery, useNotificationActions } from "~/lib/queries";

/** Who it came from, with a small mark for what kind of thing happened. */
function Face({ n, size }: { n: AppNotification; size: number }) {
  const id = n.actorUserId ?? n.actorGuestId;
  return (
    <span className="relative mt-0.5 shrink-0">
      {id && n.actorName ? (
        <Avatar id={id} name={n.actorName} size={size} />
      ) : (
        <span
          className="flex items-center justify-center rounded-full bg-raised text-ink-2 shadow-1"
          style={{ width: size, height: size }}
        >
          <Mark size={Math.round(size * 0.5)} />
        </span>
      )}
      <span className="absolute -right-1 -bottom-1 flex size-4 items-center justify-center rounded-full bg-overlay text-ink-2 shadow-2">
        <Icon name={notificationIcon[n.kind]} size={9} />
      </span>
    </span>
  );
}

/** One notification: who did what, when; opening it marks it read. */
export function NotificationItem({
  n,
  onOpen,
  size = 26,
  className,
}: {
  n: AppNotification;
  onOpen?: () => void;
  size?: number;
  className?: string;
}) {
  const navigate = useNavigate();
  const { read } = useNotificationActions();
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    if (!n.readAt) read.mutate(n.id);
    onOpen?.();
    void navigate({ href: n.link });
  };
  return (
    <a
      href={n.link}
      onClick={open}
      className={cn(
        "flex w-full items-start gap-3 text-left transition-colors hover:bg-raised/70",
        className,
      )}
    >
      <Face n={n} size={size} />
      <span className="min-w-0 flex-1">
        <span
          className={cn("block text-[13px] leading-[18px]", n.readAt ? "text-ink-2" : "text-ink")}
        >
          {n.actorName ? (
            <>
              <span className="font-medium text-ink">{n.actorName}</span> {n.text}
            </>
          ) : (
            n.text.charAt(0).toUpperCase() + n.text.slice(1)
          )}
        </span>
        <span className="tabular block text-[12px] text-ink-2">{ago(n.createdAt)}</span>
      </span>
      {!n.readAt && (
        <span className="mt-2 size-1.5 shrink-0 rounded-full bg-signal">
          <span className="sr-only">Unread</span>
        </span>
      )}
    </a>
  );
}

/** The bell: the latest notifications in a panel, and the way to all of them and the inbox. */
export function NotificationsMenu() {
  const navigate = useNavigate();
  const [open, setOpen, box] = usePopover();
  const { data } = useQuery(notificationsQuery);
  const { readAll } = useNotificationActions();
  const unread = data?.unread ?? 0;
  const list = data?.notifications ?? [];
  const go = (to: "/inbox" | "/notifications") => {
    setOpen(false);
    void navigate({ to });
  };
  return (
    // On a phone the panel spans the top bar; on a wide screen it hangs from the bell.
    <div ref={box} className="@3xl/app:relative">
      <button
        type="button"
        aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={cn(
          "relative flex size-8 items-center justify-center rounded-control text-ink-2 transition-colors hover:bg-raised hover:text-ink",
          open && "bg-raised text-ink",
        )}
      >
        <Icon name="bell" />
        {unread > 0 && (
          <span
            aria-hidden="true"
            className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-signal ring-2 ring-pane"
          />
        )}
      </button>
      {open && (
        <Floating
          anchor={box}
          align="end"
          side="bottom"
          onClose={() => setOpen(false)}
          role="dialog"
          aria-label="Notifications"
          // A panel over the page, as menus are.
          data-e2e-overlap
          className="rise-in flex w-[calc(100cqw-24px)] flex-col overflow-hidden rounded-panel-lg bg-overlay shadow-4 @3xl/app:w-[380px]"
        >
          <div className="flex h-11 items-center gap-2 border-b border-line px-4">
            <span className="text-[14px] font-medium text-ink">Notifications</span>
            {unread > 0 && <span className="tabular text-[12px] text-ink-2">{unread} unread</span>}
            {unread > 0 && (
              <button
                type="button"
                onClick={() => readAll.mutate()}
                className="ml-auto h-8 rounded-control px-2 text-[12px] text-ink-2 hover:text-ink"
              >
                Mark all read
              </button>
            )}
          </div>
          {list.length === 0 ? (
            <p className="m-0 px-4 py-8 text-center text-[13px] text-ink-2">
              Nothing yet. Decisions, replies, mentions and new versions arrive here.
            </p>
          ) : (
            <ul className="scroll-quiet m-0 max-h-[380px] list-none overflow-auto p-0 py-1">
              {list.slice(0, 6).map((n) => (
                <li key={n.id}>
                  <NotificationItem n={n} onOpen={() => setOpen(false)} className="px-4 py-2.5" />
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-center gap-2 border-t border-line px-3 py-2.5">
            <Button variant="primary" onClick={() => go("/inbox")}>
              <Icon name="inbox" size={14} />
              View inbox
            </Button>
            <Button variant="ghost" onClick={() => go("/notifications")}>
              All notifications
            </Button>
          </div>
        </Floating>
      )}
    </div>
  );
}
