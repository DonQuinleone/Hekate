import { initials, personById } from "~/data";
import { cn } from "~/lib/cn";

/* Each person gets a hue of their own, kept dim so the faces read as one family. */
const hueOf = (id: string) => [...id].reduce((n, c) => n + c.charCodeAt(0), 0) % 360;

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
  const hue = hueOf(personId);
  return (
    <span
      aria-hidden="true"
      title={person.name}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-medium text-ink shadow-1",
        className,
      )}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(9, Math.round(size * 0.4)),
        background: `linear-gradient(145deg, oklch(0.42 0.06 ${hue}), oklch(0.28 0.05 ${hue + 30}))`,
      }}
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
          className={cn(i > 0 && "-ml-1.5", "ring-2 ring-pane")}
        />
      ))}
      {rest > 0 && <span className="ml-1.5 text-[13px] text-ink-3">+{rest}</span>}
    </span>
  );
}
