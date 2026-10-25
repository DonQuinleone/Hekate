import type { ReportCollector } from "./model.ts";

/**
 * Reading an event's payload without trusting its shape (decision 242). Each read names the
 * fields that might hold a value, the first present wins, and a value of the wrong kind is a
 * problem in the report rather than a failure. Whatever the payload holds that nothing read is
 * reported as an unknown field when the event is done with, so a field name the mapping guessed
 * wrong shows up in the preview instead of vanishing.
 */
export interface Fields {
  /** Whether any of the names is present (null counts as present: it clears). */
  has(...names: string[]): boolean;
  str(...names: string[]): string | undefined;
  /** A string, or null where the payload clears it; undefined where it does not say. */
  strOrNull(...names: string[]): string | null | undefined;
  num(...names: string[]): number | undefined;
  int(...names: string[]): number | undefined;
  intOrNull(...names: string[]): number | null | undefined;
  bool(...names: string[]): boolean | undefined;
  /** An id: a number or a string, read as a string. */
  id(...names: string[]): string | null | undefined;
  ids(...names: string[]): string[] | undefined;
  ints(...names: string[]): number[] | undefined;
  list(...names: string[]): unknown[] | undefined;
  /** A nested object, read with its own fields under `type.field`. */
  object(...names: string[]): Fields | undefined;
  /** The value as written, of whatever kind, for a field that may take more than one form. */
  raw(...names: string[]): unknown;
  /** Marks names as read without reading them: fields the import knows and sets aside. */
  skip(...names: string[]): void;
  /** Marks every field as read: an event set aside whole, whose fields say nothing new. */
  skipAll(): void;
  /** Reports what was never read. */
  done(): void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function fieldsOf(payload: unknown, type: string, report: ReportCollector): Fields {
  const record = isRecord(payload) ? payload : {};
  const read = new Set<string>();
  const children: Fields[] = [];

  const find = (names: string[]): { name: string; value: unknown } | undefined => {
    for (const name of names) read.add(name);
    for (const name of names) if (name in record) return { name, value: record[name] };
    return undefined;
  };
  const wrong = (name: string, expected: string) =>
    report.problem(`${type}: ${name} is not ${expected}, so it was left out`);

  const asNumber = (name: string, value: unknown): number | undefined => {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)))
      return Number(value);
    wrong(name, "a number");
    return undefined;
  };

  const fields: Fields = {
    has: (...names) => names.some((n) => n in record),
    str(...names) {
      const found = find(names);
      if (!found || found.value == null) return undefined;
      if (typeof found.value === "string") return found.value;
      if (typeof found.value === "number" || typeof found.value === "boolean")
        return String(found.value);
      wrong(found.name, "text");
      return undefined;
    },
    strOrNull(...names) {
      const found = find(names);
      if (!found) return undefined;
      if (found.value === null || found.value === "") return null;
      return fields.str(found.name);
    },
    num(...names) {
      const found = find(names);
      if (!found || found.value == null) return undefined;
      return asNumber(found.name, found.value);
    },
    int(...names) {
      const n = fields.num(...names);
      return n === undefined ? undefined : Math.round(n);
    },
    intOrNull(...names) {
      const found = find(names);
      if (!found) return undefined;
      if (found.value === null || found.value === "") return null;
      const n = asNumber(found.name, found.value);
      return n === undefined ? undefined : Math.round(n);
    },
    bool(...names) {
      const found = find(names);
      if (!found || found.value == null) return undefined;
      const v = found.value;
      if (typeof v === "boolean") return v;
      if (v === 1 || v === "1" || v === "true" || v === "yes") return true;
      if (v === 0 || v === "0" || v === "false" || v === "no") return false;
      wrong(found.name, "yes or no");
      return undefined;
    },
    id(...names) {
      const found = find(names);
      if (!found) return undefined;
      if (found.value === null || found.value === "") return null;
      if (typeof found.value === "number" || typeof found.value === "string")
        return String(found.value);
      // An entry given whole, { id: 7, … }: its id.
      if (isRecord(found.value) && "id" in found.value) {
        const inner = found.value.id;
        if (typeof inner === "number" || typeof inner === "string") return String(inner);
      }
      wrong(found.name, "an id");
      return undefined;
    },
    ids(...names) {
      const found = find(names);
      if (!found || found.value == null) return undefined;
      if (!Array.isArray(found.value)) {
        wrong(found.name, "a list");
        return undefined;
      }
      return found.value
        .map((v) =>
          typeof v === "number" || typeof v === "string"
            ? String(v)
            : isRecord(v) && (typeof v.id === "number" || typeof v.id === "string")
              ? String(v.id)
              : null,
        )
        .filter((v): v is string => v !== null);
    },
    ints(...names) {
      const found = find(names);
      if (!found || found.value == null) return undefined;
      const values = Array.isArray(found.value)
        ? found.value
        : typeof found.value === "string"
          ? found.value.split(/[\s,;]+/).filter(Boolean)
          : [found.value];
      const numbers = values
        .map((v) => (typeof v === "string" ? Number(v.replace(/^t/i, "")) : Number(v)))
        .filter((n) => Number.isInteger(n));
      if (numbers.length !== values.length) wrong(found.name, "a list of numbers");
      return numbers;
    },
    list(...names) {
      const found = find(names);
      if (!found || found.value == null) return undefined;
      if (Array.isArray(found.value)) return found.value;
      wrong(found.name, "a list");
      return undefined;
    },
    object(...names) {
      const found = find(names);
      if (!found || found.value == null) return undefined;
      if (!isRecord(found.value)) {
        wrong(found.name, "a set of fields");
        return undefined;
      }
      const child = fieldsOf(found.value, `${type}.${found.name}`, report);
      children.push(child);
      return child;
    },
    raw(...names) {
      return find(names)?.value;
    },
    skip(...names) {
      for (const name of names) read.add(name);
    },
    skipAll() {
      for (const name of Object.keys(record)) read.add(name);
    },
    done() {
      for (const name of Object.keys(record)) if (!read.has(name)) report.unknownField(type, name);
      for (const child of children) child.done();
    },
  };
  return fields;
}

/** Each element of a list read as fields of its own, for nested entries (a box's channels). */
export function eachFields(
  values: unknown[] | undefined,
  type: string,
  report: ReportCollector,
): Fields[] {
  return (values ?? []).map((v) => fieldsOf(v, type, report));
}
