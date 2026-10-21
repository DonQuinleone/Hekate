import {
  formatBytes,
  UPLOAD_REQUEST_MAX_DAYS,
  UPLOAD_REQUEST_MAX_FILES,
  type UploadRequestState,
} from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { Icon } from "~/components/icons";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import { Field } from "~/components/ui/field";
import { Input, Select, Textarea } from "~/components/ui/input";
import { cn } from "~/lib/cn";
import { dayHere, formatDates } from "~/lib/locale";
import {
  type Folder,
  type UploadRequest,
  uploadRequestQuery,
  uploadRequestsQuery,
  useUploadRequests,
} from "~/lib/queries";
import { destinations } from "./file-forms";

const dayFormat = formatDates({ day: "numeric", month: "long" });

/** The day `days` from today, where the member is. */
const dayFromNow = (days: number) => dayHere(Date.now() + days * 86_400_000);

const stateCopy: Record<UploadRequestState, string> = {
  open: "Open",
  full: "Full",
  expired: "Lapsed",
  closed: "Closed",
};

/** A link shown once, to copy. */
function LinkField({ url }: { url: string }) {
  const [copied, setCopied] = useState<"copied" | "failed" | null>(null);
  const copy = () => {
    void navigator.clipboard
      ?.writeText(url)
      .then(() => setCopied("copied"))
      .catch(() => setCopied("failed"));
  };
  return (
    <div className="flex items-center gap-2 rounded-control border border-line bg-ground/60 px-3 py-2">
      <Icon name="link" size={14} className="shrink-0 text-ink-3" />
      <span className="min-w-0 flex-1 truncate text-[13px] text-ink-2" title={url}>
        {url}
      </span>
      <button
        type="button"
        onClick={copy}
        className="shrink-0 rounded-control px-1 text-[13px] text-ink-3 hover:text-ink"
      >
        {copied === "copied" ? "Copied" : copied === "failed" ? "Copy it by hand" : "Copy"}
      </button>
    </div>
  );
}

