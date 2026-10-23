import {
  formatBytes,
  WORKSPACE_DELETE_GRACE_DAYS,
  WORKSPACE_EXPORT_DAYS,
  type WorkspaceDeletion,
  type WorkspaceExport,
  type WorkspaceExportStarted,
} from "@hekate/shared";
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { Icon } from "~/components/icons";
import { Row } from "~/components/settings";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/choice";
import { Dialog } from "~/components/ui/dialog";
import { Field } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { api } from "~/lib/api";
import { formatDates } from "~/lib/locale";
import { json } from "~/lib/queries";

/**
 * Exporting and deleting a workspace (#186): its owners' side in Settings, General, and the
 * operators' on the instance's Keys tab. An export is everything the workspace holds, in one
 * archive encrypted to a key shown once; deleting it takes two owners, then a grace period.
 */

const dayFormat = formatDates({ day: "numeric", month: "long" });
const momentFormat = formatDates({
  day: "numeric",
  month: "long",
  hour: "2-digit",
  minute: "2-digit",
});

/** Whose exports: the signed-in owner's workspace, or one an operator looks at. */
export type ExportScope = { kind: "workspace" } | { kind: "instance"; id: string };

const exportsKey = (scope: ExportScope) =>
  scope.kind === "workspace" ? ["organisation", "exports"] : ["instance", "exports", scope.id];

export const workspaceExportsQuery = (scope: ExportScope) =>
  queryOptions({
    queryKey: exportsKey(scope),
    queryFn: async () =>
      (
        await json<{ exports: WorkspaceExport[] }>(
          scope.kind === "workspace"
            ? await api.organisation.exports.$get()
            : await api.instance.workspaces[":id"].exports.$get({ param: { id: scope.id } }),
        )
      ).exports,
    // While one is being made, its list is asked again until it is ready.
    refetchInterval: (query) =>
      query.state.data?.some((e) => e.status === "queued" || e.status === "building")
        ? 5_000
        : false,
  });

function useExports(scope: ExportScope) {
  const client = useQueryClient();
  return {
    start: useMutation({
      mutationFn: async (recipient: string | null) => {
        const body = recipient ? { recipient } : {};
        return json<WorkspaceExportStarted>(
          scope.kind === "workspace"
            ? await api.organisation.exports.$post({ json: body })
            : await api.instance.workspaces[":id"].exports.$post({
                param: { id: scope.id },
                json: body,
              }),
        );
      },
      onSuccess: () => client.invalidateQueries({ queryKey: exportsKey(scope) }),
    }),
    download: useMutation({
      mutationFn: async (exportId: string) =>
        json<{ url: string }>(
          scope.kind === "workspace"
            ? await api.organisation.exports[":id"].download.$post({ param: { id: exportId } })
            : await api.instance.workspaces[":id"].exports[":exportId"].download.$post({
                param: { id: scope.id, exportId },
              }),
        ),
      // The link works once, in this session, for five minutes: it is followed at once.
      onSuccess: ({ url }) => window.location.assign(url),
    }),
  };
}

