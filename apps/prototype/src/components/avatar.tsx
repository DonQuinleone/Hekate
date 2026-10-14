import { initials, personById } from "~/data";
import { cn } from "~/lib/cn";

export function Avatar({
  personId,
  size = 24,
  className,
}: {
  personId: string;
  size?: number;
  className?: string;
}) {
  const person = personById(personId);
  return (
    <span
      aria-hidden="true"
      title={person.name}
      className={cn(
        "tabular inline-flex shrink-0 items-center justify-center rounded-full border border-edge bg-raised text-ink-2",
        className,
      )}
      style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.38)) }}
    >
      {initials(person.name)}
    </span>
  );
}

/** A few people, overlapping, with a count of the rest. */
export function AvatarRow({
  personIds,
  max = 4,
  size = 22,
}: {
  personIds: string[];
  max?: number;
  size?: number;
}) {
  const shown = personIds.slice(0, max);
  const rest = personIds.length - shown.length;
  return (
    <span className="inline-flex items-center">
      {shown.map((id, i) => (
        <Avatar
          key={id}
          personId={id}
          size={size}
          className={cn(i > 0 && "-ml-1.5", "ring-2 ring-ground")}
        />
      ))}
      {rest > 0 && <span className="ml-1.5 text-xs text-ink-3">+{rest}</span>}
    </span>
  );
}
