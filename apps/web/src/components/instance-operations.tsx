import { formatBytes, type InstanceOperations, rateInWords, rateLimitCopy } from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { Code } from "~/components/inspect";
import { Row, Section } from "~/components/settings";
import { Button } from "~/components/ui/button";
import { api } from "~/lib/api";
import { docsUrl } from "~/lib/links";
import { json } from "~/lib/queries";

/** Checks a restore before anyone uses it (docs/backup.md), in a Compose install. */
const VERIFY =
  "docker compose -f deploy/compose.yml run --rm app apps/server/src/cli.ts backup verify";

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
  const { data, error } = useQuery({
    queryKey: ["instance", "operations"],
    queryFn: async () => json<InstanceOperations>(await api.instance.operations.$get()),
    refetchInterval: 15_000,
  });
  const how = (path: string, label: string) => (
    <Button variant="ghost" size="md" asChild>
      <a href={`${docsUrl}${path}`} target="_blank" rel="noopener noreferrer">
        {label}
      </a>
    </Button>
  );
  const capacity = data?.capacity;
  const process = capacity?.process;
  return (
    <>
      <Section
        title="Backups"
        intro="Taken outside Hekate, so it cannot say when the last one ran: the database, the storage and the master key, the first two as of the same moment."
      >
        <Row
          name="Backing up"
          hint="deploy/backup.sh copies the database and the storage; the master key is kept apart from both."
        >
          {how("/operate/backup/", "How to")}
        </Row>
        <Row name="Restore" hint="Into a fresh instance, from a backup and the master key.">
          {how("/operate/recovery/", "How to")}
        </Row>
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
        {error && <Row name="Capacity could not be read" hint={error.message} />}
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