const statusWords = (e: WorkspaceExport): string => {
  switch (e.status) {
    case "queued":
    case "building":
      return "Being made";
    case "ready":
      return [
        e.byteSize === null ? null : formatBytes(e.byteSize),
        e.fileCount === null ? null : `${e.fileCount} ${e.fileCount === 1 ? "file" : "files"}`,
        e.expiresAt ? `until ${dayFormat.format(new Date(e.expiresAt))}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
    case "failed":
      return e.error ?? "It could not be made";
    case "expired":
      return "Removed after its week";
  }
};

/**
 * Starting an export, and its exports: the latest few, each downloadable while ready. As rows
 * of a settings section, so it sits in General for owners and in Keys for operators.
 */
export function WorkspaceExports({ scope, name }: { scope: ExportScope; name: string }) {
  const { data: exports } = useQuery(workspaceExportsQuery(scope));
  const { start, download } = useExports(scope);
  const [asking, setAsking] = useState(false);
  const making = exports?.some((e) => e.status === "queued" || e.status === "building") ?? false;
  return (
    <>
      <Row
        name="Export everything"
        hint={`Every record as JSON and every file as it was uploaded, in one archive encrypted with age. Kept ${WORKSPACE_EXPORT_DAYS} days for its download.`}
      >
        <Button variant="secondary" size="md" disabled={making} onClick={() => setAsking(true)}>
          {making ? "Being made…" : "Start an export…"}
        </Button>
      </Row>
      {exports?.slice(0, 5).map((e) => (
        <Row
          key={e.id}
          name={`${momentFormat.format(new Date(e.createdAt))}${e.byOperator ? " · by an operator" : ""}`}
          hint={statusWords(e)}
        >
          {e.status === "ready" && (
            <Button
              variant="ghost"
              size="md"
              disabled={download.isPending}
              onClick={() => download.mutate(e.id)}
            >
              <Icon name="download" size={13} />
              Download
            </Button>
          )}
        </Row>
      ))}
      {download.error && (
        <p role="alert" className="m-0 px-4 py-3 text-[13px] text-signal">
          {download.error.message}
        </p>
      )}
      {asking && (
        <StartExport
          name={name}
          pending={start.isPending}
          error={start.error?.message ?? null}
          onStart={(recipient) => start.mutateAsync(recipient)}
          onClose={() => {
            start.reset();
            setAsking(false);
          }}
        />
      )}
    </>
  );
}

/** Asks for an export, then shows its key once, until whoever asked says it is kept. */
function StartExport({
  name,
  pending,
  error,
  onStart,
  onClose,
}: {
  name: string;
  pending: boolean;
  error: string | null;
  onStart: (recipient: string | null) => Promise<WorkspaceExportStarted>;
  onClose: () => void;
}) {
  const [own, setOwn] = useState("");
  const [key, setKey] = useState<string | null>(null);
  const [kept, setKept] = useState(false);
  if (key)
    return (
      <Dialog
        title="Keep this key"
        description="It opens the archive, and it is shown only now: Hekate keeps no copy, so without it the archive cannot be opened. Store it where you keep passwords."
        onClose={() => kept && onClose()}
        width="sm"
        footer={
          <>
            <Button
              variant="secondary"
              size="md"
              onClick={() => void navigator.clipboard?.writeText(key)}
            >
              <Icon name="copy" size={13} />
              Copy the key
            </Button>
            <Button variant="primary" size="md" disabled={!kept} onClick={onClose}>
              Done
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label="Secret key" hint="Open the archive with age -d -i key.txt.">
            <Input
              value={key}
              readOnly
              className="font-mono text-[12px]"
              onFocus={(e) => e.currentTarget.select()}
            />
          </Field>
          <label className="flex items-center gap-2.5 text-[13px] text-ink-2">
            <Checkbox checked={kept} onChange={(e) => setKept(e.target.checked)} />I have stored the
            key somewhere safe
          </label>
        </div>
      </Dialog>
    );
  return (
    <Dialog
      title={`Export ${name}`}
      description="Everything it holds: every record as JSON, and every file, attachment and caption as it was uploaded, without watermarks. It is made in the background and kept for a week; the download is logged."
      onClose={onClose}
      width="sm"
      footer={
        <>
          <Button variant="ghost" size="md" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="md" type="submit" form="start-export" disabled={pending}>
            Start the export
          </Button>
        </>
      }
    >
      <form
        id="start-export"
        className="flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          const started = await onStart(own.trim() || null).catch(() => null);
          if (!started) return;
          if (started.key) setKey(started.key);
          else onClose();
        }}
      >
        <Field
          label="Your own age key (optional)"
          hint="Leave it empty and a key is made for this export and shown once."
          error={error}
        >
          <Input
            value={own}
            onChange={(e) => setOwn(e.target.value)}
            placeholder="age1…"
            autoComplete="off"
            spellCheck={false}
            className="font-mono text-[12px]"
          />
        </Field>
      </form>
    </Dialog>
  );
}

const deletionKey = ["organisation", "deletion"];

export const workspaceDeletionQuery = queryOptions({
  queryKey: deletionKey,
  queryFn: async () =>
    (await json<{ deletion: WorkspaceDeletion | null }>(await api.organisation.deletion.$get()))
      .deletion,
});

export function useWorkspaceDeletion() {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: deletionKey });
  return {
    request: useMutation({
      mutationFn: async () => json(await api.organisation.deletion.$post()),
      onSuccess: refresh,
    }),
    // Kept: the workspace opens again, so everything is read afresh.
    cancel: useMutation({
      mutationFn: async () => json(await api.organisation.deletion.$delete()),
      onSuccess: () => void client.invalidateQueries(),
    }),
    // Confirmed: it is suspended now, and every page says so.
    confirm: useMutation({
      mutationFn: async (name: string) =>
        json(await api.organisation.deletion.confirm.$post({ json: { name } })),
      onSuccess: () => void client.invalidateQueries(),
    }),
  };
}

/**
 * Deleting the workspace, in its owners' danger zone: one owner asks, another confirms by
 * typing its name (a sole owner, a day later). It is then suspended, and goes for good after
 * the grace period unless an owner keeps it.
 */
export function DeleteWorkspace({ name }: { name: string }) {
  const { data: deletion } = useQuery(workspaceDeletionQuery);
  const { request, cancel, confirm } = useWorkspaceDeletion();
  const [dialog, setDialog] = useState<"ask" | "confirm" | null>(null);
  const [typed, setTyped] = useState("");
  const close = () => {
    setDialog(null);
    setTyped("");
    confirm.reset();
  };
  const error = request.error ?? cancel.error;
  let row: ReactNode;
  if (deletion) {
    const status = deletion.mayConfirm
      ? "Confirm it to delete the workspace."
      : deletion.confirmableAt
        ? `As the only owner, you can confirm it from ${momentFormat.format(new Date(deletion.confirmableAt))}.`
        : "Waiting for another owner to confirm.";
    row = (
      <Row
        name="Deletion asked for"
        hint={`${deletion.requestedBy ?? "Someone"} asked on ${momentFormat.format(new Date(deletion.requestedAt))}. ${status}`}
      >
        <span className="flex gap-2">
          <Button
            variant="ghost"
            size="md"
            disabled={cancel.isPending}
            onClick={() => cancel.mutate()}
          >
            Withdraw
          </Button>
          {deletion.mayConfirm && (
            <Button
              variant="secondary"
              size="md"
              className="text-signal"
              onClick={() => setDialog("confirm")}
            >
              Delete…
            </Button>
          )}
        </span>
      </Row>
    );
  } else {
    row = (
      <Row
        name="Delete this workspace"
        hint="Every project, file and review. Only an owner, with a second owner confirming."
      >
        <Button
          variant="secondary"
          size="md"
          className="text-signal"
          onClick={() => setDialog("ask")}
        >
          Delete…
        </Button>
      </Row>
    );
  }
  return (
    <>
      {row}
      {error && (
        <p role="alert" className="m-0 px-4 pb-3 text-[13px] text-signal">
          {error.message}
        </p>
      )}
      {dialog === "ask" && (
        <Dialog
          title={`Delete ${name}?`}
          description="Another owner confirms before anything happens; a workspace with one owner confirms a day later. It is then closed to everyone, and everything in it is removed after the grace period. Export it first to keep a copy."
          onClose={close}
          width="sm"
          footer={
            <>
              <Button variant="ghost" size="md" onClick={close}>
                Keep it
              </Button>
              <Button
                variant="primary"
                size="md"
                disabled={request.isPending}
                onClick={() => request.mutate(undefined, { onSuccess: close })}
              >
                Ask to delete
              </Button>
            </>
          }
        >
          {request.error && <p className="text-[13px] text-signal">{request.error.message}</p>}
        </Dialog>
      )}
      {dialog === "confirm" && (
        <Dialog
          title={`Delete ${name}?`}
          description={`It closes now for every member and guest, and in ${WORKSPACE_DELETE_GRACE_DAYS} days its members, projects, files, reviews, keys and access log are removed. Until then an owner can keep it, or export it. Type its name to confirm.`}
          onClose={close}
          width="sm"
          footer={
            <>
              <Button variant="ghost" size="md" onClick={close}>
                Keep it
              </Button>
              <Button
                variant="primary"
                size="md"
                disabled={confirm.isPending || typed.trim() !== name}
                onClick={() => confirm.mutate(typed, { onSuccess: close })}
              >
                Delete in {WORKSPACE_DELETE_GRACE_DAYS} days
              </Button>
            </>
          }
        >
          <Field label={`Type ${name} to confirm`} error={confirm.error?.message}>
            <Input
              value={typed}
              autoComplete="off"
              autoFocus
              onChange={(e) => setTyped(e.target.value)}
            />
          </Field>
        </Dialog>
      )}
    </>
  );
}

/**
 * A workspace its owners are deleting, for its owners on the page members see instead of it:
 * keeping it, which opens it again, and exporting it meanwhile, its latest archive downloadable.
 */
export function BeingDeleted({ name }: { name: string }) {
  const scope: ExportScope = { kind: "workspace" };
  const { cancel } = useWorkspaceDeletion();
  // Kept, it is open again: back into it.
  const navigate = useNavigate();
  const { data: exports } = useQuery(workspaceExportsQuery(scope));
  const { start, download } = useExports(scope);
  const [asking, setAsking] = useState(false);
  const latest = exports?.[0];
  const making = latest?.status === "queued" || latest?.status === "building";
  const error = cancel.error ?? download.error;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          size="lg"
          disabled={cancel.isPending}
          onClick={() => cancel.mutate(undefined, { onSuccess: () => void navigate({ to: "/" }) })}
        >
          Keep it
        </Button>
        {latest?.status === "ready" ? (
          <Button
            variant="secondary"
            size="lg"
            disabled={download.isPending}
            onClick={() => download.mutate(latest.id)}
          >
            <Icon name="download" size={14} />
            Download the export
          </Button>
        ) : (
          <Button variant="secondary" size="lg" disabled={making} onClick={() => setAsking(true)}>
            {making ? "Export being made…" : "Export everything…"}
          </Button>
        )}
      </div>
      {latest && <p className="m-0 text-[13px] text-ink-3">{statusWords(latest)}</p>}
      {error && (
        <p role="alert" className="m-0 text-[13px] text-signal">
          {error.message}
        </p>
      )}
      {asking && (
        <StartExport
          name={name}
          pending={start.isPending}
          error={start.error?.message ?? null}
          onStart={(recipient) => start.mutateAsync(recipient)}
          onClose={() => {
            start.reset();
            setAsking(false);
          }}
        />
      )}
    </div>
  );
}
