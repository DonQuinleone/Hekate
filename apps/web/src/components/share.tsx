import type { DownloadLevel, GuestInput, ReviewerInput } from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import {
  meQuery,
  projectGroupsQuery,
  projectMembersQuery,
  projectTracksQuery,
  useCreateReview,
} from "~/lib/queries";
import { endOfDay } from "~/lib/shares";
import { GuestFields } from "./guest-fields";
import { Icon } from "./icons";
import { Button } from "./ui/button";
import { ToggleChip } from "./ui/chip";
import { Checkbox } from "./ui/choice";
import { Dialog } from "./ui/dialog";
import { Input, Textarea } from "./ui/input";
import { Segmented } from "./ui/segmented";
import { Switch } from "./ui/toggle";

const downloads: { value: DownloadLevel; label: string }[] = [
  { value: "none", label: "None" },
  { value: "proxy", label: "Proxy" },
  { value: "original", label: "Original" },
];

/** A date input's value, a fortnight from now: when a share ends unless told otherwise. */
const inAFortnight = () => new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);

/**
 * Sharing is not reviewing (#138): a share gives people a way to listen or look, with the
 * same protections, and asks nothing of them. One dialog, no steps, as the prototype's.
 */
export function ShareDialog({
  projectId,
  trackId,
  onClose,
}: {
  projectId: string;
  /** A track to start with, when shared from its row. */
  trackId?: string;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const { data: tracks = [] } = useQuery(projectTracksQuery(projectId));
  const { data: everyone = [] } = useQuery(projectMembersQuery(projectId));
  const { data: me } = useQuery(meQuery);
  // You share with others: you have it already.
  const members = everyone.filter((m) => m.userId !== me?.user.id);
  const { data: groups = [] } = useQuery(projectGroupsQuery(projectId));
  const create = useCreateReview(projectId);
  const [items, setItems] = useState<Set<string>>(new Set(trackId ? [trackId] : []));
  const [people, setPeople] = useState<Set<string>>(new Set());
  const [guests, setGuests] = useState<GuestInput[]>([]);
  const [message, setMessage] = useState("");
  const [download, setDownload] = useState<DownloadLevel>("none");
  const [expires, setExpires] = useState(true);
  const [until, setUntil] = useState(inAFortnight);
  const shareable = tracks.filter((t) => t.versions.length > 0);
  const flip = (set: Set<string>, key: string) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  };
  const reviewers: ReviewerInput[] = [
    ...[...people].map((key) =>
      key.startsWith("group:") ? { groupId: key.slice("group:".length) } : key,
    ),
    ...guests,
  ];
  const ready = items.size > 0 && reviewers.length > 0 && (!expires || Boolean(until));
  const send = () =>
    create.mutate(
      {
        kind: "share",
        items: [...items].map((id) => ({ trackId: id })),
        reviewers,
        message: message.trim() || undefined,
        permissions: {
          download,
          expiresAt: expires && until ? endOfDay(until) : null,
        },
      },
      {
        onSuccess: (review) => {
          onClose();
          void navigate({ to: "/reviews/$reviewId", params: { reviewId: review.id } });
        },
      },
    );
  return (
    <Dialog
      title="Share"
      description="For someone who only needs to listen or look. Nothing is asked of them, and what they open is logged."
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={send} disabled={!ready || create.isPending}>
            Send
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
          <legend className="label mb-2">What</legend>
          {shareable.length === 0 ? (
            <p className="m-0 text-[13px] text-ink-3">
              Nothing to share yet: a track needs a version first.
            </p>
          ) : (
            <ul className="m-0 flex list-none flex-col divide-y divide-line rounded-panel border border-line p-0">
              {shareable.map((t) => (
                <li key={t.id}>
                  <label className="flex min-h-10 cursor-pointer items-center gap-3 px-3 py-2 text-[14px] text-ink">
                    <Checkbox
                      checked={items.has(t.id)}
                      onChange={() => setItems((s) => flip(s, t.id))}
                    />
                    <Icon name="track" size={15} className="text-ink-3" />
                    <span className="min-w-0 flex-1 truncate">{t.name}</span>
                    <span className="tabular text-[12px] text-ink-3">
                      V{Math.max(...t.versions.map((v) => v.number))}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </fieldset>
        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
          <legend className="label mb-2">With</legend>
          <div className="flex flex-wrap gap-1.5">
            {members.map((m) => (
              <ToggleChip
                key={m.userId}
                pressed={people.has(m.userId)}
                onClick={() => setPeople((s) => flip(s, m.userId))}
              >
                {m.name}
              </ToggleChip>
            ))}
            {groups.map((g) => (
              <ToggleChip
                key={g.id}
                pressed={people.has(`group:${g.id}`)}
                onClick={() => setPeople((s) => flip(s, `group:${g.id}`))}
              >
                {g.name} group
              </ToggleChip>
            ))}
            {guests.map((g) => (
              <ToggleChip
                key={g.email}
                pressed
                aria-label={`Leave out ${g.name}`}
                onClick={() => setGuests((list) => list.filter((x) => x.email !== g.email))}
              >
                {g.name}
                <Icon name="close" size={11} />
              </ToggleChip>
            ))}
          </div>
          <GuestFields
            submitLabel="Add"
            onAdd={(g) =>
              setGuests((list) =>
                list.some((x) => x.email.toLowerCase() === g.email.toLowerCase())
                  ? list
                  : [...list, g],
              )
            }
          />
          <Textarea
            rows={2}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="A line to go with it (optional)"
            aria-label="A line to go with it"
          />
        </fieldset>
        <div className="grid gap-4 @md/app:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <span className="label">Download</span>
            <Segmented
              label="Download"
              value={download}
              options={downloads}
              onChange={setDownload}
              className="self-start"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="label">Expires</span>
            <div className="flex items-center gap-3">
              <Switch label="Expires" checked={expires} onChange={setExpires} />
              <Input
                type="date"
                value={until}
                onChange={(e) => setUntil(e.target.value)}
                aria-label="Expires on"
                className="h-8 w-40"
                disabled={!expires}
              />
            </div>
          </div>
        </div>
        {create.error && <p className="m-0 text-[13px] text-signal">{create.error.message}</p>}
      </div>
    </Dialog>
  );
}