/** One earlier request: what arrived and from whom, and closing it or giving it a new link. */
function RequestRow({
  request,
  projectId,
  folderName,
}: {
  request: UploadRequest;
  projectId: string;
  folderName: string;
}) {
  const [open, setOpen] = useState(false);
  const { close, relink } = useUploadRequests(projectId);
  const { data } = useQuery({ ...uploadRequestQuery(request.id), enabled: open });
  const live = request.state === "open" || request.state === "full";
  return (
    <li className="border-t border-line first:border-t-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-3 py-2.5 text-left text-[13px]"
      >
        <Icon
          name="chevronRight"
          size={12}
          className={cn("shrink-0 text-ink-3 transition-transform", open && "rotate-90")}
        />
        <span className="min-w-0 flex-1 truncate text-ink">{request.name}</span>
        <span className="tabular shrink-0 text-ink-3">
          {request.arrived} of {request.fileLimit}
        </span>
        <span className={cn("w-14 shrink-0 text-right", live ? "text-ink-2" : "text-ink-3")}>
          {stateCopy[request.state]}
        </span>
      </button>
      {open && (
        <div className="flex flex-col gap-2 pb-3 pl-6">
          <p className="m-0 text-[12px] text-ink-3">
            Into {folderName}, until {dayFormat.format(new Date(request.expiresAt))}
            {request.hasPassword ? ", with a password" : ""}.
          </p>
          {data && data.arrived.length === 0 && (
            <p className="m-0 text-[13px] text-ink-3">Nothing has arrived yet.</p>
          )}
          {data && data.arrived.length > 0 && (
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {data.arrived.map((a) => (
                <li key={a.fileId} className="flex items-center gap-3 text-[13px]">
                  <Link
                    to="/files/$fileId"
                    params={{ fileId: a.fileId }}
                    className="min-w-0 flex-1 truncate text-ink-2 hover:text-ink"
                  >
                    {a.name}
                  </Link>
                  <span className="shrink-0 text-ink-3">{a.sender}</span>
                  <span className="tabular w-16 shrink-0 text-right text-ink-3">
                    {formatBytes(a.byteSize)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {relink.data && <LinkField url={relink.data} />}
          {live && (
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={relink.isPending}
                onClick={() => relink.mutate(request.id)}
              >
                New link
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={close.isPending}
                onClick={() => close.mutate(request.id)}
              >
                Close the request
              </Button>
            </div>
          )}
          {relink.data && (
            <p className="m-0 text-[12px] text-ink-3">The old link no longer works.</p>
          )}
          {(close.error ?? relink.error) && (
            <p className="m-0 text-[13px] text-signal">{(close.error ?? relink.error)?.message}</p>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * Upload requests (#139), as the prototype offers them beside new folders: a link for someone
 * outside the project to upload into a folder, with no account. The link is shown once, as it
 * is made; earlier requests are listed under the form with what arrived and who sent it.
 */
export function UploadRequestDialog({
  projectId,
  folders,
  folderId,
  onClose,
}: {
  projectId: string;
  folders: Folder[];
  folderId: string | null;
  onClose: () => void;
}) {
  const { create } = useUploadRequests(projectId);
  const { data } = useQuery(uploadRequestsQuery(projectId));
  const [name, setName] = useState("");
  const [wanted, setWanted] = useState("");
  const [into, setInto] = useState(folderId ?? "");
  const [limit, setLimit] = useState("5");
  const [expires, setExpires] = useState(dayFromNow(14));
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("");
  const places = destinations(folders, new Set());
  const folderName = (id: string | null) =>
    (id && places.find((p) => p.id === id)?.label) || "the top of the project";

  const fileLimit = Number(limit);
  const limitWrong =
    !Number.isInteger(fileLimit) || fileLimit < 1 || fileLimit > UPLOAD_REQUEST_MAX_FILES;
  const passwordWrong = password.length > 0 && password.length < 8;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || limitWrong || passwordWrong) return;
    create.mutate({
      name: name.trim(),
      wanted: wanted.trim(),
      folderId: into || null,
      fileLimit,
      expiresOn: expires,
      ...(password ? { password } : {}),
      ...(email.trim() ? { email: email.trim() } : {}),
    });
  };

  const made = create.data;
  const earlier = (data?.requests ?? []).filter((r) => r.id !== made?.request.id);
  return (
    <Dialog
      title="Upload request"
      description="A link for someone outside the project to upload into a folder. They need no account."
      onClose={onClose}
      footer={
        made ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              type="submit"
              form="upload-request"
              disabled={!name.trim() || limitWrong || passwordWrong || create.isPending}
            >
              Create the link
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-4">
        {made ? (
          <div className="flex flex-col gap-2">
            <LinkField url={made.link} />
            <p className="m-0 text-[12px] text-ink-3">
              {email.trim() ? `Sent to ${email.trim()}. ` : ""}
              Send it to whoever has the files. It is shown only now; a new link replaces it. Files
              arrive in {folderName(made.request.folderId)}, and are listed here with who sent them.
            </p>
          </div>
        ) : (
          <form id="upload-request" onSubmit={submit} className="flex flex-col gap-4">
            <Field label="Name">
              <Input
                autoFocus
                value={name}
                placeholder="String stems"
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field label="What you want" hint="Shown to them on the upload page.">
              <Textarea
                rows={2}
                value={wanted}
                placeholder="The string stems of Maple Leaf Rag, 96 kHz, one file per section."
                onChange={(e) => setWanted(e.target.value)}
              />
            </Field>
            <div className="grid gap-4 @md/app:grid-cols-[minmax(0,1.5fr)_minmax(0,0.7fr)_minmax(0,1fr)]">
              <Field label="Into">
                <Select value={into} onChange={(e) => setInto(e.target.value)}>
                  <option value="">Top of the project</option>
                  {places.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field
                label="File limit"
                error={limitWrong ? `From 1 to ${UPLOAD_REQUEST_MAX_FILES}` : undefined}
              >
                <Input
                  inputMode="numeric"
                  value={limit}
                  onChange={(e) => setLimit(e.target.value)}
                />
              </Field>
              <Field label="Expires">
                <Input
                  type="date"
                  value={expires}
                  min={dayFromNow(0)}
                  max={dayFromNow(UPLOAD_REQUEST_MAX_DAYS - 1)}
                  onChange={(e) => setExpires(e.target.value)}
                />
              </Field>
            </div>
            <div className="grid gap-4 @md/app:grid-cols-2">
              <Field
                label="Password (optional)"
                error={passwordWrong ? "At least eight characters" : undefined}
              >
                <Input
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </Field>
              <Field label="Email the link to (optional)">
                <Input
                  type="email"
                  autoComplete="off"
                  value={email}
                  placeholder="alex@example.com"
                  onChange={(e) => setEmail(e.target.value)}
                />
              </Field>
            </div>
          </form>
        )}
        {create.error && <p className="m-0 text-[13px] text-signal">{create.error.message}</p>}
        {(made ? [made.request, ...earlier] : earlier).length > 0 && (
          <section className="flex flex-col gap-1">
            <h3 className="eyebrow m-0">Requests in this project</h3>
            <ul className="m-0 list-none p-0">
              {(made ? [made.request, ...earlier] : earlier).map((r) => (
                <RequestRow
                  key={r.id}
                  request={r}
                  projectId={projectId}
                  folderName={folderName(r.folderId)}
                />
              ))}
            </ul>
          </section>
        )}
      </div>
    </Dialog>
  );
}
