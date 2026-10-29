import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Icon } from "~/components/icons";
import { instanceAccessQuery, meQuery } from "~/lib/queries";

/**
 * Where the instance writes its mail to the log instead of sending it (#503), as a
 * development install does, the pages that offer mail say so, or every "Mail" switch
 * promises something that never arrives. Operators get the way to put it right.
 */
export function MailLogNotice() {
  const { data: me } = useQuery(meQuery);
  const { data: access } = useQuery(instanceAccessQuery);
  if (!me?.mail?.logOnly) return null;
  return (
    <div
      role="status"
      className="flex items-start gap-2.5 rounded-panel border border-signal/30 bg-signal/[0.06] px-3.5 py-2.5 text-[13px] text-ink"
    >
      <Icon name="warning" size={14} className="mt-0.5 shrink-0 text-signal" />
      <span>
        This instance writes email to its log; nothing is sent.{" "}
        {access?.operator ? (
          <>
            Set up mail under{" "}
            <Link
              to="/instance/$section"
              params={{ section: "settings" }}
              className="text-ink underline decoration-edge underline-offset-2 transition-colors hover:decoration-ink-3"
            >
              Instance, Settings
            </Link>
            .
          </>
        ) : (
          "An operator sets up mail under Instance, Settings."
        )}
      </span>
    </div>
  );
}
