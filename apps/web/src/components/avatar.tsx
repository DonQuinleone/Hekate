import { cn } from "~/lib/cn";

/* Each person gets a hue of their own, kept dim so the faces read as one family. */
const hueOf = (id: string) => [...id].reduce((n, c) => n + c.charCodeAt(0), 0) % 360;

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

/** A person's initials on a colour of their own, for people and guests alike. */
export function Avatar({
  id,
  name,
  size = 24,
  className,
}: {
  /** Anything stable for the person (an id or an email), which picks the hue. */
  id: string;
  name: string;
  size?: number;
  className?: string;
}) {
  const hue = hueOf(id);
  return (
    <span
      aria-hidden="true"
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
      {initials(name)}
    </span>
  );
}

/** A few people, overlapping, with a count of the rest. */
export function AvatarRow({
  people,
  total = people.length,
  max = 4,
  size = 22,
}: {
  people: { id: string; name: string }[];
  /** Everyone, when only some were sent. */
  total?: number;
  max?: number;
  size?: number;
}) {
  const shown = people.slice(0, max);
  const rest = total - shown.length;
  return (
    <span className="inline-flex items-center">
      {shown.map((p, i) => (
        <Avatar
          key={p.id}
          id={p.id}
          name={p.name}
          size={size}
          className={cn(i > 0 && "-ml-1.5", "ring-2 ring-pane")}
        />
      ))}
      {rest > 0 && <span className="tabular ml-1.5 text-[12px] text-ink-3">+{rest}</span>}
    </span>
  );
}
