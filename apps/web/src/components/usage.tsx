import {
  formatBytes,
  memberLimits,
  standing,
  storageQuotas,
  type WorkspaceUsage,
} from "@hekate/shared";
import { Row } from "~/components/settings";
import { Select } from "~/components/ui/input";
import { cn } from "~/lib/cn";

/**
 * A workspace's usage against its limits (#175): a meter for the storage quota, the count for
 * the member limit, and the month so far. From 90% the meter and its words turn to the signal.
 */

/** How full a limit is, drawn: the signal from 90%. */
export function QuotaMeter({ used, limit, label }: { used: number; limit: number; label: string }) {
  const share = Math.min(1, used / limit);
  const where = standing(used, limit);
  return (
    <span className="flex w-56 max-w-full">
      <meter
        className="sr-only"
        min={0}
        max={limit}
        value={Math.min(used, limit)}
        aria-label={label}
      />
      <span
        className="block h-1.5 w-full overflow-hidden rounded-full bg-raised"
        aria-hidden="true"
      >
        <span
          className={cn(
            "block h-full rounded-full transition-[width] duration-300",
            where === "under" ? "bg-ink-2" : "bg-signal",
          )}
          style={{ width: `${share * 100}%` }}
        />
      </span>
    </span>
  );
}

/** What a limit's standing means for what comes next. */
const standingWords = {
  under: null,
  near: "Nearly at the limit",
  reached: "At the limit",
} as const;

/** Storage, members and the month so far, as rows of a section. */
/** The storage used against the quota, with its meter: on Storage and on Operations (#510). */
export function StorageUsageRow({ usage }: { usage: WorkspaceUsage }) {
  const { storageQuota } = usage.limits;
  const storage = standing(usage.storageBytes, storageQuota);
  return (
    <Row
      name="Storage"
      hint={
        <Standing where={storage}>
          {storageQuota === null
            ? `${formatBytes(usage.storageBytes)} · no quota`
            : `${formatBytes(usage.storageBytes)} of ${formatBytes(storageQuota)}${storage === "reached" ? ": uploads are refused" : ""}`}
        </Standing>
      }
    >
      {storageQuota !== null && (
        <QuotaMeter used={usage.storageBytes} limit={storageQuota} label="Storage used" />
      )}
    </Row>
  );
}

export function UsageRows({ usage }: { usage: WorkspaceUsage }) {
  const { memberLimit } = usage.limits;
  const people = standing(usage.members + usage.invited, memberLimit);
  // Set by a plan (#177); an older server sends none.
  const projectLimit = usage.limits.projectLimit ?? null;
  const projects = standing(usage.projects, projectLimit);
  return (
    <>
      <StorageUsageRow usage={usage} />
      <Row
        name="Members"
        hint={
          <Standing where={people}>
            {[
              memberLimit === null
                ? `${usage.members} · no limit`
                : `${usage.members} of ${memberLimit}`,
              usage.invited > 0 ? `${usage.invited} invited, each taking a place` : null,
              people === "reached" ? "new invitations are refused" : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </Standing>
        }
      >
        {memberLimit !== null && (
          <QuotaMeter used={usage.members + usage.invited} limit={memberLimit} label="Members" />
        )}
      </Row>
      <Row
        name="Guests and projects"
        hint={
          <Standing where={projects}>
            {`${usage.guests} ${usage.guests === 1 ? "guest" : "guests"} · ${
              projectLimit
                ? `${usage.projects} of ${projectLimit} projects${projects === "reached" ? ": new projects are refused" : ""}`
                : `${usage.projects} ${usage.projects === 1 ? "project" : "projects"}`
            }`}
          </Standing>
        }
      />
      <Row
        name="This month"
        hint={
          usage.month
            ? `${usage.month.plays} ${usage.month.plays === 1 ? "play" : "plays"} · ${usage.month.downloads} ${usage.month.downloads === 1 ? "download" : "downloads"} · storage at its peak ${formatBytes(usage.month.storagePeak)}`
            : "Counted each hour; the first count is still to come."
        }
      />
    </>
  );
}

function Standing({ where, children }: { where: "under" | "near" | "reached"; children: string }) {
  const words = standingWords[where];
  return words ? (
    <span className="text-signal">
      {words}: {children}
    </span>
  ) : (
    children
  );
}

/** Choose a storage quota, from those offered and whatever is set now. */
export function QuotaSelect({
  value,
  onChange,
  disabled,
}: {
  value: number | null;
  onChange: (value: number | null) => void;
  disabled?: boolean;
}) {
  const offered: number[] = [...storageQuotas];
  if (value !== null && !offered.includes(value)) offered.push(value);
  return (
    <Select
      aria-label="Storage quota"
      value={value === null ? "" : String(value)}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
      className="w-40"
    >
      {offered
        .sort((a, b) => a - b)
        .map((bytes) => (
          <option key={bytes} value={bytes}>
            {formatBytes(bytes)}
          </option>
        ))}
      <option value="">No quota</option>
    </Select>
  );
}

/** Choose a member limit, from those offered and whatever is set now. */
export function MemberLimitSelect({
  value,
  onChange,
  disabled,
}: {
  value: number | null;
  onChange: (value: number | null) => void;
  disabled?: boolean;
}) {
  const offered: number[] = [...memberLimits];
  if (value !== null && !offered.includes(value)) offered.push(value);
  return (
    <Select
      aria-label="Member limit"
      value={value === null ? "" : String(value)}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
      className="w-40"
    >
      {offered
        .sort((a, b) => a - b)
        .map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      <option value="">No limit</option>
    </Select>
  );
}
