import type { GuestInput } from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import {
  meQuery,
  projectFilesQuery,
  projectFoldersQuery,
  projectGroupsQuery,
  projectGuestsQuery,
  projectMembersQuery,
  projectTracksQuery,
  useCreateReview,
} from "~/lib/queries";
import {
  type LinkLife,
  linkLifeChoice,
  linkLifeWords,
  linkLives,
  reviewerFromKey,
  type ShareAccess,
  type ShareTarget,
  shareAccessCopy,
  shareAccesses,
  shareRequest,
  targetItems,
  targetPath,
} from "~/lib/shares";
import { Icon } from "./icons";
import { PeoplePicker, type Person } from "./people-picker";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { Dropdown } from "./ui/menu";
import { Segmented } from "./ui/segmented";

const kindWords: Record<ShareTarget["kind"], string> = {
  file: "File",
  track: "Track",
  folder: "Folder",
  version: "Version",
};

/** The address of a path in this app, as it is copied; the host and path alone, as shown. */
const addressOf = (path: string) => ({
  full: `${window.location.origin}${path}`,
  shown: `${window.location.host}${path}`,
});

/**
 * Sharing one item (#489), as a share sheet does it: who, how, and a link, then Send. The
 * item is the title, so nothing asks what to share. Viewing is a share (#138); commenting,
 * and downloading with it, a feedback review. "More options" carries the choices into the
 * full request page, for stages, an order or a deadline. The same sheet opens from a row in
 * the file browser, the player's header and a track's versions.
 */
