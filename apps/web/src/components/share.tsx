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
  type ShareDownload,
  type ShareTarget,
  shareAccessCopy,
  shareAccesses,
  shareDownloadCopy,
  shareDownloads,
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

/** The address of a path in this app, as it is copied; the host and path alone, as shown. */
const addressOf = (path: string) => ({
  full: `${window.location.origin}${path}`,
  shown: `${window.location.host}${path}`,
});

/**
 * Sharing one item (#489), as a share sheet does it: who, how, what they may download and
 * when their access ends, then Send. The item is the title, so nothing asks what to share.
 * Viewing is a share (#138); commenting a feedback review, and the sheet says so before it
 * is sent (#578). Copying the link is for members with access, apart from the recipients'
 * end. "More options" carries the choices into the full request page, for stages, an order
 * or a deadline. The same sheet opens from a row in the file browser, the player's header
 * and a track's versions.
 */
export function ShareDialog({
  projectId,
  item: first,
  alternative = null,
  onClose,
}: {
  projectId: string;
  item: ShareTarget;
  /** Another thing it could share instead (#578): from a track's file, the file alone. */
  alternative?: ShareTarget | null;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const { data: everyone = [] } = useQuery(projectMembersQuery(projectId));
  const { data: me } = useQuery(meQuery);
  const { data: groups = [] } = useQuery(projectGroupsQuery(projectId));
  const { data: known = [] } = useQuery(projectGuestsQuery(projectId));
  // A folder shares what is in it, at every depth: the project's tree says what that is.
  const folder = first.kind === "folder";
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
  const [alone, setAlone] = useState(false);
  const item = alone && alternative ? alternative : first;
  const [chosen, setChosen] = useState<Person[]>([]);
  const [access, setAccess] = useState<ShareAccess>("view");
  const [download, setDownload] = useState<ShareDownload>("none");
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
        avatar: g.id,
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
  // Only a folder's count is worth a line under its name; "Audio" or "Track" says nothing.
  const what =
    folder && tracksIn && filesIn
      ? items.length === 1
        ? "1 item"
        : `${items.length} items`
      : undefined;
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
        download,
        life,
        items,
        reviewers: chosen.map((p) => reviewerFromKey(p.key, knownByEmail)),
        now: new Date(),
      }),
    );
  // The full page, with these choices made: stages, an order and a deadline live there.
  const more = () => {
    onClose();
    const request = shareRequest({
      access,
      download,
      life,
      items,
      reviewers: [],
      now: new Date(),
    });
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

  // For members who may open it already: its address in the app, which never expires and
  // opens nothing for anyone else. Recipients get their own links by email.
  const linkRow = (
    <div className="flex min-w-0 items-center gap-2 text-[13px] text-ink-3">
      <Icon name="link" size={14} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate" title={address.full}>
        {address.shown}
      </span>
      <Button variant="ghost" size="sm" onClick={copy} aria-live="polite">
        {copied ? "Copied" : "Copy link"}
      </Button>
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
          <p className="m-0 flex items-start gap-2 text-[14px] text-ink">
            <Icon name="check" size={15} className="mt-0.5 shrink-0 text-ink-2" />
            <span>
              {sent.kind === "share"
                ? `Shared with ${who}.`
                : `${who} ${chosen.length === 1 ? "is" : "are"} asked for feedback, without sign-off.`}{" "}
              Their access ends {life === null ? "when you withdraw it" : `in ${life} days`}. Guests
              get a link of their own by email.
            </span>
          </p>
          <div className="flex flex-col gap-1.5">
            <span className="label">Link for members with access</span>
            {linkRow}
          </div>
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
            {/* What Send will do, said before it is pressed (#578). */}
            {access === "view" ? "Share" : "Ask for feedback"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {alternative && (
          <Segmented
            label="What to share"
            value={alone ? "alone" : "whole"}
            options={[
              { value: "whole", label: first.name },
              { value: "alone", label: "This file only" },
            ]}
            onChange={(v) => setAlone(v === "alone")}
            className="self-start"
          />
        )}
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
          <span className="label">Download</span>
          <Segmented
            label="Download"
            value={download}
            options={shareDownloads.map((d) => ({ value: d, label: shareDownloadCopy[d].label }))}
            onChange={setDownload}
            className="self-start"
          />
          {shareDownloadCopy[download].hint && (
            <p className="m-0 text-[13px] text-ink-3">{shareDownloadCopy[download].hint}</p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="label">Access ends</span>
          <Dropdown
            size="sm"
            label="Access ends"
            value={linkLifeWords(life)}
            actions={linkLives.map((choice) => ({
              label: linkLifeChoice(choice),
              checked: choice === life,
              onSelect: () => setLife(choice),
            }))}
          />
        </div>
        <div className="flex flex-col gap-1.5 border-t border-line pt-4">
          <span className="label">Link for members with access</span>
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
