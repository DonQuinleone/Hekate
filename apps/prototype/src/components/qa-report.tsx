import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { SeverityDot } from "~/components/status";
import type {
  ReportCrop as FindingCrop,
  QaReportDoc as QaDocument,
  ReportSeverity as QaSeverity,
  ReportFinding,
} from "~/data/qa-report";
import { cn } from "~/lib/cn";
import { formatClock } from "~/lib/format";

type LoudnessGauge = NonNullable<QaDocument["summary"]["gauge"]>;
type LoudnessCurve = NonNullable<QaDocument["appendix"]["curve"]>;
type RuleLine = QaDocument["appendix"]["rules"][number];

/** A level as a page writes it: one decimal, a true minus sign. */
const decibels = (n: number, digits = 1) => n.toFixed(digits).replace("-", "−");
/** Where a level falls on a scale, 0 at its foot to 1 at its top. */
const scaleAt = (scale: { min: number; max: number }, value: number) =>
  Math.min(1, Math.max(0, (value - scale.min) / (scale.max - scale.min)));
const qaSeverityNames: Record<QaSeverity, string> = {
  fail: "Fails",
  warn: "Worth a look",
  info: "Note",
  pass: "Passes",
};

/**
 * The QA report as a page (#515, decision 293): the same document the PDF sets, from the same
 * structure, for reading in the app and on a phone. The cover's verdict, the summary (loudness
 * on its gauge, the measures, the findings counted, the format and metadata), the findings by
 * severity then time, each with its crop of the waveform and what to do, and the appendices.
 * Each moment opens the file there. The app's page (apps/web) is built from this one.
 */
export function QaReportDocument({ doc }: { doc: QaDocument }) {
  const version = [
    doc.file.version !== null ? `Version ${doc.file.version}` : null,
    doc.file.variant,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <article className="flex flex-col gap-12" aria-label="QA report">
      <header className="flex flex-col gap-6">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="m-0 truncate text-[28px] font-medium leading-9 tracking-[-0.02em] text-ink">
            {doc.file.track ?? doc.file.name.replace(/\.[^.]+$/, "")}
          </h2>
          {version && <p className="m-0 text-[15px] text-ink-2">{version}</p>}
          <p className="m-0 truncate text-[13px] text-ink-3">{doc.file.name}</p>
        </div>
        <Verdict doc={doc} />
        <dl className="m-0 grid grid-cols-2 gap-x-6 gap-y-4 @3xl/app:grid-cols-4">
          <Fact label="Project">{doc.project}</Fact>
          <Fact label="Prepared by">
            {doc.preparedBy.name}
            {doc.preparedBy.role ? `, ${doc.preparedBy.role}` : ""}
          </Fact>
          <Fact label="Prepared">{doc.preparedOn}</Fact>
          <Fact label="Measured">{doc.measuredOn ?? "Not yet"}</Fact>
        </dl>
      </header>

      <Section title="Loudness" hint={`Against ${doc.profile}`}>
        <Loudness doc={doc} />
      </Section>

      <Section title="Findings" hint={counted(doc)}>
        <Counts counts={doc.summary.counts} />
        {doc.status !== "ready" ? (
          <p className="m-0 text-[14px] text-ink-2">{doc.verdict.words}</p>
        ) : doc.groups.length === 0 ? (
          <p className="m-0 text-[14px] text-ink-2">Nothing to report: every check passes.</p>
        ) : (
          doc.groups.map((group) => (
            <section key={group.severity} aria-label={group.label} className="flex flex-col">
              <h3 className="m-0 flex items-center gap-2 border-b border-ink-3/60 pb-2 text-[14px] font-medium text-ink border-solid">
                <SeverityDot severity={group.severity} />
                {group.label}
                <span className="tabular ml-auto text-[13px] font-normal text-ink-3">
                  {group.findings.length}
                </span>
              </h3>
              <ul className="m-0 list-none p-0">
                {group.findings.map((f) => (
                  <Finding key={`${f.check}-${f.start}-${f.end}-${f.heard}`} doc={doc} f={f} />
                ))}
              </ul>
            </section>
          ))
        )}
      </Section>

      <Section title="Format and metadata">
        <Table
          rows={doc.appendix.format.length > 0 ? doc.appendix.format : [["Format", "Not read"]]}
        />
      </Section>

      <Section title="Loudness over the whole file" hint="Short-term, LUFS">
        {doc.appendix.curve ? (
          <Curve curve={doc.appendix.curve} />
        ) : (
          <p className="m-0 text-[14px] text-ink-2">Not measured.</p>
        )}
      </Section>

      <Section title="Rules checked">
        <Rules doc={doc} />
      </Section>
    </article>
  );
}

