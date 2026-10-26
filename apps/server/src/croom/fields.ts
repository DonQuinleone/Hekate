import type { ReportCollector } from "./model.ts";

/**
 * Reading an event's payload as ControlRoom's own reader does (`events_deserialize.cpp`,
 * decision 242): each field by its one name, and a field the payload leaves out takes the
 * default ControlRoom gives it, so a file from an older version reads as it does there. Where
 * ControlRoom would fail (a field of the wrong kind), the field takes its default and the report
 * says so. Whatever the payload holds that nothing read is reported as an unknown field when the
 * event is done with: a field a newer ControlRoom writes shows up in the preview instead of
 * vanishing.
 */
export interface Fields {
  has(name: string): boolean;
  str(name: string, fallback?: string): string;
  num(name: string, fallback: number): number;
  /** A whole number; a fraction is cut short, as ControlRoom's reader cuts it. */
  int(name: string, fallback: number): number;
  bool(name: string, fallback: boolean): boolean;
  /** An entity id; 0, the file's "none", and a missing field are null. */
  id(name: string): string | null;
  /** A whole number, or null where the payload writes null or leaves it out. */
  intOrNull(name: string): number | null;
  /** Whole numbers: a list of take numbers. */
  ints(name: string): number[];
  list(name: string): unknown[] | undefined;
  /** A nested object, read with its own fields under `type.field`. */
  object(name: string): Fields | undefined;
  /** The value as written, for a field read in more than one form. */
  raw(name: string): unknown;
  /** Marks names as read without reading them. */
  skip(...names: string[]): void;
  /** Marks every field as read. */
  skipAll(): void;
  /** Reports what was never read. */
  done(): void;
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A whole number as ControlRoom reads one from a JSON number, or undefined. */
export const wholeOf = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined;

/** An id as ControlRoom writes one (an unsigned whole number), as a string; 0 is none. */
export function idOf(value: unknown): string | null | undefined {
  const n = wholeOf(value);
  if (n === undefined || n < 0 || n > Number.MAX_SAFE_INTEGER) return undefined;
  return n === 0 ? null : String(n);
}

export function fieldsOf(payload: unknown, type: string, report: ReportCollector): Fields {
  const record = isRecord(payload) ? payload : {};
  const read = new Set<string>();
  const children: Fields[] = [];

  const find = (name: string): { found: boolean; value: unknown } => {
    read.add(name);
    return name in record ? { found: true, value: record[name] } : { found: false, value: null };
  };
  const wrong = (name: string, expected: string) =>
    report.problem(`${type}: ${name} is not ${expected}, so it was left out`);

  const fields: Fields = {
    has: (name) => name in record,
    str(name, fallback = "") {
      const { found, value } = find(name);
      if (!found) return fallback;
      if (typeof value === "string") return value;
      wrong(name, "text");
      return fallback;
    },
    num(name, fallback) {
      const { found, value } = find(name);
      if (!found) return fallback;
      if (typeof value === "number" && Number.isFinite(value)) return value;
      wrong(name, "a number");
      return fallback;
    },
    int(name, fallback) {
      const { found, value } = find(name);
      if (!found) return fallback;
      const n = wholeOf(value);
      if (n !== undefined) return n;
      wrong(name, "a number");
      return fallback;
    },
    bool(name, fallback) {
      const { found, value } = find(name);
      if (!found) return fallback;
      if (typeof value === "boolean") return value;
      wrong(name, "true or false");
      return fallback;
    },
    id(name) {
      const { found, value } = find(name);
      if (!found) return null;
      const id = idOf(value);
      if (id !== undefined) return id;
      wrong(name, "an id");
      return null;
    },
    intOrNull(name) {
      const { found, value } = find(name);
      if (!found || value === null) return null;
      const n = wholeOf(value);
      if (n !== undefined) return n;
      wrong(name, "a number");
      return null;
    },
    ints(name) {
      const { found, value } = find(name);
      if (!found) return [];
      if (!Array.isArray(value)) {
        wrong(name, "a list");
        return [];
      }
      const numbers = value.map(wholeOf).filter((n): n is number => n !== undefined);
      if (numbers.length !== value.length) wrong(name, "a list of numbers");
      return numbers;
    },
    list(name) {
      const { found, value } = find(name);
      if (!found) return undefined;
      if (Array.isArray(value)) return value;
      wrong(name, "a list");
      return undefined;
    },
    object(name) {
      const { found, value } = find(name);
      if (!found) return undefined;
      if (!isRecord(value)) {
        wrong(name, "a set of fields");
        return undefined;
      }
      const child = fieldsOf(value, `${type}.${name}`, report);
      children.push(child);
      return child;
    },
    raw(name) {
      return find(name).value;
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

/**
 * Each element of a list read as fields of its own (a piece's movements, a section's members),
 * and done with once `read` has read it.
 */
export function eachOf<T>(
  values: unknown[] | undefined,
  type: string,
  report: ReportCollector,
  read: (f: Fields, index: number) => T,
): T[] {
  return (values ?? []).map((value, index) => {
    if (!isRecord(value)) report.problem(`${type}: an entry is not a set of fields`);
    const f = fieldsOf(value, type, report);
    const out = read(f, index);
    f.done();
    return out;
  });
}
