import { useState } from "react";
import { Icon } from "~/components/icons";
import { Button } from "~/components/ui/button";

/** The sample's checksum, as the details and QA show it. */
export const sampleSha256 = "9f3c1b7e0a5d4c2f8e6b1a9d3c7f5e2b4a8d6c1e0f3b9a7d5c2e8f4b1a6de21a";

/**
 * A file's SHA-256: its first and last characters, the whole in its title, and a button that
 * copies the whole and says "Copied" for a moment.
 */
export function Checksum({ sha256 = sampleSha256 }: { sha256?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="inline-flex max-w-full min-w-0 items-center gap-1">
      <span className="tabular truncate text-ink-2" title={sha256}>
        SHA-256 · {sha256.slice(0, 4)}…{sha256.slice(-4)}
      </span>
      <Button
        size="iconSm"
        variant="quiet"
        aria-label="Copy the checksum"
        title="Copy the checksum"
        className="-my-1 shrink-0"
        onClick={() => {
          void navigator.clipboard?.writeText(sha256).catch(() => {});
          setCopied(true);
          setTimeout(() => setCopied(false), 2500);
        }}
      >
        <Icon name={copied ? "check" : "copy"} size={13} />
      </Button>
      <span role="status" className="shrink-0 text-[12px] text-ink-3">
        {copied ? "Copied" : ""}
      </span>
    </span>
  );
}
