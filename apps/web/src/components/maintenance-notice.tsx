import { useQuery } from "@tanstack/react-query";
import { Icon } from "~/components/icons";
import { noticeQuery } from "~/lib/queries";

/**
 * Maintenance mode's notice (#154), above every page while an operator has it on, signed in
 * or not: why uploads wait, and what the operator added.
 */
export function MaintenanceNotice() {
  const { data } = useQuery(noticeQuery);
  if (!data?.maintenance.on) return null;
  return (
    <div
      role="status"
      className="flex shrink-0 items-center justify-center gap-2 border-b border-signal/30 bg-signal/[0.08] px-4 py-1.5 text-center text-[13px] text-ink"
    >
      <Icon name="warning" size={14} className="shrink-0 text-signal" />
      <span>
        Hekate is under maintenance: uploads and processing wait until it is over, and nothing is
        lost.
        {data.maintenance.message && (
          <span className="text-ink-2"> {data.maintenance.message}</span>
        )}
      </span>
    </div>
  );
}
