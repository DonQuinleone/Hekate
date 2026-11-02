import { readFileSync } from "node:fs";
import { join } from "node:path";
import { contrast } from "@hekate/shared";
import { describe, expect, it } from "vitest";
import { avatarHue, personKey } from "./avatar";

const styles = join(import.meta.dirname, "..", "styles");

/** Each theme's custom properties: the brand's own in tokens.css, each palette's over them. */
function themes(): Map<string, Map<string, string>> {
  const props = (block: string) =>
    new Map(
      [...block.matchAll(/(--hk-[\w-]+):\s*([^;]+);/g)].map((m) => [
        m[1] ?? "",
        (m[2] ?? "").trim(),
      ]),
    );
  const tokens = readFileSync(join(styles, "tokens.css"), "utf8");
  const base = props(tokens.match(/:root \{([^}]*)\}/)?.[1] ?? "");
  const all = new Map([["signal-dark", base]]);
  for (const m of readFileSync(join(styles, "themes.css"), "utf8").matchAll(
    /:root\[data-theme="([\w-]+)"\] \{([^}]*)\}/g,
  )) {
    all.set(m[1] ?? "", new Map([...base, ...props(m[2] ?? "")]));
  }
  return all;
}

const resolve = (theme: Map<string, string>, value: string): string => {
  const ref = value.match(/^var\((--hk-[\w-]+)\)$/)?.[1];
  return ref ? resolve(theme, theme.get(ref) ?? "") : value;
};

/** An oklch colour as sRGB hex, clipped into the gamut as a browser draws it. */
function oklchToHex(l: number, c: number, h: number): string {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
  return `#${linear
    .map((v) => {
      const x = Math.min(1, Math.max(0, v));
      const s = x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055;
      return Math.round(s * 255)
        .toString(16)
        .padStart(2, "0");
    })
    .join("")}`;
}

describe("avatars (#540)", () => {
  it("hold 4.5:1 between the initials and both ends of the ramp, for every hue in every theme", () => {
    const failures: string[] = [];
    for (const [name, theme] of themes()) {
      const ink = resolve(theme, theme.get("--hk-avatar-ink") ?? "");
      expect(ink, name).toMatch(/^#[0-9a-f]{6}$/i);
      for (const stop of ["--hk-avatar-lit", "--hk-avatar-deep"]) {
        const [l, c] = (theme.get(stop) ?? "").split(/\s+/).map(Number) as [number, number];
        for (let h = 0; h < 390; h += 5) {
          const ratio = contrast(ink, oklchToHex(l, c, h));
          if (ratio < 4.5) failures.push(`${name} ${stop} hue ${h}: ${ratio.toFixed(2)}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });
});

describe("one colour per person (#604)", () => {
  it("is taken from the person, not from where they are shown", () => {
    const user = "01936b6e-7d40-7000-8000-000000000001";
    const guest = "01936b6e-7d40-7000-8000-000000000002";
    // A member as a reviewer row, as the review's author and as an activity's actor.
    const asReviewer = personKey({ userId: user, guestId: null });
    const asAuthor = personKey({ userId: user });
    const asActor = personKey({ userId: user, email: "mira@example.com" });
    expect(new Set([asReviewer, asAuthor, asActor].map(avatarHue)).size).toBe(1);
    // A guest keeps their colour from one review to the next: the key is the guest, not the row.
    expect(avatarHue(personKey({ userId: null, guestId: guest }))).toBe(
      avatarHue(personKey({ guestId: guest, email: "ines@example.com" })),
    );
    // Typed in by address before they exist, in whatever case.
    expect(personKey({ email: " Ines@Example.com " })).toBe("ines@example.com");
  });

  it("spreads ids made a moment apart across the wheel", () => {
    const hues = Array.from({ length: 8 }, (_, i) =>
      avatarHue(`01936b6e-7d40-7000-8000-00000000000${i}`),
    );
    expect(new Set(hues).size).toBe(8);
    expect(Math.max(...hues) - Math.min(...hues)).toBeGreaterThan(120);
  });
});
