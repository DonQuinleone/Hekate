import {
  type AccessTally,
  type FileInspection,
  formatBytes,
  type InspectKind,
  inspectTarget,
  type ReviewInspection,
  type SessionInspection,
} from "@hekate/shared";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { type FormEvent, type ReactNode, useState } from "react";
import { Row, Section } from "~/components/settings";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { actionCopy } from "~/lib/access-log";
import { cn } from "~/lib/cn";
import { formatDates } from "~/lib/locale";
import { instanceInspectQuery } from "~/lib/queries";

const moment = formatDates({
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});
const at = (iso: string | null) => (iso ? moment.format(new Date(iso)) : "never");

const inspectors: { kind: InspectKind; name: string; hint: string; placeholder: string }[] = [
  {
    kind: "file",
    name: "A file",
    hint: "Its rows, objects, keys, renditions and every job that touched it",
    placeholder: "File id or link",
  },
  {
    kind: "review",
    name: "A review",
    hint: "Its reviewers, their sessions, what they could see and when",
    placeholder: "Review id or link",
  },
  {
    kind: "session",
    name: "A session",
    hint: "Who, where from, what it may reach, the keys it was issued",
    placeholder: "Session id",
  },
];

/**
 * Debug tools' inspectors (#159): read-only views of a file, a review or a session, opened by
 * an id or a pasted link. Each look is recorded as the operator's.
 */
export function Inspect({ onReference }: { onReference: (reference: string) => void }) {
  const [entered, setEntered] = useState<Record<InspectKind, string>>({
    file: "",
    review: "",
    session: "",
  });
  const [target, setTarget] = useState<{ kind: InspectKind; id: string; look: number } | null>(
    null,
  );
  const [invalid, setInvalid] = useState<InspectKind | null>(null);
  const result = useQuery({
    ...instanceInspectQuery(target?.kind ?? "file", target?.id ?? "", target?.look ?? 0),
    enabled: !!target,
    // Looking again keeps the last answer in view until the new one comes.
    placeholderData: keepPreviousData,
  });
  const inspect = (kind: InspectKind) => (e: FormEvent) => {
    e.preventDefault();
    const id = inspectTarget(kind, entered[kind]);
    setInvalid(id ? null : kind);
    setTarget((t) => (id ? { kind, id, look: (t?.look ?? 0) + 1 } : null));
  };
  const shown = target && result.data?.kind === target.kind ? result.data : null;
  return (
    <Section
      title="Inspect"
      intro="Read-only views of what the system holds, for the thing that is not working. Each look is recorded as yours."
    >
      {inspectors.map((i) => (
        <Row key={i.kind} name={i.name} hint={i.hint}>
          <form className="flex min-w-0 gap-2" onSubmit={inspect(i.kind)}>
            <Input
              value={entered[i.kind]}
              onChange={(e) => setEntered({ ...entered, [i.kind]: e.target.value })}
              placeholder={i.placeholder}
              aria-label={i.placeholder}
              className="w-56 min-w-0"
            />
            <Button
              type="submit"
              variant="secondary"
              size="md"
              disabled={!entered[i.kind].trim()}
              aria-label={`Inspect ${i.name.toLowerCase()}`}
            >
              Inspect
            </Button>
          </form>
        </Row>
      ))}
      {(invalid || result.isError || (target && result.data === null) || shown) && (
        <div className="flex flex-col gap-3 px-4 py-3">
          {invalid && (
            <p className="m-0 text-[13px] text-signal">
              {invalid === "session"
                ? "That is not a session id."
                : `There is no ${invalid} id in that.`}
            </p>
          )}
          {result.isError && <p className="m-0 text-[13px] text-signal">{result.error.message}</p>}
          {target && result.data === null && (
            <p className="m-0 text-[13px] text-ink-2">No {target.kind} has that id.</p>
          )}
          {shown?.kind === "file" && <FileCard file={shown.found} onReference={onReference} />}
          {shown?.kind === "review" && <ReviewCard review={shown.found} />}
          {shown?.kind === "session" && <SessionCard session={shown.found} />}
        </div>
      )}
    </Section>
  );
}

/** A found thing: its name, where it is, and what is known about it. */
export function Card({
  title,
  where,
  children,
}: {
  title: ReactNode;
  where: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-panel border border-line bg-canvas/40 p-4">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="min-w-0 text-[16px] font-medium [overflow-wrap:anywhere] text-ink">
          {title}
        </span>
        <span className="text-[13px] text-ink-3">{where}</span>
      </div>
      {children}
    </div>
  );
}