const counted = (doc: QaDocument) => {
  const problems = doc.groups.reduce((n, g) => n + g.findings.length, 0);
  return `${problems} ${problems === 1 ? "finding" : "findings"}`;
};

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-4">
      <div className="flex items-baseline gap-3 border-b border-line pb-2 border-solid">
        <h2 className="m-0 text-[15px] font-medium text-ink">{title}</h2>
        {hint && <span className="ml-auto truncate text-[13px] text-ink-3">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 border-t border-line pt-2 border-solid">
      <dt className="text-[12px] text-ink-3">{label}</dt>
      <dd className="m-0 truncate text-[14px] text-ink">{children}</dd>
    </div>
  );
}

/** The verdict in one line, by the signal's bar and the severity's dot. */
export function Verdict({ doc }: { doc: Pick<QaDocument, "verdict" | "profile"> }) {
  const tone = doc.verdict.tone;
  return (
    <div
      className={cn(
        "flex items-start gap-3 border-l-[3px] py-1 pl-4 border-solid",
        tone === "pass" || tone === "pending" ? "border-ink-3" : "border-signal",
      )}
    >
      <span className="mt-2.5 flex">
        <SeverityDot severity={tone === "pending" ? "info" : tone} />
      </span>
      <div className="flex min-w-0 flex-col gap-1">
        <p className="m-0 text-[19px] font-medium leading-7 text-ink">{doc.verdict.words}</p>
        <p className="m-0 text-[13px] text-ink-2">Measured against {doc.profile}</p>
      </div>
    </div>
  );
}

function Loudness({ doc }: { doc: QaDocument }) {
  const s = doc.summary;
  const g = s.gauge;
  const off = s.integrated !== null && g?.target != null ? s.integrated - g.target : null;
  return (
    <div className="flex flex-col gap-6">
      {s.integrated === null ? (
        <p className="m-0 text-[14px] text-ink-2">Integrated loudness was not measured.</p>
      ) : (
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="tabular text-[34px] font-medium leading-10 tracking-[-0.02em] text-ink">
            {decibels(s.integrated)}
          </span>
          <span className="text-[13px] text-ink-2">LUFS integrated</span>
          {off !== null && g?.target != null && (
            <span className="text-[13px] text-ink-2 @3xl/app:ml-auto">
              {Math.abs(off) <= (g.tolerance ?? 0)
                ? `On the ${decibels(g.target, 0)} LUFS target`
                : `${decibels(Math.abs(off))} LU ${off > 0 ? "above" : "below"} the ${decibels(g.target, 0)} LUFS target`}
            </span>
          )}
        </div>
      )}
      {g && <Gauge gauge={g} />}
      <dl className="m-0 grid grid-cols-3 border-y border-line border-solid">
        <Stat
          label="True peak"
          value={s.truePeak === null ? "Not measured" : `${decibels(s.truePeak)} dBTP`}
          caption={`Ceiling ${decibels(s.ceiling)} dBTP`}
          severity={s.truePeak === null ? null : s.truePeak > s.ceiling ? "fail" : "pass"}
        />
        <Stat
          label="Loudness range"
          value={s.range === null ? "Not measured" : `${decibels(s.range)} LU`}
          caption="LRA"
        />
        <Stat
          label="Short-term max"
          value={s.shortTermMax === null ? "Not measured" : `${decibels(s.shortTermMax)} LUFS`}
          caption="Over 3 seconds"
        />
      </dl>
    </div>
  );
}

