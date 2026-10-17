import {
  channelName,
  formatClock,
  type ProfileRef,
  type ProfileSource,
  type QaCheck,
  type QaFinding,
  type QaSeverity,
  qaCheckNames,
  qaSeverityNames,
} from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { cn } from "~/lib/cn";
import { type Loop, MIN_LOOP } from "~/lib/loop";
import { customProfilesQuery, type QaReport, qaQuery, useFileDeliveryProfile } from "~/lib/queries";
import { ProfileOptions } from "./delivery-profiles";
import { Icon } from "./icons";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { Select } from "./ui/input";
import { Segmented } from "./ui/segmented";

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

/** "0:12.4" or "0:12.4 – 0:13.0" for where a finding is. */
const where = (f: QaFinding) => {
  if (f.start === null) return null;
  const clock = (t: number) =>
    formatClock(t)
      .replace(/^0(\d:)/, "$1")
      .replace(/(\.\d)\d\d$/, "$1");
  return f.end !== null && f.end - f.start >= 0.1
    ? `${clock(f.start)} – ${clock(f.end)}`
    : clock(f.start);
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
  action,
  nested = false,
}: {
  finding: QaFinding;
  onSeek: (t: number) => void;
  /** Loop the passage it spans, in one action (#44). */
  onLoop?: (loop: Loop) => void;
  /** Write a comment about it, at its moment (#43). */
  onComment?: (finding: QaFinding) => void;
  /** Beside the summary: opening a group, for one. */
  action?: React.ReactNode;
  /** One of a group's, shown under it. */
  nested?: boolean;
}) {
  const at = where(finding);
  const loop = onLoop ? findingLoop(finding) : null;
  return (
    <li className="grid grid-cols-[12px_1fr_auto] items-baseline gap-x-3 border-b border-hairline py-2.5 sm:grid-cols-[12px_minmax(0,140px)_1fr_auto]">
      <span className="flex h-4 items-center">
        {!nested && <SeverityDot severity={finding.severity} />}
      </span>
      <span className="label hidden truncate sm:block">
        {nested ? "" : checkNames[finding.check]}
      </span>
      <span className="min-w-0 text-[13px] text-ink-2">
        {/* On a phone the check's name heads the line rather than taking a column. */}
        {!nested && (
          <span className="label mb-0.5 block sm:hidden">{checkNames[finding.check]}</span>
        )}
        <span className="sr-only">{severityNames[finding.severity]}: </span>
        {finding.summary}
        {action && <span className="ml-3">{action}</span>}
      </span>
      <span className="flex items-center gap-2">
        {at && finding.start !== null ? (
          <>
            <button
              type="button"
              onClick={() => onSeek(finding.start ?? 0)}
              aria-label={`Play from ${at}`}
              className="tabular h-6 cursor-pointer rounded-chip border border-edge bg-transparent px-2 font-mono text-[11px] text-ink hover:border-signal"
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
}: {
  group: QaFinding[];
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
            nested
          />
        ))}
    </>
  );
}

