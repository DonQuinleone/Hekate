import {
  channelName,
  findingWords,
  formatClock,
  formatSpan,
  type ProfileRef,
  type ProfileSource,
  type QaCheck,
  type QaFinding,
  type QaSeverity,
  qaAttention,
  qaCheckNames,
  qaChecks,
  qaSeverityNames,
  severityCounts,
} from "@hekate/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useEffect, useId, useState } from "react";
import { cn } from "~/lib/cn";
import { type Loop, MIN_LOOP } from "~/lib/loop";
import {
  customProfilesQuery,
  type QaChanges,
  type QaReport,
  qaChangesQuery,
  qaQuery,
  useFileDeliveryProfile,
} from "~/lib/queries";
import { useViewer } from "~/lib/viewer";
import { ProfileOptions } from "./delivery-profiles";
import { Icon } from "./icons";
import { buttonVariants } from "./ui/button";
import { Select } from "./ui/input";

/** Where a file's profile comes from, when it has none of its own. */
const inheritedFrom: Record<ProfileSource, string> = {
  file: "this file",
  track: "the track's",
  project: "the project's",
  workspace: "the workspace's",
  suggested: "suggested",
};

/** What each check is called in the list, and in the project's QA rules. */
export const checkNames = qaCheckNames;
const severityNames = qaSeverityNames;

/** What the checks say before they are ready: still running, or unable to run at all. */
const waitingCopy: Record<Exclude<QaReport["status"], "ready">, string> = {
  pending: "Checking the recording",
  failed: "The checks could not run; replace the file to try again",
  none: "Not checked",
};

/** Severity by the dot's shape and fill, as review status is: never a traffic light. */
export function SeverityDot({ severity }: { severity: QaSeverity }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-[7px] shrink-0 rounded-full",
        severity === "fail" && "bg-signal",
        severity === "warn" && "border-[1.5px] border-signal",
        severity === "info" && "border-[1.5px] border-ink-3",
        severity === "pass" && "size-[5px] bg-ink-3/60",
      )}
    />
  );
}

/** "0:12.400" or "0:12.400–0:13.000" for where a finding is: as every media position (#645). */
const where = (f: QaFinding) => {
  if (f.start === null) return null;
  return f.end !== null && f.end - f.start >= 0.1
    ? formatSpan(f.start, f.end)
    : formatClock(f.start);
};

/** The passage a finding spans, when it is long enough to loop. */
export function findingLoop(f: QaFinding): Loop | null {
  return f.start !== null && f.end !== null && f.end - f.start >= MIN_LOOP
    ? { start: f.start, end: f.end }
    : null;
}