function Stat({
  label,
  value,
  caption,
  severity = null,
}: {
  label: string;
  value: string;
  caption: string;
  severity?: QaSeverity | null;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 py-3 pr-3 [&+&]:border-l [&+&]:border-line [&+&]:pl-3 @3xl/app:[&+&]:pl-5 border-solid">
      <dt className="truncate text-[12px] text-ink-3">{label}</dt>
      <dd className="tabular m-0 truncate text-[17px] font-medium text-ink">{value}</dd>
      <dd className="m-0 flex min-w-0 items-center gap-1.5 text-[12px] text-ink-2">
        {severity && <SeverityDot severity={severity} />}
        <span className="truncate">{caption}</span>
      </dd>
    </div>
  );
}

/** Integrated loudness on its scale: the target's band in the signal, the value's needle. */
export function Gauge({ gauge: g }: { gauge: LoudnessGauge }) {
  const at = (v: number) => `${scaleAt(g, v) * 100}%`;
  return (
    <figure className="m-0 flex flex-col gap-1" aria-label="Integrated loudness against the target">
      <div className="relative h-5">
        {g.value !== null && (
          <span
            className="tabular absolute bottom-0 -translate-x-1/2 whitespace-nowrap text-[12px] font-medium text-ink"
            style={{ left: `clamp(2.5rem, ${at(g.value)}, calc(100% - 2.5rem))` }}
          >
            {decibels(g.value)} LUFS
          </span>
        )}
      </div>
      <div className="relative h-3 rounded-chip bg-raised">
        {g.zones.map((z) =>
          z.to > z.from ? (
            <span
              key={`${z.from}-${z.to}`}
              className={cn(
                "absolute inset-y-0",
                z.tone === "pass" ? "bg-signal/35" : "bg-signal/12",
              )}
              style={{ left: at(z.from), width: `calc(${at(z.to)} - ${at(z.from)})` }}
            />
          ) : null,
        )}
        {g.target !== null && (
          <span
            className="absolute -inset-y-1 w-px -translate-x-1/2 bg-signal"
            style={{ left: at(g.target) }}
          />
        )}
        {g.value !== null && (
          <span
            data-e2e-overlap
            className="absolute -inset-y-1 w-0.5 -translate-x-1/2 rounded-full bg-ink"
            style={{ left: at(g.value) }}
          />
        )}
      </div>
      <div className="relative h-4" aria-hidden="true">
        {g.ticks.map((t, i) => (
          <span
            key={t}
            className={cn(
              "tabular absolute top-0.5 text-[11px]",
              i === 0 ? "" : i === g.ticks.length - 1 ? "-translate-x-full" : "-translate-x-1/2",
              t === g.target ? "font-medium text-signal" : "text-ink-3",
              // On a phone every other number, so they never crowd; the target's always.
              i % 2 === 1 && t !== g.target && i !== g.ticks.length - 1 && "hidden @3xl/app:block",
            )}
            style={{ left: at(t) }}
          >
            {decibels(t, 0)}
          </span>
        ))}
      </div>
    </figure>
  );
}

function Counts({ counts }: { counts: QaDocument["summary"]["counts"] }) {
  return (
    <dl className="m-0 grid grid-cols-2 gap-x-6 gap-y-3 pb-3 @3xl/app:grid-cols-4">
      {(["fail", "warn", "info", "pass"] as const).map((severity) => (
        <div key={severity} className="flex items-center gap-2.5">
          <SeverityDot severity={severity} />
          <dd className="tabular m-0 text-[20px] font-medium text-ink">{counts[severity]}</dd>
          <dt className="text-[13px] text-ink-2">{qaSeverityNames[severity]}</dt>
        </div>
      ))}
    </dl>
  );
}

