import { cn } from "~/lib/cn";

/**
 * Each person's hue, from their key (#604): the same person has the same colour on every
 * screen and in every review. FNV-1a spreads keys that differ in one character (ids made a
 * moment apart) across the wheel, where a sum of characters would put them side by side.
 */
export function avatarHue(person: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < person.length; i++) {
    h ^= person.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 360;
}

/**
 * What an avatar's colour is taken from (#604): a member's user id, a guest's id; where neither
 * exists yet (someone typed in by address) their address, lower-cased; and only where nothing
 * else is shown (a guest's own view of other guests, who are named but never identified to
 * them) the name. Never a row's own id, which changes from review to review.
 */
export function personKey(p: {
  userId?: string | null;
  guestId?: string | null;
  email?: string | null;
  name?: string | null;
}): string {
  return p.userId ?? p.guestId ?? p.email?.trim().toLowerCase() ?? p.name ?? "";
}

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

/**
 * A person's initials on a colour of their own, for people and guests alike. The initials are
 * drawn from an attribute rather than written as text, so a control that holds an avatar is
 * named by the person's name alone, never by their initials as well (WCAG 2.5.3, label in name).
 * The ramp and the ink are the theme's (`--hk-avatar-*`, #540); only the hue is the person's.
 */
export function Avatar({
  person,
  name,
  size = 24,
  tuck = 0,
  className,
}: {
  /** How far it tucks under the avatar before it, in a row. */
  tuck?: number;
  /** The person's key (`personKey`): a member's user id or a guest's id. */
  person: string;
  name: string;
  size?: number;
  className?: string;
}) {
  const hue = avatarHue(person);
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-medium shadow-1",
        "before:content-[attr(data-initials)]",
        className,
      )}
      data-initials={initials(name)}
      style={{
        width: size,
        height: size,
        marginLeft: tuck ? -tuck : undefined,
        fontSize: Math.max(9, Math.round(size * 0.4)),
        color: "var(--hk-avatar-ink)",
        background: `linear-gradient(145deg, oklch(var(--hk-avatar-lit) ${hue}), oklch(var(--hk-avatar-deep) ${hue + 30}))`,
      }}
    />
  );
}

/**
 * How far each avatar in a row tucks under the one before (#540). The ring, in the ground
 * colour, sits on top of that, so together they leave the initials of every face whole.
 */
export const stackOverlap = (size: number) => {
  // Two capitals take about 1.4 times the type's size; the ring takes 2 px of what is left.
  const font = Math.max(9, Math.round(size * 0.4));
  return Math.max(0, Math.floor((size - 1.4 * font) / 2 - 2.5));
};

/** A few people, overlapping, each ringed in the ground colour, with a count of the rest. */
export function AvatarRow({
  people,
  total = people.length,
  max = 4,
  size = 22,
}: {
  /** Each with their key (`personKey`) as `id`. */
  people: { id: string; name: string }[];
  /** Everyone, when only some were sent. */
  total?: number;
  max?: number;
  size?: number;
}) {
  const shown = people.slice(0, max);
  const rest = total - shown.length;
  return (
    <span className="inline-flex items-center" data-avatar-row="">
      {shown.map((p, i) => (
        <Avatar
          key={p.id}
          person={p.id}
          name={p.name}
          size={size}
          className="ring-2 ring-pane"
          tuck={i > 0 ? stackOverlap(size) : 0}
        />
      ))}
      {rest > 0 && <span className="tabular ml-1.5 text-[12px] text-ink-3">+{rest}</span>}
    </span>
  );
}
