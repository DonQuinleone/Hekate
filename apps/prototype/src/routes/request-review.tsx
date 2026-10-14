import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Avatar } from "~/components/avatar";
import { Icon } from "~/components/icons";
import { Label } from "~/components/label";
import { usePageHeader } from "~/components/page-header";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  files,
  groups,
  guests,
  latestVersion,
  personById,
  projectById,
  type ReviewKind,
  type Tool,
  tracks,
} from "~/data";
import { cn } from "~/lib/cn";
import { useViewer } from "~/viewer/context";
import { Refused } from "~/viewer/state-gate";

const kinds: { id: ReviewKind; label: string; hint: string }[] = [
  {
    id: "approval",
    label: "Approval",
    hint: "Each reviewer records Approved or Changes requested. Logged, append-only.",
  },
  {
    id: "feedback",
    label: "Feedback",
    hint: "Comments, then Submit feedback. No formal sign-off.",
  },
  {
    id: "share",
    label: "Share",
    hint: "Listen or look, nothing to submit. The same permissions and expiry.",
  },
];

const toolNames: Record<Tool, string> = {
  qa: "QA",
  meters: "Meters",
  spectrogram: "Spectrogram",
  score: "Score",
  takes: "Takes",
  compare: "Compare",
  loops: "Loops",
  normalise: "Normalisation toggle",
  download: "Download",
  production: "Production",
};

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="grid gap-3 border-t border-hairline-soft py-5 @3xl/app:grid-cols-[200px_minmax(0,1fr)]">
      <div>
        <h2 className="m-0 text-[13px] font-medium text-ink">{title}</h2>
        {hint && <p className="m-0 mt-1 text-xs text-ink-3">{hint}</p>}
      </div>
      <div className="flex min-w-0 flex-col gap-3">{children}</div>
    </section>
  );
}

