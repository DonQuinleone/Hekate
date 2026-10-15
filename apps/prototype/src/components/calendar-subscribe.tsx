import { useState } from "react";
import { Icon } from "~/components/icons";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";

/** The ICS feed: deadlines, reviews and sessions, into whichever calendar the person keeps. */
export function CalendarSubscribeDialog({
  onClose,
  scope,
}: {
  onClose: () => void;
  scope: string;
}) {
  const [copied, setCopied] = useState(false);
  const url = "https://review.endlesshall.example/calendar/u/7f3a9c.ics";
  return (
    <Dialog
      title="Add to your calendar"
      description={`A feed of ${scope}: review due dates, task deadlines and sessions. It updates itself; the link is yours alone.`}
      onClose={onClose}
      width="sm"
      footer={
        <Button variant="ghost" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="grid gap-2 @md/app:grid-cols-3">
          {["Apple Calendar", "Google Calendar", "Outlook"].map((c) => (
            <Button key={c} variant="secondary" size="md" onClick={() => setCopied(true)}>
              {c}
            </Button>
          ))}
        </div>
        <div className="flex items-center gap-2 rounded-control border border-line bg-ground/60 px-3 py-2">
          <Icon name="link" size={14} className="shrink-0 text-ink-3" />
          <span className="min-w-0 flex-1 truncate text-[13px] text-ink-2">{url}</span>
          <button
            type="button"
            onClick={() => setCopied(true)}
            className="shrink-0 text-[13px] text-ink-3 hover:text-ink"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <p className="text-[12px] text-ink-3">
          Anyone with the link sees the dates and titles, nothing else. Reset it from your account.
        </p>
      </div>
    </Dialog>
  );
}
