import type { Family } from "../family.ts";
import { type CrMeta, type FrameRate, frameRates } from "../model.ts";

/**
 * The session itself (decision 242): `create_session` names it, `set_meta` sets one of its
 * settings by `field` and `value` (both text), and `set_notes` writes the session notes. A
 * setting ControlRoom does not know it ignores; the report counts it as an unknown field.
 */
const texts: Record<string, keyof CrMeta> = {
  name: "name",
  conductor: "conductor",
  producer: "producer",
  engineer: "engineer",
  organisation: "organisation",
  public_info: "publicInfo",
  author: "author",
  personal_notes: "personalNotes",
};

const yes = (value: string) => value === "true" || value === "1";

export const session: Family = {
  name: "session",
  events: {
    create_session(ctx, f) {
      ctx.model.meta.name = f.str("name");
    },
    set_meta(ctx, f) {
      const field = f.str("field");
      const value = f.str("value");
      const meta = ctx.model.meta;
      const text = texts[field];
      if (text) (meta[text] as string) = value;
      else if (field === "frame_rate") {
        // ControlRoom keeps the rate it had where the value is not one.
        if ((frameRates as readonly string[]).includes(value)) meta.frameRate = value as FrameRate;
        else
          ctx.report.problem(
            `set_meta: "${value.slice(0, 12)}" is not a frame rate, so it changes nothing (as in ControlRoom)`,
          );
      } else if (field === "lifecycle_enabled") meta.lifecycleEnabled = yes(value);
      else if (field === "per_score_takes") meta.perScoreTakes = yes(value);
      else if (field === "score_order")
        meta.scoreOrder = value === "schedule" ? "schedule" : "alpha";
      else ctx.report.unknownField("set_meta", field || "(no field)");
    },
    set_notes(ctx, f) {
      ctx.model.meta.notes = f.str("notes");
    },
  },
};
