import { initials, personById } from "~/data";
import { cn } from "~/lib/cn";

/* Each person gets a hue of their own (#604), from who they are, never from where they appear. */
const hueOf = (id: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 360;
};

/** How far each avatar in a row tucks under the one before; the ring sits on top (#540). */
const stackOverlap = (size: number) => {
  // Two capitals take about 1.4 times the type's size; the ring takes 2 px of what is left.
  const font = Math.max(9, Math.round(size * 0.4));
  return Math.max(0, Math.floor((size - 1.4 * font) / 2 - 2.5));
};

export function Avatar({
  personId,
  size = 24,
  tuck = 0,
  className,
}: {
  personId: string;
  size?: number;
  tuck?: number;
  className?: string;
}) {
  const person = personById(personId);
  const hue = hueOf(personId);
  return (
    <span
      aria-hidden="true"
      title={person.name}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-medium shadow-1",
        className,
      )}
      style={{
        width: size,
        height: size,
        marginLeft: tuck ? -tuck : undefined,
        fontSize: Math.max(9, Math.round(size * 0.4)),
        // The ramp and the ink are the theme's (#540): the initials hold 4.5:1 in every theme.
        color: "var(--hk-avatar-ink)",
        background: `linear-gradient(145deg, oklch(var(--hk-avatar-lit) ${hue}), oklch(var(--hk-avatar-deep) ${hue + 30}))`,
      }}
    >
      {initials(person.name)}
    </span>
  );
}

/** A few people, overlapping, each ringed in the ground colour, with a count of the rest. */
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
          tuck={i > 0 ? stackOverlap(size) : 0}
          className="ring-2 ring-pane"
        />
      ))}
      {rest > 0 && <span className="ml-1.5 text-[13px] text-ink-3">+{rest}</span>}
    </span>
  );
}
