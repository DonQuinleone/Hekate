import { Avatar } from "~/components/avatar";
import { cn } from "~/lib/cn";

/** Whom a thread is for (#499), as the prototype shows it: their face and name, on the thread's line of facts. */
export function CommentAssignee({
  id,
  name,
  className,
}: {
  id: string;
  name: string;
  className?: string;
}) {
  return (
    <span
      className={cn("inline-flex min-w-0 items-center gap-1 text-ink-2", className)}
      title="Who is to act on it"
    >
      <Avatar id={id} name={name} size={14} />
      <span className="truncate">{name}</span>
    </span>
  );
}
