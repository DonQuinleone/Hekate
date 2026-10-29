import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Avatar } from "~/components/avatar";
import { Icon, type IconName } from "~/components/icons";
import { Button } from "~/components/ui/button";
import { Floating } from "~/components/ui/floating";
import { usePopover } from "~/components/ui/menu";
import { type NotificationKind, notifications, personById } from "~/data";
import { cn } from "~/lib/cn";
import { ago } from "~/lib/format";

export const notificationIcon: Record<NotificationKind, IconName> = {
  version: "upload",
  reply: "comment",
  decision: "review",
  assignment: "user",
  stage: "board",
  mention: "comment",
  processing: "warning",
};

/** The bell: the latest events in a panel, and the way into the inbox. */
export function NotificationsMenu({ waiting }: { waiting: number }) {
  const navigate = useNavigate();
  const [open, setOpen, box] = usePopover();
  const [read, setRead] = useState<Set<string>>(
    new Set(notifications.filter((n) => n.read).map((n) => n.id)),
  );
  const unread = notifications.filter((n) => !read.has(n.id)).length;
  const go = (href: string, id?: string) => {
    if (id) setRead((r) => new Set(r).add(id));
    setOpen(false);
    navigate({ to: href });
  };
  return (
    <div ref={box} className="relative">
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
          className="rise-in flex w-[380px] flex-col overflow-hidden rounded-panel-lg bg-overlay shadow-4"
        >
          <div className="flex h-11 items-center gap-2 border-b border-line px-4">
            <span className="text-[14px] font-medium text-ink">Notifications</span>
            {unread > 0 && <span className="tabular text-[12px] text-ink-3">{unread} unread</span>}
            <button
              type="button"
              onClick={() => setRead(new Set(notifications.map((n) => n.id)))}
              className="ml-auto text-[12px] text-ink-3 hover:text-ink"
            >
              Mark all read
            </button>
          </div>
          <ul className="scroll-quiet max-h-[380px] overflow-auto py-1">
            {notifications.slice(0, 6).map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  onClick={() => go(n.href, n.id)}
                  className="flex w-full items-start gap-3 px-4 py-2.5 text-left transition-colors hover:bg-raised/70"
                >
                  <span className="relative mt-0.5 shrink-0">
                    <Avatar personId={n.personId} size={26} />
                    <span className="absolute -right-1 -bottom-1 flex size-4 items-center justify-center rounded-full bg-overlay text-ink-2 shadow-2">
                      <Icon name={notificationIcon[n.kind]} size={9} />
                    </span>
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn(
                        "block text-[13px] leading-[18px]",
                        read.has(n.id) ? "text-ink-2" : "text-ink",
                      )}
                    >
                      <span className="font-medium text-ink">{personById(n.personId).name}</span>{" "}
                      {n.text}
                    </span>
                    <span className="tabular block text-[12px] text-ink-3">{ago(n.at)}</span>
                  </span>
                  {!read.has(n.id) && (
                    <span className="mt-2 size-1.5 shrink-0 rounded-full bg-signal" />
                  )}
                </button>
              </li>
            ))}
          </ul>
          <div className="flex items-center gap-2 border-t border-line px-3 py-2.5">
            <Button variant="primary" size="md" onClick={() => go("/inbox")}>
              <Icon name="inbox" size={14} />
              View inbox
              {waiting > 0 && <span className="tabular text-ground/70">{waiting}</span>}
            </Button>
            <Button variant="ghost" size="md" onClick={() => go("/notifications")}>
              All notifications
            </Button>
          </div>
        </Floating>
      )}
    </div>
  );
}