function Finding({ doc, f }: { doc: QaDocument; f: ReportFinding }) {
  const at =
    f.start !== null ? (
      <Link
        to="/files/$fileId"
        params={{ fileId: doc.file.id }}
        search={{ view: "qa" }}
        aria-label={`Open the file at ${f.at}`}
        className="tabular inline-flex min-h-7 items-center text-[13px] font-medium text-ink no-underline hover:text-signal"
      >
        {f.at}
      </Link>
    ) : (
      <span className="text-[13px] font-medium text-ink">{f.at}</span>
    );
  if (!f.illustrated)
    return (
      <li className="grid grid-cols-1 gap-x-6 gap-y-0.5 border-b border-line py-2 @3xl/app:grid-cols-[160px_1fr] border-solid">
        <span>{at}</span>
        <span className="text-[13px] text-ink-2">{f.heard}</span>
      </li>
    );
  return (
    <li className="grid grid-cols-1 gap-x-6 gap-y-2 border-b border-line py-4 @3xl/app:grid-cols-[160px_1fr] border-solid">
      <div className="flex flex-wrap items-baseline gap-x-3 @3xl/app:flex-col @3xl/app:gap-0.5">
        {at}
        {f.channel && <span className="text-[12px] text-ink-3">{f.channel}</span>}
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        <h4 className="m-0 text-[14px] font-medium text-ink">{f.name}</h4>
        <p className="m-0 text-[13px] text-ink-2">{f.heard}</p>
        {f.crop && <Crop crop={f.crop} />}
        <div className="flex flex-col gap-0.5">
          <span className="text-[12px] font-medium text-ink-3">What to do</span>
          <p className="m-0 text-[13px] text-ink">{f.advice}</p>
        </div>
      </div>
    </li>
  );
}

/** The waveform around a finding, its stretch in the signal. */
export function Crop({ crop }: { crop: FindingCrop }) {
  const span = crop.to - crop.from || 1;
  const x = (t: number) => ((t - crop.from) / span) * 160;
  const from = x(crop.markFrom);
  const width = Math.max(0.8, x(crop.markTo) - from);
  return (
    <figure className="m-0 flex flex-col gap-1">
      <svg
        viewBox="0 0 160 40"
        preserveAspectRatio="none"
        className="h-14 w-full rounded-chip bg-raised/60"
        role="img"
        aria-label={`The waveform from ${formatClock(crop.from)} to ${formatClock(crop.to)}, the finding marked`}
      >
        <rect x={from} y={0} width={width} height={40} className="fill-signal/15" />
        {crop.envelope ? (
          crop.envelope.map(([low, high], i) => {
            const t = crop.from + ((i + 0.5) / (crop.envelope?.length ?? 1)) * span;
            const inside = t >= crop.markFrom && t <= crop.markTo;
            return (
              <rect
                key={i}
                x={i + 0.15}
                width={0.7}
                y={20 - high * 18}
                height={Math.max(0.3, (high - low) * 18)}
                className={inside ? "fill-signal" : "fill-ink-3"}
              />
            );
          })
        ) : (
          <line x1={0} x2={160} y1={20} y2={20} className="stroke-hairline" strokeWidth={0.4} />
        )}
        <line
          x1={from}
          x2={from}
          y1={0}
          y2={40}
          className="stroke-signal"
          strokeWidth={0.5}
          vectorEffect="non-scaling-stroke"
        />
        <line
          x1={from + width}
          x2={from + width}
          y1={0}
          y2={40}
          className="stroke-signal"
          strokeWidth={0.5}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <figcaption className="tabular flex justify-between text-[11px] text-ink-3">
        <span>{formatClock(crop.from)}</span>
        <span>{formatClock(crop.to)}</span>
      </figcaption>
    </figure>
  );
}