export function ShareDialog({
  projectId,
  item,
  onClose,
}: {
  projectId: string;
  item: ShareTarget;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const { data: everyone = [] } = useQuery(projectMembersQuery(projectId));
  const { data: me } = useQuery(meQuery);
  const { data: groups = [] } = useQuery(projectGroupsQuery(projectId));
  const { data: known = [] } = useQuery(projectGuestsQuery(projectId));
  // A folder shares what is in it, at every depth: the project's tree says what that is.
  const folder = item.kind === "folder";
  const { data: folders = [] } = useQuery({ ...projectFoldersQuery(projectId), enabled: folder });
  const { data: tracks, isSuccess: tracksIn } = useQuery({
    ...projectTracksQuery(projectId),
    enabled: folder,
  });
  const { data: files, isSuccess: filesIn } = useQuery({
    ...projectFilesQuery(projectId),
    enabled: folder,
  });
  const create = useCreateReview(projectId);
  const [chosen, setChosen] = useState<Person[]>([]);
  const [access, setAccess] = useState<ShareAccess>("view");
  const [life, setLife] = useState<LinkLife>(7);
  const [copied, setCopied] = useState(false);

  // You share with others: you have it already.
  const people: Person[] = [
    ...everyone
      .filter((m) => m.userId !== me?.user.id)
      .map(
        (m): Person => ({ key: `member:${m.userId}`, name: m.name, hint: m.email, kind: "member" }),
      ),
    ...groups.map(
      (g): Person => ({
        key: `group:${g.id}`,
        name: g.name,
        hint: `${g.members.length} ${g.members.length === 1 ? "person" : "people"}`,
        kind: "group",
      }),
    ),
    ...known.map(
      (g): Person => ({
        key: `guest:${g.email}`,
        name: g.name,
        hint: g.label ?? g.email,
        kind: "guest",
      }),
    ),
  ];
  const knownByEmail = new Map<string, GuestInput>(
    known.map((g) => [g.email, { name: g.name, email: g.email, label: g.label ?? undefined }]),
  );
  const items = targetItems(item, { folders, tracks: tracks ?? [], files: files ?? [] });
  const emptyFolder = folder && tracksIn && filesIn && items.length === 0;
  const what =
    item.what ??
    (folder
      ? `Folder, ${items.length === 1 ? "1 item" : `${items.length} items`}`
      : kindWords[item.kind]);
  const sent = create.data;
  const address = addressOf(sent ? `/reviews/${sent.id}` : targetPath(item, projectId));
  const ready = chosen.length > 0 && items.length > 0 && !create.isPending;

  const copy = () => {
    void navigator.clipboard?.writeText(address.full).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };
  const send = () =>
    create.mutate(
      shareRequest({
        access,
        life,
        items,
        reviewers: chosen.map((p) => reviewerFromKey(p.key, knownByEmail)),
        now: new Date(),
      }),
    );
  // The full page, with these choices made: stages, an order and a deadline live there.
  const more = () => {
    onClose();
    const request = shareRequest({ access, life, items, reviewers: [], now: new Date() });
    void navigate({
      to: "/projects/$projectId/reviews/new",
      params: { projectId },
      search: {
        kind: request.kind === "feedback" ? "feedback" : undefined,
        // A share sheet names tracks and files; folders and the workspace are the page's own.
        items: items.flatMap((i) =>
          "trackId" in i ? [`track:${i.trackId}`] : "fileId" in i ? [`file:${i.fileId}`] : [],
        ),
        version: item.kind === "version" ? item.id : undefined,
        people: chosen.map((p) => p.key),
        download: request.permissions?.download,
        // Null is a choice too (until withdrawn): it travels as "never", not as nothing.
        until: request.permissions ? (request.permissions.expiresAt ?? "never") : undefined,
      },
    });
  };

  const linkRow = (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <div className="flex h-9 min-w-0 flex-1 basis-56 items-center gap-2 rounded-control border border-line bg-ground/70 pr-1 pl-3">
        <Icon name="link" size={14} className="shrink-0 text-ink-3" />
        <span className="min-w-0 flex-1 truncate text-[13px] text-ink-2" title={address.full}>
          {address.shown}
        </span>
        <Button variant="ghost" size="sm" onClick={copy} aria-live="polite">
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      {sent ? (
        <span className="text-[13px] text-ink-2">{linkLifeWords(life)}</span>
      ) : (
        <Dropdown
          size="sm"
          label="How long the link works"
          value={linkLifeWords(life)}
          actions={linkLives.map((choice) => ({
            label: linkLifeChoice(choice),
            checked: choice === life,
            onSelect: () => setLife(choice),
          }))}
        />
      )}
    </div>
  );

  if (sent) {
    const names = chosen.map((p) => p.name);
    const who =
      names.length <= 2
        ? names.join(" and ")
        : `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
    return (
      <Dialog
        title={`Share ${item.name}`}
        description={what}
        onClose={onClose}
        footer={
          <>
            <Button variant="ghost" asChild>
              <Link to="/reviews/$reviewId" params={{ reviewId: sent.id }}>
                {sent.kind === "share" ? "See who opens it" : "See the review"}
              </Link>
            </Button>
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <p className="m-0 flex items-center gap-2 text-[14px] text-ink">
            <Icon name="check" size={15} className="shrink-0 text-ink-2" />
            Sent to {who}. Guests get a link of their own by email.
          </p>
          {linkRow}
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      title={`Share ${item.name}`}
      description={what}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={more} className="mr-auto">
            More options
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={send} disabled={!ready}>
            Send
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-1.5">
          <span className="label">Who</span>
          <PeoplePicker
            label="Who"
            people={people}
            chosen={chosen}
            onChange={setChosen}
            autoFocus
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="label">How</span>
          <Segmented
            label="How"
            value={access}
            options={shareAccesses.map((a) => ({ value: a, label: shareAccessCopy[a].label }))}
            onChange={setAccess}
            className="self-start"
          />
          <p className="m-0 text-[13px] text-ink-3">{shareAccessCopy[access].hint}</p>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="label">Link</span>
          {linkRow}
        </div>
        {emptyFolder && (
          <p className="m-0 text-[13px] text-ink-3">Nothing in this folder to share yet.</p>
        )}
        {create.error && (
          <p role="alert" className="m-0 text-[13px] text-signal">
            {create.error.message}
          </p>
        )}
      </div>
    </Dialog>
  );
}
