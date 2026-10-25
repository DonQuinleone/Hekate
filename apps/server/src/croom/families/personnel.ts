import { aliases, crud, type Family, or, type ReplayContext } from "../family.ts";
import { eachFields, type Fields } from "../fields.ts";
import type { CrPerson, CrSection } from "../model.ts";
import { keyOf } from "./values.ts";

/**
 * Personnel (provisional, decision 242): `add_person` with `name`, `kind` (artist, ensemble,
 * staff or other, and some likely synonyms), `role`, `agreement`, `headphones`, `seating`, and
 * for an ensemble its `sections`, each with `name`, `count`, `divisi` and `members` (names, or
 * entries with their own `agreement` and `headphones`).
 */
const kinds: Record<string, CrPerson["kind"]> = {
  artist: "artist",
  soloist: "artist",
  conductor: "artist",
  performer: "artist",
  musician: "artist",
  ensemble: "ensemble",
  orchestra: "ensemble",
  choir: "ensemble",
  band: "ensemble",
  group: "ensemble",
  staff: "staff",
  crew: "staff",
  production: "staff",
  engineer: "staff",
  producer: "staff",
  other: "other",
};

function readSections(f: Fields, ctx: ReplayContext): CrSection[] | undefined {
  const listed = f.list("sections", "parts");
  if (listed === undefined) return undefined;
  return eachFields(listed, `${ctx.type}.sections`, ctx.report).map((s) => {
    const members = (s.list("members", "players", "names") ?? []).map((m) => {
      if (typeof m === "string") return { name: m, agreement: false, headphones: false };
      const mf = eachFields([m], `${ctx.type}.sections.members`, ctx.report)[0] as Fields;
      const member = {
        name: mf.str("name") ?? "",
        agreement: mf.bool("agreement", "session_agreement", "signed") ?? false,
        headphones: mf.bool("headphones", "needs_headphones", "cans") ?? false,
      };
      mf.done();
      return member;
    });
    const section: CrSection = {
      name: s.str("name", "title", "label") ?? "",
      count: Math.max(s.int("count", "size", "players_count", "headcount") ?? 0, members.length),
      divisi: s.str("divisi", "split") ?? "",
      members: members.filter((m) => m.name.trim() !== ""),
    };
    s.done();
    return section;
  });
}

const person = crud<CrPerson>(
  "person",
  (m) => m.personnel,
  (id) => ({
    id,
    name: "",
    kind: "other",
    role: "",
    agreement: false,
    headphones: false,
    seating: "",
    sections: [],
  }),
  (f, base, ctx) => {
    const kindWritten = f.str("kind", "type", "category", "group");
    let kind = base.kind;
    if (kindWritten !== undefined) {
      const found = kinds[keyOf(kindWritten)];
      if (!found)
        ctx.report.problem(
          `${ctx.type}: "${kindWritten.slice(0, 30)}" is not a kind of personnel Hekate has, so it is listed as other`,
        );
      kind = found ?? "other";
    }
    return {
      ...base,
      kind,
      name: or(f.str("name", "full_name", "title"), base.name),
      role: or(f.str("role", "instrument", "position", "job"), base.role),
      agreement: or(
        f.bool("agreement", "session_agreement", "agreement_signed", "signed"),
        base.agreement,
      ),
      headphones: or(f.bool("headphones", "needs_headphones", "cans"), base.headphones),
      seating: or(f.str("seating", "seating_notes", "forces"), base.seating),
      sections: or(readSections(f, ctx), base.sections),
    };
  },
);

export const personnel: Family = {
  name: "personnel",
  nouns: aliases(["person", "personnel", "people", "contact"], person),
};