function Table({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="m-0 grid grid-cols-[minmax(0,140px)_1fr] text-[13px] @3xl/app:grid-cols-[200px_1fr]">
      {rows.map(([label, value], i) => (
        <div key={i} className="contents">
          <dt className="truncate border-b border-line py-2 pr-3 text-ink-3 border-solid">
            {label}
          </dt>
          <dd className="m-0 min-w-0 break-words border-b border-line py-2 text-ink border-solid">
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Short-term loudness over the whole file, the target's band in the signal. */
function Curve({ curve: c }: { curve: LoudnessCurve }) {
  const width = 600;
  const height = 160;
  const y = (v: number) => (1 - scaleAt(c, v)) * height;
  const step = width / Math.max(1, c.points.length);
  let path = "";
  let open = false;
  c.points.forEach((v, i) => {
    if (v === null) {
      open = false;
      return;
    }
    path += `${open ? "L" : "M"}${((i + 0.5) * step).toFixed(1)} ${y(Math.max(c.min, v)).toFixed(1)} `;
    open = true;
  });
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800];
  const every = steps.find((s) => c.duration / s <= 6) ?? 3600;
  const times: number[] = [];
  for (let t = 0; t <= c.duration + 0.001; t += every) times.push(t);
  return (
    <figure className="m-0 flex flex-col gap-1">
      <div className="flex gap-2">
        <div className="relative w-8 shrink-0" style={{ height }} aria-hidden="true">
          {c.ticks.map((t) => (
            <span
              key={t}
              className="tabular absolute right-0 -translate-y-1/2 text-[11px] text-ink-3"
              style={{ top: y(t) }}
            >
              {decibels(t, 0)}
            </span>
          ))}
        </div>
        <svg
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          className="min-w-0 flex-1"
          style={{ height }}
          role="img"
          aria-label="Short-term loudness over the whole file"
        >
          {c.target !== null && c.tolerance !== null && (
            <rect
              x={0}
              width={width}
              y={y(c.target + c.tolerance)}
              height={y(c.target - c.tolerance) - y(c.target + c.tolerance)}
              className="fill-signal/15"
            />
          )}
          {c.ticks.map((t) => (
            <line
              key={t}
              x1={0}
              x2={width}
              y1={y(t)}
              y2={y(t)}
              className="stroke-hairline"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {c.target !== null && (
            <line
              x1={0}
              x2={width}
              y1={y(c.target)}
              y2={y(c.target)}
              className="stroke-signal"
              strokeDasharray="4 3"
              vectorEffect="non-scaling-stroke"
            />
          )}
          <path
            d={path}
            className="fill-none stroke-ink"
            strokeWidth={1.25}
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      </div>
      <div className="relative ml-10 h-4" aria-hidden="true">
        {times.map((t, i) => (
          <span
            key={t}
            className={cn(
              "tabular absolute text-[11px] text-ink-3",
              i === 0 ? "" : t / c.duration > 0.97 ? "-translate-x-full" : "-translate-x-1/2",
            )}
            style={{ left: `${(t / (c.duration || 1)) * 100}%` }}
          >
            {formatClock(t).replace(/\.\d+$/, "")}
          </span>
        ))}
      </div>
    </figure>
  );
}

const ruleSources: [RuleLine["source"], (doc: QaDocument) => string][] = [
  ["profile", (doc) => `Delivery profile: ${doc.profile}`],
  ["signal", () => "Signal checks"],
  ["project", () => "The project's own rules"],
];

function Rules({ doc }: { doc: QaDocument }) {
  return (
    <div className="flex flex-col gap-6">
      {ruleSources.map(([source, title]) => {
        const lines = doc.appendix.rules.filter((r) => r.source === source);
        if (lines.length === 0) return null;
        return (
          <table key={source} className="w-full border-collapse text-[13px]">
            <caption className="pb-1 text-left text-[13px] font-medium text-ink-2">
              {title(doc)}
            </caption>
            <thead className="sr-only">
              <tr>
                <th scope="col">Rule</th>
                <th scope="col">Asked</th>
                <th scope="col">Result</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <tr
                  key={`${line.label}-${line.asked}`}
                  className="border-b border-line border-solid"
                >
                  <th scope="row" className="py-2 pr-3 text-left font-normal text-ink">
                    {line.label}
                    {/* On a phone what was asked goes under the rule rather than in a column. */}
                    <span className="block text-[12px] text-ink-3 @3xl/app:hidden">
                      {line.asked}
                    </span>
                  </th>
                  <td className="hidden py-2 pr-3 text-ink-2 @3xl/app:table-cell">{line.asked}</td>
                  <td className="w-[124px] py-2">
                    <span className="flex items-center gap-2 text-ink">
                      {line.result ? (
                        <>
                          <SeverityDot severity={line.result} />
                          {qaSeverityNames[line.result]}
                        </>
                      ) : (
                        <span className="text-ink-3">Not measured</span>
                      )}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        );
      })}
    </div>
  );
}