function Chip({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: React.ReactNode;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "h-7 rounded-chip border px-2.5 text-xs",
        active
          ? "border-edge bg-raised text-ink shadow-1"
          : "border-transparent text-ink-3 hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}

export function RequestReviewPage({
  projectId,
  kind: kindParam,
  item,
}: {
  projectId?: string;
  kind?: string;
  item?: string;
}) {
  const viewer = useViewer();
  const navigate = useNavigate();
  const candidates = viewer.projects().filter((p) => viewer.can(p.id, "request_reviews"));
  const [project, setProject] = useState(projectId ?? candidates[0]?.id ?? "");
  const [kind, setKind] = useState<ReviewKind>((kindParam as ReviewKind) ?? "approval");
  const [order, setOrder] = useState<"parallel" | "sequence">("parallel");
  const [rule, setRule] = useState<"all" | "any" | "quorum">("all");
  const [items, setItems] = useState<Set<string>>(new Set(item ? [item] : []));
  const [people, setPeople] = useState<Set<string>>(new Set(["p-mira", "p-tomas"]));
  const [adjusting, setAdjusting] = useState<string | null>(null);
  usePageHeader({ crumbs: [{ label: "Reviews", to: "/reviews" }], title: "Request a review" });
  if (candidates.length === 0)
    return (
      <Refused
        title="Not for your role"
        text="Requesting reviews needs the permission in a project role. Ask a producer."
      />
    );
  const proj = projectById(project);
  const projectTracks = tracks.filter((t) => t.projectId === project && latestVersion(t));
  const loose = files.filter(
    (f) =>
      f.projectId === project &&
      !tracks.some((t) => t.versions.some((v) => v.variations.some((x) => x.fileId === f.id))),
  );
  const toggle = <T,>(set: Set<T>, v: T, update: (s: Set<T>) => void) => {
    const next = new Set(set);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    update(next);
  };
  const chosen = [...people];
  return (
    <form
      className="mx-auto flex max-w-4xl flex-col px-4 py-4 @3xl/app:px-6"
      onSubmit={(e) => {
        e.preventDefault();
        navigate({
          to: "/reviews/$reviewId",
          params: {
            reviewId:
              kind === "share"
                ? "rev-share-rehearsal"
                : kind === "feedback"
                  ? "rev-mixnotes"
                  : "rev-masters",
          },
        });
      }}
    >
      <Section title="Kind">
        <div role="radiogroup" className="grid gap-2 @3xl/app:grid-cols-3">
          {kinds.map((k) => (
            <label
              key={k.id}
              className={cn(
                "flex cursor-pointer flex-col gap-1 rounded-panel border p-3",
                kind === k.id
                  ? "border-signal/60 bg-signal/10"
                  : "border-hairline hover:border-edge",
              )}
            >
              <input
                type="radio"
                name="kind"
                value={k.id}
                checked={kind === k.id}
                onChange={() => setKind(k.id)}
                className="sr-only"
              />
              <span className="text-[13px] font-medium text-ink">{k.label}</span>
              <span className="text-xs text-ink-3">{k.hint}</span>
            </label>
          ))}
        </div>
      </Section>
      <Section title="What" hint="Tracks at their latest version or a chosen one, and files.">
        <div className="flex items-center gap-2">
          <Label>Project</Label>
          <select
            value={project}
            onChange={(e) => {
              setProject(e.target.value);
              setItems(new Set());
            }}
            className="h-8 rounded-control border border-edge bg-ground px-2 text-[13px] text-ink"
          >
            {candidates.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <ul className="m-0 list-none rounded-panel border border-hairline bg-surface p-0">
          {projectTracks.map((t) => {
            const v = latestVersion(t);
            const on = items.has(t.id);
            return (
              <li
                key={t.id}
                className="flex items-center gap-3 border-b border-hairline-soft px-3 py-2 last:border-b-0"
              >
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => toggle(items, t.id, setItems)}
                  aria-label={t.name}
                />
                <Icon name="track" className="text-ink-3" />
                <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{t.name}</span>
                {on && (
                  <select
                    defaultValue="latest"
                    className="h-7 rounded-control border border-edge bg-ground px-2 text-xs text-ink"
                  >
                    <option value="latest">Latest (V{v?.number})</option>
                    {t.versions.map((x) => (
                      <option key={x.id} value={x.number}>
                        V{x.number}
                      </option>
                    ))}
                  </select>
                )}
              </li>
            );
          })}
          {loose.slice(0, 5).map((f) => (
            <li
              key={f.id}
              className="flex items-center gap-3 border-b border-hairline-soft px-3 py-2 last:border-b-0"
            >
              <input
                type="checkbox"
                checked={items.has(f.id)}
                onChange={() => toggle(items, f.id, setItems)}
                aria-label={f.name}
              />
              <Icon name="file" className="text-ink-3" />
              <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{f.name}</span>
            </li>
          ))}
        </ul>
      </Section>
      <Section
        title="Who"
        hint="Members, guests and groups. A guest reaches only these items, through a link sent by email."
      >
        <ul className="m-0 list-none rounded-panel border border-hairline bg-surface p-0">
          {proj?.members.map((m) => {
            const p = personById(m.personId);
            const on = people.has(m.personId);
            const role = proj.roles.find((r) => r.id === m.roleId);
            const canDecide = role?.permissions.includes("decide");
            return (
              <li key={m.personId} className="border-b border-hairline-soft last:border-b-0">
                <div className="flex items-center gap-3 px-3 py-2">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => toggle(people, m.personId, setPeople)}
                    aria-label={p.name}
                    disabled={kind === "approval" && !canDecide}
                  />
                  <Avatar personId={m.personId} size={22} />
                  <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
                    {p.name} <span className="text-ink-3">· {role?.name}</span>
                    {kind === "approval" && !canDecide && (
                      <span className="text-ink-3"> · cannot decide, follows along</span>
                    )}
                  </span>
                  {on && order === "sequence" && (
                    <Input
                      defaultValue={String(chosen.indexOf(m.personId) + 1)}
                      aria-label="Step"
                      className="h-7 w-12 text-center"
                    />
                  )}
                  {on && (
                    <button
                      type="button"
                      onClick={() => setAdjusting(adjusting === m.personId ? null : m.personId)}
                      className="text-xs text-ink-3 hover:text-ink"
                    >
                      {adjusting === m.personId ? "Done" : "Permissions"}
                    </button>
                  )}
                </div>
                {adjusting === m.personId && <Permissions guest={false} />}
              </li>
            );
          })}
          {guests.map((g) => {
            const p = personById(g.personId);
            const on = people.has(`guest-${g.personId}`);
            return (
              <li key={g.personId} className="border-b border-hairline-soft last:border-b-0">
                <div className="flex items-center gap-3 px-3 py-2">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => toggle(people, `guest-${g.personId}`, setPeople)}
                    aria-label={p.name}
                  />
                  <Avatar personId={g.personId} size={22} />
                  <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
                    {p.name} <span className="text-ink-3">· {g.label}, guest</span>
                  </span>
                  {on && order === "sequence" && (
                    <Input
                      defaultValue={String(chosen.indexOf(`guest-${g.personId}`) + 1)}
                      aria-label="Step"
                      className="h-7 w-12 text-center"
                    />
                  )}
                  {on && (
                    <button
                      type="button"
                      onClick={() => setAdjusting(adjusting === g.personId ? null : g.personId)}
                      className="text-xs text-ink-3 hover:text-ink"
                    >
                      {adjusting === g.personId ? "Done" : "Permissions"}
                    </button>
                  )}
                </div>
                {adjusting === g.personId && <Permissions guest />}
              </li>
            );
          })}
          {groups
            .filter((g) => g.projectId === project)
            .map((g) => (
              <li
                key={g.id}
                className="flex items-center gap-3 border-b border-hairline-soft px-3 py-2 last:border-b-0"
              >
                <input
                  type="checkbox"
                  checked={people.has(g.id)}
                  onChange={() => toggle(people, g.id, setPeople)}
                  aria-label={g.name}
                />
                <Icon name="users" className="text-ink-3" />
                <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
                  {g.name}{" "}
                  <span className="text-ink-3">
                    · group,{" "}
                    {g.personIds.map((id) => personById(id).name.split(" ")[0]).join(" and ")}
                  </span>
                </span>
                {people.has(g.id) && order === "sequence" && (
                  <Input defaultValue="2" aria-label="Step" className="h-7 w-12 text-center" />
                )}
              </li>
            ))}
        </ul>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm">
            <Icon name="plus" size={14} />
            Invite a guest by email
          </Button>
          <span className="text-xs text-ink-3">
            Someone named twice is asked once, at their first step.
          </span>
        </div>
      </Section>
      {kind !== "share" && (
        <Section title="Order and rule">
          <div className="flex flex-wrap items-center gap-6">
            <div className="flex items-center gap-2">
              <Label>Order</Label>
              <Chip active={order === "parallel"} onClick={() => setOrder("parallel")}>
                All at once
              </Chip>
              <Chip active={order === "sequence"} onClick={() => setOrder("sequence")}>
                In turn
              </Chip>
            </div>
            {kind === "approval" && (
              <div className="flex items-center gap-2">
                <Label>Approved when</Label>
                <Chip active={rule === "all"} onClick={() => setRule("all")}>
                  Everyone approves
                </Chip>
                <Chip active={rule === "any"} onClick={() => setRule("any")}>
                  Any one approves
                </Chip>
                <Chip active={rule === "quorum"} onClick={() => setRule("quorum")}>
                  A share
                </Chip>
                {rule === "quorum" && (
                  <span className="flex items-center gap-1 text-xs text-ink-3">
                    <Input
                      defaultValue="66"
                      className="h-7 w-14 text-center"
                      aria-label="Percent"
                    />
                    %
                  </span>
                )}
              </div>
            )}
          </div>
          <p className="m-0 text-xs text-ink-3">
            {order === "sequence"
              ? "Each step starts when the one before finishes. Everyone at a step acts together."
              : "Everyone is asked now."}{" "}
            Any Changes requested is logged whatever the rule.
          </p>
        </Section>
      )}
      <Section title="When and why">
        <div className="grid gap-3 @3xl/app:grid-cols-[200px_minmax(0,1fr)]">
          <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
            {kind === "share" ? "Expires" : "Due"}
            <Input type="date" defaultValue="2026-10-30" />
          </label>
          <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
            Message
            <textarea
              rows={3}
              placeholder="Final masters for the album. Listen on headphones and on speakers, please."
              className="rounded-control border border-edge bg-ground px-3 py-2 text-[13px] text-ink placeholder:text-ink-3 focus:border-ink-3 focus:outline-none"
            />
          </label>
        </div>
      </Section>
      <Section
        title="Everyone's permissions"
        hint="The defaults for this review; adjust one person above. A member's role is the most a review can grant."
      >
        <Permissions guest={false} />
      </Section>
      <div className="flex items-center gap-3 border-t border-hairline-soft py-5">
        <span className="text-xs text-ink-3">
          {kind === "share" ? "Shares" : "Invitations"} go by email when you send. {items.size}{" "}
          {items.size === 1 ? "item" : "items"}, {people.size}{" "}
          {people.size === 1 ? "person" : "people"}.
        </span>
        <Button variant="ghost" className="ml-auto" asChild>
          <Link to="/reviews">Cancel</Link>
        </Button>
        <Button variant="primary" type="submit" disabled={items.size === 0 || people.size === 0}>
          <Icon name="send" size={14} />
          {kind === "share" ? "Share" : "Send the review"}
        </Button>
      </div>
    </form>
  );
}