/** One finding: what it is, where, and what can be done from it. Exported for tests. */
export function FindingRow({
  finding,
  onSeek,
  onLoop,
  onComment,
  isNew = false,
  action,
  nested = false,
  sameCheck = false,
}: {
  finding: QaFinding;
  onSeek: (t: number) => void;
  /** Loop the passage it spans, in one action (#44). */
  onLoop?: (loop: Loop) => void;
  /** Write a comment about it, at its moment (#43). */
  onComment?: (finding: QaFinding) => void;
  /** Not found in the previous version (#43). */
  isNew?: boolean;
  /** Beside the summary: opening a group, for one. */
  action?: React.ReactNode;
  /** One of a group's, shown under it. */
  nested?: boolean;
  /** After another finding of the same check: listed under its name, not named again (#564). */
  sameCheck?: boolean;
}) {
  const at = where(finding);
  const loop = onLoop ? findingLoop(finding) : null;
  return (
    <li className="grid grid-cols-[12px_1fr_auto] items-baseline gap-x-3 border-b border-hairline py-2.5 sm:grid-cols-[12px_minmax(0,140px)_1fr_auto]">
      <span className="flex h-4 items-center">
        {!nested && <SeverityDot severity={finding.severity} />}
      </span>
      <span className="label hidden truncate sm:block">
        {nested || sameCheck ? "" : checkNames[finding.check]}
      </span>
      <span className="min-w-0 text-[13px] text-ink-2">
        {/* On a phone the check's name heads the line rather than taking a column. */}
        {!nested && !sameCheck && (
          <span className="label mb-0.5 block sm:hidden">{checkNames[finding.check]}</span>
        )}
        <span className="sr-only">{severityNames[finding.severity]}: </span>
        {/* Under its check's name, the words without it (#564): said once. */}
        {findingWords(finding)}
        {isNew && <span className="ml-2 text-[11px] text-ink-2">new in this version</span>}
        {action && <span className="ml-3">{action}</span>}
      </span>
      <span className="flex items-center gap-2">
        {at && finding.start !== null ? (
          <>
            <button
              type="button"
              onClick={() => onSeek(finding.start ?? 0)}
              aria-label={`Play from ${at}`}
              className="tabular h-6 cursor-pointer rounded-chip border border-edge bg-transparent px-2 text-[11px] text-ink hover:border-signal"
            >
              {at}
            </button>
            {loop && onLoop && (
              <button
                type="button"
                onClick={() => onLoop(loop)}
                aria-label={`Loop ${at}`}
                className="inline-flex min-h-6 min-w-6 cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-xs text-ink-3 hover:text-ink"
              >
                Loop
              </button>
            )}
          </>
        ) : (
          finding.channel !== null && (
            <span className="text-[11px] text-ink-3">{channelName(finding.channel)}</span>
          )
        )}
        {/* Every problem can start a comment: at its moment, or about the whole file. */}
        {onComment && finding.severity !== "pass" && (
          <button
            type="button"
            onClick={() => onComment(finding)}
            aria-label={`Comment on ${at && finding.start !== null ? at : checkNames[finding.check]}`}
            className="inline-flex min-h-6 min-w-6 cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-xs text-ink-3 hover:text-ink"
          >
            Comment
          </button>
        )}
      </span>
    </li>
  );
}

/** Findings in runs of the same check and severity, as `orderFindings` leaves them. */
function groupFindings(findings: readonly QaFinding[]): QaFinding[][] {
  const groups: QaFinding[][] = [];
  for (const f of findings) {
    const last = groups.at(-1);
    if (last?.[0]?.check === f.check && last[0].severity === f.severity) last.push(f);
    else groups.push([f]);
  }
  return groups;
}

/** A finding's key in a list: findings have no id, but no two share all of these. */
const findingKey = (f: QaFinding) => `${f.check}-${f.channel}-${f.start}-${f.end}-${f.summary}`;

/** The problems worth marking on the timeline (#43): failures and warnings that have a place. */
export function findingMarks(findings: readonly QaFinding[]) {
  return findings.flatMap((f) =>
    (f.severity === "fail" || f.severity === "warn") && f.start !== null
      ? [{ start: f.start, end: f.end, severity: f.severity }]
      : [],
  );
}

/** Many findings of one check, as one row that opens into all of them. */
function FindingGroup({
  group,
  onSeek,
  onLoop,
  onComment,
  fresh,
  sameCheck = false,
}: {
  group: QaFinding[];
  /** After a run of the same check: listed under its name (#564). */
  sameCheck?: boolean;
  /** The problems not found in the previous version, by `findingKey` (#43). */
  fresh: ReadonlySet<string>;
  onSeek: (t: number) => void;
  onLoop?: (loop: Loop) => void;
  onComment?: (finding: QaFinding) => void;
}) {
  const [open, setOpen] = useState(false);
  const first = group[0] as QaFinding;
  const channels = new Set(group.map((f) => f.channel).filter((c) => c !== null));
  const what = first.check === "clipping" ? "Clipped" : checkNames[first.check];
  const across =
    channels.size > 1
      ? ", on several channels"
      : channels.size === 1
        ? ` on ${channelName([...channels][0] as number)}`
        : "";
  return (
    <>
      <FindingRow
        finding={{ ...first, summary: `${what} in ${group.length} places${across}`, end: null }}
        onSeek={onSeek}
        // New in this version when any of the places is.
        isNew={group.some((f) => fresh.has(findingKey(f)))}
        sameCheck={sameCheck}
        action={
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className="cursor-pointer border-0 bg-transparent p-0 text-xs text-ink-3 hover:text-ink"
          >
            {open ? "Fewer" : "All"}
          </button>
        }
      />
      {open &&
        group.map((f) => (
          <FindingRow
            key={findingKey(f)}
            finding={f}
            onSeek={onSeek}
            onLoop={onLoop}
            onComment={onComment}
            isNew={fresh.has(findingKey(f))}
            nested
          />
        ))}
    </>
  );
}

