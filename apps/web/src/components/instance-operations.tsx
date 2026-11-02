import { formatBytes, type InstanceOperations, rateInWords, rateLimitCopy } from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { Code } from "~/components/inspect";
import { OpenRow } from "~/components/open-row";
import { Row, Section } from "~/components/settings";
import { Failed } from "~/components/ui/states";
import { api } from "~/lib/api";
import { docsUrl } from "~/lib/links";
import { json } from "~/lib/queries";

/** Checks a restore before anyone uses it (docs/backup.md), in a Compose install. */
const VERIFY =
  "docker compose --env-file .env -f deploy/compose.yml run --rm app apps/server/src/cli.ts backup verify";

const roleCopy: Record<InstanceOperations["capacity"]["process"]["role"], string> = {
  all: "answers requests and runs jobs",
  api: "answers requests only",
  worker: "runs jobs only",
};

/**
 * Instance, Operations (decision 251): backups as Hekate can truthfully speak of them, taken
 * outside it and checked by `backup verify`; capacity as the environment and the code set it.
 */
export function Operations() {
  const { data, error, refetch } = useQuery({
    queryKey: ["instance", "operations"],
    queryFn: async () => json<InstanceOperations>(await api.instance.operations.$get()),
    refetchInterval: 15_000,
  });
  const capacity = data?.capacity;
  const process = capacity?.process;
  return (
    <>
      <Section
        title="Backups"
        intro="Taken outside Hekate, so it cannot say when the last one ran: the database, the storage and the master key, the first two as of the same moment."
      >
        {/* Each opens its page of the docs on a click (#691), not a How to on every row. */}
        <OpenRow
          name="Backing up"
          hint="deploy/backup.sh copies the database and the storage; the master key is kept apart from both."
          href={`${docsUrl}/operate/backup/`}
          label="How to back up, in the docs"
        />
        <OpenRow
          name="Restore"
          hint="Into a fresh instance, from a backup and the master key."
          href={`${docsUrl}/operate/recovery/`}
          label="How to restore, in the docs"
        />
        <Row
          name="Verify a restore"
          hint="Before anyone uses it: every workspace key opens, every file recorded is in storage, and a sample reads back and matches its checksum. It changes nothing."
          stacked
        >
          <div className="min-w-0 flex-1">
            <Code label="The command">{VERIFY}</Code>
          </div>
        </Row>
      </Section>
      <Section
        title="Capacity"
        intro="Set in each process's environment, so shown here and changed there; a change takes a restart."
      >
        {error && <Failed what="Capacity" error={error} retry={refetch} size="panel" />}
        {capacity && process && (
          <>
            <Row
              name="Worker lanes"
              hint={`Transcodes run one per lane; more lanes need more CPU. This process ${roleCopy[process.role]}, ${process.lanes ? `with WORKER_LANES ${process.lanes}` : "taking every lane"} and WORKER_CONCURRENCY ${process.concurrency}.`}
              inline
            >
              <span className="tabular text-[13px] text-ink-2">
                {capacity.lanes.used} of {capacity.lanes.total} busy
                {capacity.lanes.replicas > 1 ? ` · ${capacity.lanes.replicas} replicas` : ""}
              </span>
            </Row>
            <Row
              name="Upload limit"
              hint="Per file: the most chunks of 8 MiB a storage backend takes for one object. Workspaces' storage quotas apply too."
              inline
            >
              <span className="tabular text-[13px] text-ink-2">
                {formatBytes(capacity.uploadLimitBytes)}
              </span>
            </Row>
          </>
        )}
      </Section>
      {capacity && (
        <Section
          title="Rate limits"
          intro="Counted in the database, so every replica counts the same requests; past one, a request is answered 429 with when to try again."
        >
          {capacity.rateLimits.map((r) => (
            <Row
              key={r.name}
              name={rateLimitCopy[r.name].name}
              hint={rateLimitCopy[r.name].per}
              inline
            >
              <span className="tabular text-[13px] text-ink-2">{rateInWords(r.rule)}</span>
            </Row>
          ))}
        </Section>
      )}
    </>
  );
}