/**
 * The quality checks of a recording (#41): problems first, worst first, each playing from
 * where it is; what passed below, folded. Checked against the nearest delivery profile (the
 * file's own, its track's, its project's or the workspace's), and those who shape the
 * project's workflow can give this file one of its own here.
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
  const { data } = useQuery(qaQuery(fileId));
  const choose = useFileDeliveryProfile(fileId);
  const { data: customs = [] } = useQuery({ ...customProfilesQuery, enabled: canChoose });
  const [showPassed, setShowPassed] = useState(false);
  const [report, setReport] = useState(false);
  const id = useId();
  if (!data) return null;
  const problems = data.findings.filter((f) => f.severity !== "pass");
  const passed = data.findings.filter((f) => f.severity === "pass");
  // Checks, not findings: clipping in twenty places is one check failed.
  const count = (s: QaSeverity) =>
    new Set(data.findings.filter((f) => f.severity === s).map((f) => f.check)).size;
  const seek = (t: number) => {
    if (!media) return;
    media.currentTime = t;
    void media.play().catch(() => undefined);
  };
  const tally = [
    count("fail") && `${count("fail")} failed`,
    count("warn") && `${count("warn")} to look at`,
    `${count("pass")} passed`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <section aria-label="Checks" className="flex flex-col gap-4 border-t border-hairline pt-5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2">
        <h2 className="m-0 text-[15px] font-medium">Checks</h2>
        <span className="tabular text-xs text-ink-3">
          {data.status === "ready" ? tally : waitingCopy[data.status]}
        </span>
        <span className="ml-auto flex items-center gap-2 text-xs text-ink-3">
          <label htmlFor={id}>Against</label>
          {canChoose ? (
            <Select
              size="sm"
              id={id}
              value={data.profile.source === "file" ? data.profile.id : ""}
              disabled={choose.isPending}
              onChange={(e) => choose.mutate((e.target.value || null) as ProfileRef | null)}
              className="w-auto"
            >
              <option value="">{`${data.inherited.label} (${inheritedFrom[data.inherited.source]})`}</option>
              <ProfileOptions customs={customs} />
            </Select>
          ) : (
            <span id={id} className="text-ink-2">
              {data.profile.label}
            </span>
          )}
        </span>
      </div>
      {problems.length > 0 && (
        <ul className="m-0 list-none border-t border-hairline p-0" aria-label="Findings">
          {groupFindings(problems).map((group) =>
            group.length > 2 ? (
              <FindingGroup
                onComment={onComment}
                key={`${group[0]?.check}-${group[0]?.start}`}
                group={group}
                onSeek={seek}
                onLoop={onLoop}
              />
            ) : (
              group.map((f) => (
                <FindingRow
                  key={findingKey(f)}
                  finding={f}
                  onSeek={seek}
                  onLoop={onLoop}
                  onComment={onComment}
                />
              ))
            ),
          )}
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
      <Button variant="secondary" size="sm" className="self-start" onClick={() => setReport(true)}>
        <Icon name="download" size={14} />
        QA report
      </Button>
      {report && (
        <QaReportDialog
          fileId={fileId}
          profile={data.profile.label}
          onClose={() => setReport(false)}
        />
      )}
    </section>
  );
}

const reportFormats = ["pdf", "csv", "json"] as const;
type ReportFormat = (typeof reportFormats)[number];

/**
 * The QA report to take away (#43), as the prototype's dialog offers it: PDF to read and
 * send, CSV for a spreadsheet, JSON for another program.
 */
function QaReportDialog({
  fileId,
  profile,
  onClose,
}: {
  fileId: string;
  profile: string;
  onClose: () => void;
}) {
  const [format, setFormat] = useState<ReportFormat>("pdf");
  return (
    <Dialog
      title="QA report"
      onClose={onClose}
      width="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              window.location.assign(`/api/files/${fileId}/qa/report?format=${format}`);
              onClose();
            }}
          >
            <Icon name="download" size={14} />
            Download {format.toUpperCase()}
          </Button>
        </>
      }
    >
      <Segmented
        label="Format"
        value={format}
        options={reportFormats.map((f) => ({ value: f, label: f.toUpperCase() }))}
        onChange={setFormat}
        className="w-fit"
      />
      <dl className="m-0 mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px]">
        <dt className="text-ink-3">Stamped with</dt>
        <dd className="m-0 text-ink">The workspace, the project, your name and part in it</dd>
        <dt className="text-ink-3">Measured against</dt>
        <dd className="m-0 text-ink">{profile}</dd>
        <dt className="text-ink-3">Includes</dt>
        <dd className="m-0 text-ink">Findings, what passed, loudness and format</dd>
      </dl>
    </Dialog>
  );
}

/**
 * On the Review view: one line of what QA found, opening QA. Loudness against its target
 * and how many checks want a look; nothing more, so the review stays on the music.
 */
export function QaSummary({ fileId, onOpen }: { fileId: string; onOpen: () => void }) {
  const { data } = useQuery(qaQuery(fileId));
  if (!data) return null;
  const loudness = data.findings.find((f) => f.check === "loudness");
  const integrated = loudness?.details.integrated;
  const issues = new Set(
    data.findings.filter((f) => f.severity === "fail" || f.severity === "warn").map((f) => f.check),
  ).size;
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
      className="tabular flex h-7 w-fit cursor-pointer items-center gap-2 rounded-chip border border-hairline bg-transparent px-2.5 font-mono text-[11px] text-ink-2 hover:border-edge hover:text-ink"
    >
      <SeverityDot severity={worst} />
      {parts.join(" · ")}
    </button>
  );
}