/** One reviewer's permission set: what they see, what they can do, how long for. */
export function Permissions({ guest, compact = false }: { guest: boolean; compact?: boolean }) {
  const [scope, setScope] = useState<"all" | "own_and_replies" | "own">(
    guest ? "own_and_replies" : "all",
  );
  const [tools, setTools] = useState<Set<Tool>>(
    new Set<Tool>(guest ? ["loops", "score"] : ["loops", "compare", "score", "meters"]),
  );
  const [download, setDownload] = useState<"none" | "proxy" | "original">("none");
  const toggleTool = (t: Tool) => {
    const next = new Set(tools);
    if (next.has(t)) next.delete(t);
    else next.add(t);
    setTools(next);
  };
  return (
    <div
      className={cn(
        "grid gap-4 text-[13px]",
        compact ? "" : "rounded-panel border border-hairline bg-ground p-4",
        "@3xl/app:grid-cols-2",
      )}
    >
      <div className="flex flex-col gap-1.5">
        <Label>Comments they see</Label>
        <div className="flex flex-wrap gap-1">
          <Chip active={scope === "all"} onClick={() => setScope("all")}>
            Everyone's
          </Chip>
          <Chip active={scope === "own_and_replies"} onClick={() => setScope("own_and_replies")}>
            Theirs and replies
          </Chip>
          <Chip active={scope === "own"} onClick={() => setScope("own")}>
            Only theirs
          </Chip>
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label>Actions</Label>
        <div className="flex flex-wrap gap-4 text-ink-2">
          <label className="flex items-center gap-1.5">
            <input type="checkbox" defaultChecked /> Comment
          </label>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" defaultChecked /> Record a decision
          </label>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" /> Invite others
          </label>
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label>Tools</Label>
        <div className="flex flex-wrap gap-1">
          {(
            [
              "loops",
              "compare",
              "score",
              "meters",
              "spectrogram",
              "qa",
              "takes",
              "normalise",
            ] as Tool[]
          ).map((t) => (
            <Chip key={t} active={tools.has(t)} onClick={() => toggleTool(t)}>
              {toolNames[t]}
            </Chip>
          ))}
        </div>
        {!guest && (
          <span className="text-xs text-ink-3">
            A member keeps the tools of their role; a review can only take away.
          </span>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <Label>History and download</Label>
        <div className="flex flex-wrap items-center gap-4 text-ink-2">
          <label className="flex items-center gap-1.5">
            <input type="checkbox" defaultChecked={!guest} /> Earlier versions
          </label>
          <span className="flex items-center gap-1">
            <Chip active={download === "none"} onClick={() => setDownload("none")}>
              No download
            </Chip>
            <Chip active={download === "proxy"} onClick={() => setDownload("proxy")}>
              Proxy
            </Chip>
            <Chip active={download === "original"} onClick={() => setDownload("original")}>
              Original
            </Chip>
          </span>
        </div>
        {download !== "none" && (
          <span className="text-xs text-ink-3">Watermarked per recipient and logged.</span>
        )}
      </div>
      <div className="flex flex-col gap-1.5 @3xl/app:col-span-2">
        <Label>Access window</Label>
        <div className="flex flex-wrap items-center gap-3 text-ink-2">
          <label className="flex items-center gap-2">
            From <Input type="datetime-local" className="h-7 w-44" />
          </label>
          <label className="flex items-center gap-2">
            Until{" "}
            <Input
              type="datetime-local"
              defaultValue={guest ? "2026-10-31T23:59" : ""}
              className="h-7 w-44"
            />
          </label>
          <label className="flex items-center gap-2">
            At most <Input type="number" placeholder="∞" className="h-7 w-16" /> plays
          </label>
        </div>
      </div>
    </div>
  );
}