export function Facts({ children }: { children: ReactNode }) {
  return <dl className="m-0 grid gap-x-6 gap-y-1 text-[13px] @3xl/app:grid-cols-2">{children}</dl>;
}

export function Fact({
  term,
  tabular = false,
  children,
}: {
  term: string;
  tabular?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 gap-1">
      <dt className="shrink-0 text-ink-3">{term}</dt>
      <dd className={cn("m-0 min-w-0 [overflow-wrap:anywhere] text-ink-2", tabular && "tabular")}>
        {children}
      </dd>
    </div>
  );
}

/** Text that scrolls sideways, reachable by keyboard so it can be read on a phone. */
export function Code({ label, children }: { label: string; children: string }) {
  return (
    <section
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must take focus to scroll by keyboard.
      tabIndex={0}
      aria-label={label}
      className="scroll-quiet overflow-x-auto rounded-control border border-line bg-canvas/60 px-3 py-2 outline-none focus-visible:ring-1 focus-visible:ring-signal"
    >
      <pre className="m-0 font-mono text-[12px] leading-[1.6] text-ink-2">{children}</pre>
    </section>
  );
}

/** A titled list inside a card. */
function Part({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <h4 className="m-0 text-[12px] font-medium text-ink-3">{title}</h4>
      <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[13px] text-ink-2">{children}</ul>
    </div>
  );
}

function Line({ children }: { children: ReactNode }) {
  return <li className="min-w-0 [overflow-wrap:anywhere]">{children}</li>;
}

function Access({ tally, empty }: { tally: AccessTally[]; empty: string }) {
  return (
    <Part title="Access log">
      {tally.length === 0 ? (
        <Line>{empty}</Line>
      ) : (
        tally.map((t) => (
          <Line key={t.action}>
            <span className="text-ink">{actionCopy[t.action] ?? t.action}</span>
            <span className="text-ink-3">
              {" "}
              · {t.count} {t.count === 1 ? "time" : "times"}, last {at(t.last)}
            </span>
          </Line>
        ))
      )}
    </Part>
  );
}

const statusWords: Record<string, string> = {
  none: "none",
  pending: "in progress",
  ready: "ready",
  failed: "failed",
};

function FileCard({
  file: f,
  onReference,
}: {
  file: FileInspection;
  onReference: (reference: string) => void;
}) {
  return (
    <Card title={f.name} where={`${f.workspace.name} · ${f.project.name}`}>
      <Facts>
        <Fact term="Kind">
          {f.kind} · {f.contentType}
        </Fact>
        <Fact term="Size">{formatBytes(f.byteSize)}</Fact>
        <Fact term="Uploaded">
          {at(f.createdAt)}
          {f.uploadedBy ? ` by ${f.uploadedBy}` : ""}
        </Fact>
        <Fact term="Playback">{statusWords[f.streamStatus] ?? f.streamStatus}</Fact>
        <Fact term="Analysis">{statusWords[f.analysisStatus] ?? f.analysisStatus}</Fact>
        {f.pageCount !== null && (
          <Fact term="Pages">
            {f.pagesDrawn} of {f.pageCount} drawn
          </Fact>
        )}
        <Fact term="File" tabular>
          {f.id}
        </Fact>
      </Facts>
      <Part title="Stored">
        <Line>
          <span className="tabular">{f.blob.key}</span>
          <span className="text-ink-3">
            {" "}
            · {f.blob.backend} · {formatBytes(f.blob.byteSize)} · key version {f.blob.keyVersion}
          </span>
        </Line>
        <Line>
          <span className="text-ink-3">SHA-256 </span>
          <span className="tabular">{f.blob.sha256 ?? "not measured yet"}</span>
        </Line>
      </Part>
      {f.renditions.length > 0 && (
        <Part title="Renditions">
          {f.renditions.map((r) => (
            <Line key={r.name}>
              <span className="text-ink">{r.name}</span>
              <span className="text-ink-3">
                {" "}
                · {r.codecs} · {Math.round(r.bandwidth / 1000)} kbit/s
                {r.width && r.height ? ` · ${r.width}×${r.height}` : ""} · {r.segments} segments ·
                key version {r.keyVersion}
              </span>
            </Line>
          ))}
        </Part>
      )}
      <Part title="Jobs">
        {f.jobs === null ? (
          <Line>The job queue could not be read.</Line>
        ) : f.jobs.length === 0 ? (
          <Line>No job has touched it.</Line>
        ) : (
          f.jobs.map((j) => (
            <Line key={j.id}>
              <span className="text-ink">{j.name}</span>
              <span className="text-ink-3">
                {" "}
                · {j.state}
                {j.retries > 0
                  ? ` after ${j.retries} ${j.retries === 1 ? "retry" : "retries"}`
                  : ""}{" "}
                · {at(j.createdAt)}
              </span>
            </Line>
          ))
        )}
      </Part>
      {f.errors.length > 0 && (
        <Part title="Errors">
          {f.errors.map((e) => (
            <Line key={e.reference}>
              <Button
                variant="quiet"
                size="sm"
                className="tabular h-auto px-0 text-ink underline decoration-line underline-offset-2"
                aria-label={`Open ${e.reference}`}
                onClick={() => onReference(e.reference)}
              >
                {e.reference}
              </Button>
              <span className="text-ink-3">
                {" "}
                · {e.message} · {at(e.occurredAt)}
              </span>
            </Line>
          ))}
        </Part>
      )}
      <Access tally={f.access} empty="Nobody has opened it." />
    </Card>
  );
}

