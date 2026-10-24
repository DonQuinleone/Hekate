import { chanceWords, type TraceResult } from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type DragEvent, useRef, useState } from "react";
import { Icon } from "~/components/icons";
import { Row, Section, SwitchRow } from "~/components/settings";
import { Button } from "~/components/ui/button";
import { FileInput } from "~/components/ui/input";
import { cn } from "~/lib/cn";
import { formatDates } from "~/lib/locale";
import { forensicQuery, useForensic, useRevokeGuest } from "~/lib/queries";

const when = formatDates({
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/**
 * Leak tracing (#32), for the workspace's owners: whether recordings' downloads carry an
 * inaudible mark, and a suspected leak traced back to the download it came from. The file is
 * examined on the server and not kept; the trace is in the access log.
 */
export function LeakTracingSection() {
  const { data: status } = useQuery(forensicQuery);
  const { audio, trace } = useForensic();
  const revoke = useRevokeGuest();
  const navigate = useNavigate();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [name, setName] = useState<string | null>(null);
  const send = (file: File) => {
    setName(file.name);
    trace.mutate(file);
  };
  const drop = (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    const dropped = event.dataTransfer.files[0];
    if (dropped && !trace.isPending) send(dropped);
  };
  const again = () => {
    trace.reset();
    revoke.reset();
    setName(null);
  };
  const result: TraceResult | undefined = trace.data;
  return (
    <>
      <Section
        title="Forensic marking"
        intro="Every recording someone downloads carries an inaudible mark that names the person who received it."
      >
        <SwitchRow
          name="Audio"
          hint={
            status && !status.included
              ? "Not on this workspace's plan."
              : "Originals and proxies of recordings, marked for whoever downloads them."
          }
          checked={Boolean(status?.included && status.audio)}
          disabled={!status?.included || audio.isPending}
          onChange={(on) => audio.mutate(on)}
        />
        <SwitchRow
          name="Video"
          hint="Not yet: video downloads carry the visible mark, burned into every frame."
          checked={false}
          disabled
        />
        <SwitchRow
          name="Pages"
          hint="Not yet: pages and pictures carry the visible mark, set per project."
          checked={false}
          disabled
        />
      </Section>
      <Section
        title="Trace a leak"
        intro="Upload the file that got out. It is matched against every mark issued, and kept only while it is."
      >
        <Row name="Suspected leak" stacked>
          <div className="flex w-full flex-col gap-3">
            <FileInput
              ref={input}
              aria-label="The suspected leak"
              accept="audio/*,video/*"
              onChange={(event) => {
                const chosen = event.target.files?.[0];
                if (chosen) send(chosen);
                event.target.value = "";
              }}
            />
            {!trace.isPending && !result && (
              // biome-ignore lint/a11y/noStaticElementInteractions: dropping is a shortcut; the button does the same.
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setOver(true);
                }}
                onDragLeave={() => setOver(false)}
                onDrop={drop}
                className={cn(
                  "flex w-full flex-col items-center gap-2 rounded-panel-lg border border-dashed px-6 py-8 text-center transition-colors",
                  over ? "border-edge-strong bg-raised/40" : "border-line-strong",
                )}
              >
                <Icon name="upload" size={20} className="text-ink-3" />
                <span className="text-[14px] text-ink">Drop the file here, or choose it</span>
                <span className="max-w-[460px] text-[13px] text-ink-3">
                  Twenty seconds of the recording is usually enough, even encoded again as MP3, AAC
                  or Opus. Only the first ten minutes are examined.
                </span>
                <Button variant="secondary" size="sm" onClick={() => input.current?.click()}>
                  Choose a file
                </Button>
              </div>
            )}
            {trace.isPending && (
              <span className="flex items-center gap-2 text-[13px] text-ink-2" aria-live="polite">
                <span className="breathe size-2 rounded-full border border-ink-2" />
                Scanning {name} against{" "}
                {status ? `${status.marks} ${status.marks === 1 ? "mark" : "marks"}` : "every mark"}
              </span>
            )}
            {trace.error && (
              <div
                role="alert"
                className="flex items-center gap-3 rounded-panel border border-line p-4 text-[14px] text-ink-2"
              >
                <span className="flex-1">{trace.error.message}</span>
                <Button variant="ghost" size="sm" onClick={again}>
                  Try another
                </Button>
              </div>
            )}
            {result?.match && (
              <div className="rise-in flex flex-col gap-2 rounded-panel border border-signal/40 bg-signal/[0.06] p-4 text-[14px]">
                <span className="flex items-center gap-2 text-ink">
                  <Icon name="warning" size={14} className="text-signal" />
                  Match: the chance of a mistake is {chanceWords(result.match.chance)}
                </span>
                <span className="text-ink-2">
                  {result.match.recipient} ·{" "}
                  {result.match.kind === "original" ? "original" : "proxy"} of{" "}
                  {result.match.fileName} · {when.format(new Date(result.match.at))}
                  {result.match.reviewName ? ` · through ${result.match.reviewName}` : ""}
                </span>
                <span className="flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      navigate({ to: "/settings/$section", params: { section: "log" } })
                    }
                  >
                    Open the access log
                  </Button>
                  {/* A guest's links and sessions end here; a member is managed under Members. */}
                  {result.match.guestId && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={revoke.isPending || revoke.isSuccess}
                      onClick={() => result.match?.guestId && revoke.mutate(result.match.guestId)}
                    >
                      {revoke.isSuccess ? "Access revoked" : "Revoke their access"}
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" onClick={again}>
                    Trace another
                  </Button>
                </span>
              </div>
            )}
            {result && !result.match && (
              <div className="rise-in flex items-center gap-3 rounded-panel border border-line p-4 text-[14px] text-ink-2">
                <span className="flex-1">
                  {result.patternFound
                    ? "This workspace's mark is there, but too damaged to name anyone."
                    : "No mark found. The file may predate marking, or be too short or too degraded."}
                </span>
                <Button variant="ghost" size="sm" onClick={again}>
                  Try another
                </Button>
              </div>
            )}
          </div>
        </Row>
      </Section>
    </>
  );
}
