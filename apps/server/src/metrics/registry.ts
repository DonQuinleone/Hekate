/**
 * Prometheus metrics (#70), written in the text exposition format without a library: a
 * counter only rises, a gauge is set (often at scrape time, from the database), a histogram
 * counts observations into buckets. Every label set is chosen by the code, never by a
 * request, so a metric's series stay few.
 */

export type Labels = Record<string, string>;

interface Family {
  name: string;
  help: string;
  type: "counter" | "gauge" | "histogram";
  lines(): string[];
}

/** Request and job durations, in seconds: from 5 ms to two minutes. */
export const DEFAULT_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120,
];

const NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** A label value as the format quotes it: backslashes, quotes and line ends escaped. */
const escapeValue = (value: string) =>
  value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

/** `{a="1",b="2"}` for labels in the order the metric names them; nothing for none. */
function labelText(names: readonly string[], labels: Labels, extra?: [string, string]): string {
  const pairs = names.map((n) => `${n}="${escapeValue(labels[n] ?? "")}"`);
  if (extra) pairs.push(`${extra[0]}="${escapeValue(extra[1])}"`);
  return pairs.length ? `{${pairs.join(",")}}` : "";
}

/** A number as the format writes it. */
const numberText = (n: number) =>
  Number.isNaN(n) ? "NaN" : n === Infinity ? "+Inf" : n === -Infinity ? "-Inf" : String(n);

/** The key a label set is kept under: its values in the metric's order. */
const keyOf = (names: readonly string[], labels: Labels) =>
  JSON.stringify(names.map((n) => labels[n] ?? ""));

export interface Counter<L extends string> {
  inc(labels?: Partial<Record<L, string>>, by?: number): void;
}
export interface Gauge<L extends string> {
  set(labels: Partial<Record<L, string>>, value: number): void;
  /** Forget every series, before setting afresh those that still exist. */
  reset(): void;
}
export interface Histogram<L extends string> {
  observe(labels: Partial<Record<L, string>>, value: number): void;
}

export interface Registry {
  counter<L extends string>(name: string, help: string, labels?: readonly L[]): Counter<L>;
  gauge<L extends string>(name: string, help: string, labels?: readonly L[]): Gauge<L>;
  histogram<L extends string>(
    name: string,
    help: string,
    labels?: readonly L[],
    buckets?: readonly number[],
  ): Histogram<L>;
  /** Work done before each scrape, such as gauges read from the database. */
  onCollect(collect: () => Promise<void>): void;
  /** Every metric, in the text format, after the collectors have run. */
  render(): Promise<string>;
}

export function createRegistry(): Registry {
  const families: Family[] = [];
  const collectors: (() => Promise<void>)[] = [];
  const add = (family: Family, labels: readonly string[]) => {
    if (!NAME.test(family.name)) throw new Error(`Not a metric name: ${family.name}`);
    for (const l of labels) if (!LABEL.test(l)) throw new Error(`Not a label name: ${l}`);
    if (families.some((f) => f.name === family.name)) {
      throw new Error(`The metric ${family.name} is already registered`);
    }
    families.push(family);
  };

  return {
    counter(name, help, names = []) {
      const series = new Map<string, { labels: Labels; value: number }>();
      add(
        {
          name,
          help,
          type: "counter",
          lines: () =>
            [...series.values()].map(
              (s) => `${name}${labelText(names, s.labels)} ${numberText(s.value)}`,
            ),
        },
        names,
      );
      return {
        inc(labels = {}, by = 1) {
          if (!(by >= 0)) throw new Error("A counter only rises");
          const key = keyOf(names, labels as Labels);
          const s = series.get(key) ?? { labels: { ...(labels as Labels) }, value: 0 };
          s.value += by;
          series.set(key, s);
        },
      };
    },
    gauge(name, help, names = []) {
      const series = new Map<string, { labels: Labels; value: number }>();
      add(
        {
          name,
          help,
          type: "gauge",
          lines: () =>
            [...series.values()].map(
              (s) => `${name}${labelText(names, s.labels)} ${numberText(s.value)}`,
            ),
        },
        names,
      );
      return {
        set(labels, value) {
          series.set(keyOf(names, labels as Labels), { labels: { ...(labels as Labels) }, value });
        },
        reset() {
          series.clear();
        },
      };
    },
    histogram(name, help, names = [], buckets = DEFAULT_BUCKETS) {
      const bounds = [...buckets].sort((a, b) => a - b);
      const series = new Map<
        string,
        { labels: Labels; counts: number[]; sum: number; count: number }
      >();
      add(
        {
          name,
          help,
          type: "histogram",
          lines: () =>
            [...series.values()].flatMap((s) => [
              ...bounds.map(
                (le, i) =>
                  `${name}_bucket${labelText(names, s.labels, ["le", numberText(le)])} ${s.counts[i]}`,
              ),
              `${name}_bucket${labelText(names, s.labels, ["le", "+Inf"])} ${s.count}`,
              `${name}_sum${labelText(names, s.labels)} ${numberText(s.sum)}`,
              `${name}_count${labelText(names, s.labels)} ${s.count}`,
            ]),
        },
        names,
      );
      return {
        observe(labels, value) {
          const key = keyOf(names, labels as Labels);
          const s = series.get(key) ?? {
            labels: { ...(labels as Labels) },
            counts: bounds.map(() => 0),
            sum: 0,
            count: 0,
          };
          // Buckets are cumulative: each counts everything at or below its bound.
          bounds.forEach((le, i) => {
            if (value <= le) s.counts[i] = (s.counts[i] ?? 0) + 1;
          });
          s.sum += value;
          s.count += 1;
          series.set(key, s);
        },
      };
    },
    onCollect(collect) {
      collectors.push(collect);
    },
    async render() {
      // A collector that fails leaves its metrics as they were rather than failing the scrape.
      await Promise.all(
        collectors.map((c) =>
          c().catch((error: unknown) =>
            console.warn(`Could not collect some metrics: ${String(error)}`),
          ),
        ),
      );
      return `${families
        .flatMap((f) => [
          `# HELP ${f.name} ${f.help.replace(/\\/g, "\\\\").replace(/\n/g, "\\n")}`,
          `# TYPE ${f.name} ${f.type}`,
          ...f.lines(),
        ])
        .join("\n")}\n`;
    },
  };
}