/** What the QA list is narrowed to (#43): one severity of problem, one check, or neither. */
export interface FindingFilter {
  severity: Exclude<QaSeverity, "pass"> | null;
  check: QaCheck | null;
}

/** The findings a filter leaves. */
export const filterFindings = (findings: readonly QaFinding[], filter: FindingFilter) =>
  findings.filter(
    (f) =>
      (!filter.severity || f.severity === filter.severity) &&
      (!filter.check || f.check === filter.check),
  );

/**
 * The quality checks of a recording or a video (#41, #42): problems first, worst first, each
 * check named once with its findings under it, each playing from where it is; what passed
 * below, folded. The tally counts checks, as the QA badge and the report do (#564), in the
 * words the report uses. Checked against the nearest delivery profile (the file's own, its
 * track's, its project's or the workspace's), and those who shape the project's workflow can
 * give this file one of its own here. The report opens from the heading row (#634).
 */
export function QualityChecks({
  fileId,
  media,
  canChoose,
  onLoop,
  onComment,
}: {
  fileId: string;
  media: HTMLMediaElement | null;
  canChoose: boolean;
  /** Loop a finding's passage in the player and hear it from its start. */
  onLoop?: (loop: Loop) => void;
  /** Write a comment about a finding, for those who may comment (#43). */
  onComment?: (finding: QaFinding) => void;
}) {
  const { guest } = useViewer();
  const { data } = useQuery(qaQuery(fileId));
  const choose = useFileDeliveryProfile(fileId);
  const { data: customs = [] } = useQuery({ ...customProfilesQuery, enabled: canChoose });
  const [showPassed, setShowPassed] = useState(false);
  const [filter, setFilter] = useState<FindingFilter>({ severity: null, check: null });
  /** Only what is new since the previous version (#564), from the line that says how many. */
  const [onlyNew, setOnlyNew] = useState(false);
  const { data: changes } = useQuery(qaChangesQuery(fileId));
  // Once this version is measured, what changed since the last can be said at once.
  const client = useQueryClient();
  const measured = data?.status === "ready";
  useEffect(() => {
    if (measured) void client.invalidateQueries({ queryKey: qaChangesQuery(fileId).queryKey });
  }, [measured, fileId, client]);
  /** The problems not found in the previous version, to label as new. */
  const fresh = new Set((changes?.new ?? []).map(findingKey));
  const id = useId();
  const checkId = useId();
  if (!data) return null;
  const findings = data.findings;
  const problems = orderByCheck(findings.filter((f) => f.severity !== "pass"));
  const passed = findings.filter((f) => f.severity === "pass");
  // Checks, not findings (#564): clipping in twenty places is one check that fails.
  const counts = severityCounts(findings);
  const seek = (t: number) => {
    if (!media) return;
    media.currentTime = t;
    void media.play().catch(() => undefined);
  };
  // Each count of a problem narrows the list to it (#43); pressed again, it lets go.
  const counted = (["fail", "warn", "info"] as const).filter((s) => counts[s] > 0);
  const tally = (
    <>
      {counted.map((s) => (
        <span key={s} className="contents">
          <button
            type="button"
            aria-pressed={filter.severity === s}
            onClick={() => setFilter((f) => ({ ...f, severity: f.severity === s ? null : s }))}
            className={cn(
              "tabular cursor-pointer rounded-control border-0 bg-transparent p-0 text-xs hover:text-ink",
              filter.severity === s ? "text-ink underline underline-offset-4" : "text-ink-3",
            )}
          >
            {severityNames[s]} {counts[s]}
          </button>
          <span aria-hidden="true">·</span>
        </span>
      ))}
      <span>
        {severityNames.pass} {counts.pass}
      </span>
    </>
  );
  // The checks among the problems, to narrow to one, where there is more than one.
  const problemChecks = qaChecks.filter((c) => problems.some((f) => f.check === c));
  const shown = filterFindings(problems, filter).filter(
    (f) => !onlyNew || fresh.has(findingKey(f)),
  );
  const report = (
    // The report as a document (#515): read here, taken away as PDF, CSV or JSON, in the area
    // the viewer is in, so a guest whose review grants QA reads it too. In the heading row, as
    // a page's export is (#634).
    <Link
      to={guest ? "/g/files/$fileId/qa-report" : "/files/$fileId/qa-report"}
      params={{ fileId }}
      className={cn(buttonVariants({ variant: "secondary", size: "sm" }), "shrink-0")}
    >
      <Icon name="text" size={14} />
      QA report
    </Link>
  );

  return (
    <section aria-label="Checks" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 className="m-0 text-[15px] font-medium">Checks</h2>
        <span className="tabular flex flex-wrap items-baseline gap-x-1.5 text-xs text-ink-3">
          {data.status === "ready" ? tally : waitingCopy[data.status]}
        </span>
        {problemChecks.length > 1 && (
          <Select
            size="sm"
            id={checkId}
            aria-label="Check"
            value={filter.check ?? ""}
            onChange={(e) =>
              setFilter((f) => ({ ...f, check: (e.target.value || null) as QaCheck | null }))
            }
            className="w-auto"
          >
            <option value="">Every check</option>
            {problemChecks.map((c) => (
              <option key={c} value={c}>
                {checkNames[c]}
              </option>
            ))}
          </Select>
        )}
        <span className="ml-auto flex items-center gap-2 text-xs text-ink-3">
          <label htmlFor={id}>Against</label>
          {canChoose ? (
            <Select
              size="sm"
              id={id}
              value={data.profile.source === "file" ? data.profile.id : ""}
              disabled={choose.isPending}
              onChange={(e) => choose.mutate((e.target.value || null) as ProfileRef | null)}
              className="w-auto max-w-56"
            >
              <option value="">{`${data.inherited.label} (${inheritedFrom[data.inherited.source]})`}</option>
              <ProfileOptions customs={customs} />
            </Select>
          ) : (
            <span id={id} className="text-ink-2">
              {data.profile.label}
            </span>
          )}
          {report}
        </span>
      </div>
      {changes?.previous && changes.measured && (
        <SincePrevious
          changes={changes}
          previous={changes.previous}
          onlyNew={onlyNew}
          onOnlyNew={setOnlyNew}
        />
      )}
      {problems.length > 0 && shown.length === 0 && (
        <p className="m-0 text-[13px] text-ink-3">
          Nothing found of that kind.{" "}
          <button
            type="button"
            onClick={() => {
              setFilter({ severity: null, check: null });
              setOnlyNew(false);
            }}
            className="cursor-pointer border-0 bg-transparent p-0 text-ink-2 underline underline-offset-4 hover:text-ink"
          >
            Show every finding
          </button>
        </p>
      )}
      {shown.length > 0 && (
        <ul className="m-0 list-none border-t border-hairline p-0" aria-label="Findings">
          {groupFindings(shown).map((group, g, groups) => {
            // A check named once (#564): a later run of the same check sits under it.
            const sameCheck = g > 0 && groups[g - 1]?.[0]?.check === group[0]?.check;
            return group.length > 2 ? (
              <FindingGroup
                onComment={onComment}
                key={`${group[0]?.check}-${group[0]?.start}`}
                group={group}
                onSeek={seek}
                onLoop={onLoop}
                fresh={fresh}
                sameCheck={sameCheck}
              />
            ) : (
              group.map((f, i) => (
                <FindingRow
                  key={findingKey(f)}
                  finding={f}
                  onSeek={seek}
                  onLoop={onLoop}
                  onComment={onComment}
                  isNew={fresh.has(findingKey(f))}
                  sameCheck={sameCheck || i > 0}
                />
              ))
            );
          })}
        </ul>
      )}
      {passed.length > 0 && (
        <div className="flex flex-col">
          <button
            type="button"
            onClick={() => setShowPassed((v) => !v)}
            aria-expanded={showPassed}
            className="w-fit cursor-pointer border-0 bg-transparent p-0 text-xs text-ink-3 hover:text-ink"
          >
            {showPassed ? "Hide" : "Show"} {passed.length} passed
          </button>
          {showPassed && (
            <ul className="m-0 mt-2 list-none border-t border-hairline p-0" aria-label="Passed">
              {passed.map((f, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: findings have no id and never reorder here.
                <FindingRow key={i} finding={f} onSeek={seek} />
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

const rankOf: Record<QaSeverity, number> = { fail: 0, warn: 1, info: 2, pass: 3 };

/**
 * Findings by check (#564), the worst checks first, each check's findings together and in
 * time: so a check is named once with what it found under it.
 */
export function orderByCheck(findings: readonly QaFinding[]): QaFinding[] {
  const worstOf = new Map<QaCheck, number>();
  const firstAt = new Map<QaCheck, number>();
  findings.forEach((f, i) => {
    worstOf.set(f.check, Math.min(worstOf.get(f.check) ?? 3, rankOf[f.severity]));
    if (!firstAt.has(f.check)) firstAt.set(f.check, i);
  });
  return [...findings].sort(
    (a, b) =>
      (worstOf.get(a.check) ?? 3) - (worstOf.get(b.check) ?? 3) ||
      (firstAt.get(a.check) ?? 0) - (firstAt.get(b.check) ?? 0) ||
      rankOf[a.severity] - rankOf[b.severity] ||
      (a.start ?? -1) - (b.start ?? -1),
  );
}

/**
 * What changed against the previous version (#43), in one line (#564): how many are new and
 * how many fixed; the count of new ones narrows the list to them.
 */
function SincePrevious({
  changes,
  previous,
  onlyNew,
  onOnlyNew,
}: {
  changes: QaChanges;
  previous: { number: number; name: string };
  onlyNew: boolean;
  onOnlyNew: (on: boolean) => void;
}) {
  const fresh = changes.new.length;
  const fixed = changes.fixed.length;
  return (
    <section
      aria-label="Since the previous version"
      className="tabular m-0 flex flex-wrap items-baseline gap-x-1.5 text-xs text-ink-3"
    >
      <span>
        Since V{previous.number} · {previous.name}:
      </span>
      {fresh > 0 ? (
        <button
          type="button"
          aria-pressed={onlyNew}
          onClick={() => onOnlyNew(!onlyNew)}
          className={cn(
            "tabular cursor-pointer border-0 bg-transparent p-0 text-xs hover:text-ink",
            onlyNew ? "text-ink underline underline-offset-4" : "text-ink-2",
          )}
        >
          {fresh} new
        </button>
      ) : (
        <span>nothing new</span>
      )}
      <span aria-hidden="true">·</span>
      <span title={changes.fixed.map((f) => findingWords(f)).join("\n") || undefined}>
        {fixed > 0 ? `${fixed} fixed` : "nothing fixed"}
      </span>
    </section>
  );
}

/**
 * The figures that matter first, in one hairline row (#634): the same for a recording and a
 * video, each its label over its value, with what was asked for beneath.
 */
export function QaStats({
  stats,
}: {
  stats: { label: string; value: ReactNode; hint?: string }[];
}) {
  if (stats.length === 0) return null;
  return (
    <dl className="m-0 grid grid-cols-2 gap-x-6 gap-y-4 border-y border-hairline py-4 sm:grid-cols-4">
      {stats.map((s) => (
        <div key={s.label} className="flex min-w-0 flex-col gap-0.5">
          <dt className="text-[12px] text-ink-3">{s.label}</dt>
          <dd className="tabular m-0 truncate text-[17px] leading-6 font-medium text-ink">
            {s.value}
          </dd>
          {s.hint && <dd className="m-0 truncate text-[12px] text-ink-3">{s.hint}</dd>}
        </div>
      ))}
    </dl>
  );
}

/**
 * QA's one layout, for a recording and a video alike (#634): the figures in a hairline row,
 * the checks, what the page adds (the frames, the loudness), the format, and the file's own
 * metadata. Hairlines throughout, never cards.
 */
export function QaLayout({
  stats,
  checks,
  format,
  aside,
  children,
}: {
  stats: { label: string; value: ReactNode; hint?: string }[];
  checks: ReactNode;
  /** The format's facts, a row each, said once on the page (#635). */
  format: [string, ReactNode][];
  /** Last: the file's embedded metadata. */
  aside?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <QaStats stats={stats} />
      {checks}
      {children}
      {format.length > 0 && (
        <section aria-label="Format" className="flex flex-col gap-2">
          <h2 className="m-0 text-[15px] font-medium">Format</h2>
          <dl className="m-0 flex flex-col border-t border-hairline">
            {format.map(([term, value]) => (
              <div
                key={term}
                className="grid grid-cols-[minmax(0,120px)_1fr] gap-x-6 border-b border-hairline py-2.5"
              >
                <dt className="text-[13px] text-ink-3">{term}</dt>
                <dd className="tabular m-0 min-w-0 text-[13px] text-ink-2">{value}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      {aside}
    </div>
  );
}

/** A level as engineers write it: one decimal, a true minus sign. */
const level = (n: number) => n.toFixed(1).replace("-", "−");

/**
 * Loudness and true peak from the checks themselves, with what the profile asks: QA is all a
 * viewer needs to see them, without the meters (#240).
 */
export function soundStats(findings: readonly QaFinding[]) {
  const loudness = findings.find((f) => f.check === "loudness");
  const peak = findings.find((f) => f.check === "true-peak");
  const integrated = loudness?.details.integrated;
  const truePeak = peak?.details.truePeak;
  const target = loudness?.details.target;
  const ceiling = peak?.details.ceiling;
  return [
    {
      label: "Loudness",
      value:
        typeof integrated === "number" ? (
          <>
            {level(integrated)}
            <span className="ml-1 text-[12px] font-normal text-ink-3">LUFS</span>
          </>
        ) : (
          "Not measured"
        ),
      hint:
        typeof target === "number"
          ? `Target ${level(target)} ± ${loudness?.details.tolerance ?? 0}`
          : undefined,
    },
    {
      label: "True peak",
      value:
        typeof truePeak === "number" ? (
          <>
            {level(truePeak)}
            <span className="ml-1 text-[12px] font-normal text-ink-3">dBTP</span>
          </>
        ) : (
          "Not measured"
        ),
      hint: typeof ceiling === "number" ? `Ceiling ${level(ceiling)}` : undefined,
    },
  ];
}

/**
 * On the Review view: one line of what QA found, opening QA. Loudness against its target
 * and how many checks want a look; nothing more, so the review stays on the music.
 */
/**
 * How many checks need attention (#564): each check counted once, at its worst, as the view's
 * tally and the report count them.
 */
export const qaIssues = qaAttention;

export function QaSummary({ fileId, onOpen }: { fileId: string; onOpen: () => void }) {
  const { data } = useQuery(qaQuery(fileId));
  if (!data) return null;
  const loudness = data.findings.find((f) => f.check === "loudness");
  const integrated = loudness?.details.integrated;
  const issues = qaIssues(data.findings);
  const worst = data.findings.some((f) => f.severity === "fail")
    ? "fail"
    : issues > 0
      ? "warn"
      : "pass";
  const parts = [
    typeof integrated === "number" ? `${integrated.toFixed(1).replace("-", "−")} LUFS` : null,
    data.status !== "ready"
      ? waitingCopy[data.status]
      : issues === 0
        ? "No issues"
        : `${issues} ${issues === 1 ? "issue" : "issues"}`,
  ].filter(Boolean);
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Quality checks: ${parts.join(", ")}. Open QA`}
      className="tabular flex h-7 w-fit cursor-pointer items-center gap-2 rounded-chip border border-hairline bg-transparent px-2.5 text-[11px] text-ink-2 hover:border-edge hover:text-ink"
    >
      <SeverityDot severity={worst} />
      {parts.join(" · ")}
    </button>
  );
}