const permissionWords = (p: ReviewInspection["reviewers"][number]["permissions"]) =>
  [
    p.decide ? "decides" : null,
    p.comment ? "comments" : "no comments",
    p.download !== "none" ? `downloads ${p.download}` : null,
    p.items ? `${p.items.length} of the items` : null,
    p.maxPlays ? `${p.maxPlays} plays each` : null,
    p.expiresAt ? `until ${at(p.expiresAt)}` : null,
  ]
    .filter(Boolean)
    .join(", ");

function ReviewCard({ review: r }: { review: ReviewInspection }) {
  return (
    <Card title={r.title} where={`${r.workspace.name} · ${r.project.name}`}>
      <Facts>
        <Fact term="Kind">
          {r.kind} · {r.status}
          {r.outcome ? ` · ${r.outcome.replaceAll("_", " ")}` : ""}
        </Fact>
        <Fact term="Sent">
          {at(r.createdAt)}
          {r.createdBy ? ` by ${r.createdBy}` : ""}
        </Fact>
        {r.dueAt && <Fact term="Due">{at(r.dueAt)}</Fact>}
        {r.completedAt && <Fact term="Finished">{at(r.completedAt)}</Fact>}
        <Fact term="Review" tabular>
          {r.id}
        </Fact>
      </Facts>
      <Part title={`Items (${r.items.length})`}>
        {r.items.map((i) => (
          <Line key={i.id}>{i.name}</Line>
        ))}
      </Part>
      <Part title="Reviewers">
        {r.reviewers.map((v) => (
          <Line key={v.id}>
            <span className="text-ink">{v.name}</span>
            <span className="text-ink-3">
              {" "}
              · {v.email}
              {v.guest ? " · guest" : ""} · opened {v.opened} of {r.items.length} · viewed{" "}
              {at(v.viewedAt)}
              {v.submittedAt ? ` · submitted ${at(v.submittedAt)}` : ""}
              {v.sessions
                ? ` · ${v.sessions.count} ${v.sessions.count === 1 ? "session" : "sessions"}, last ${at(v.sessions.lastSeenAt)}`
                : ""}
            </span>
            <span className="block text-ink-3">{permissionWords(v.permissions)}</span>
          </Line>
        ))}
      </Part>
      <Access tally={r.access} empty="Nothing in it has been opened." />
    </Card>
  );
}

const factorWords: Record<string, string> = {
  password: "a password",
  second_factor: "a password and a second factor",
  passkey: "a passkey",
};

function SessionCard({ session: s }: { session: SessionInspection }) {
  return (
    <Card
      title={s.who.name}
      where={`${s.kind === "guest" ? "Guest" : "Member"} · ${s.workspace?.name ?? "no workspace"}`}
    >
      <Facts>
        <Fact term="Email">{s.who.email}</Fact>
        <Fact term="Began">{at(s.createdAt)}</Fact>
        <Fact term="Last used">{at(s.lastUsedAt)}</Fact>
        <Fact term={s.ended ? "Ended" : "Expires"}>{s.ended ? "yes" : at(s.expiresAt)}</Fact>
        {s.factor && <Fact term="Signed in with">{factorWords[s.factor] ?? s.factor}</Fact>}
        {s.ipAddress && (
          <Fact term="From" tabular>
            {s.ipAddress}
          </Fact>
        )}
        {s.userAgent && <Fact term="Browser">{s.userAgent}</Fact>}
        <Fact term="Session" tabular>
          {s.id}
        </Fact>
      </Facts>
      <Access tally={s.access} empty="Nothing opened in this session." />
    </Card>
  );
}
