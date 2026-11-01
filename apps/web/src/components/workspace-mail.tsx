import {
  bounceSecrets,
  isBounceProvider,
  type MailProvider,
  mailProviders,
  type WorkspaceMail,
  workspaceMailProviders,
} from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { cn } from "~/lib/cn";
import { formatDates } from "~/lib/locale";
import { useWorkspaceMail, workspaceMailQuery } from "~/lib/queries";
import { SuppressionsDialog } from "./event-channels";
import { Icon } from "./icons";
import { MailLogNotice } from "./mail-log-notice";
import { Row, Section } from "./settings";
import { Button } from "./ui/button";
import { Dialog, useConfirm } from "./ui/dialog";
import { Field } from "./ui/field";
import { Input, Select } from "./ui/input";
import { ActionMenu } from "./ui/menu";
import { StatusDot } from "./ui/status";

const timeFormat = formatDates({ hour: "2-digit", minute: "2-digit" });

/**
 * Where the workspace's mail is sent from (#591), at the head of the Email page: the instance's
 * or the workspace's own provider, its test and its bounces. Where the instance writes mail to
 * its log, the page says so once, and offers the workspace's own mail as the way to send it.
 */
export function WorkspaceMailSection() {
  const { data: mail, isPending } = useQuery(workspaceMailQuery);
  const [editing, setEditing] = useState(false);
  const [bounced, setBounced] = useState(false);
  return (
    <>
      {!isPending && !mail && <MailLogNotice fix="workspace" />}
      <Section title="Sending">
        <MailRow onEdit={() => setEditing(true)} onBounced={() => setBounced(true)} />
      </Section>
      {editing && <WorkspaceMailDialog saved={mail ?? null} onClose={() => setEditing(false)} />}
      {bounced && <SuppressionsDialog scope="workspace" onClose={() => setBounced(false)} />}
    </>
  );
}

/**
 * The workspace's mail (#161): the instance's until an admin gives the workspace its own, which
 * then sends what members, guests and invitations are sent. It is not a channel: members choose
 * what reaches them by mail.
 */
function MailRow({ onEdit, onBounced }: { onEdit: () => void; onBounced: () => void }) {
  const { data: mail, isPending } = useQuery(workspaceMailQuery);
  const [confirm, confirmation] = useConfirm();
  const { remove, resume, test } = useWorkspaceMail();
  if (isPending) return null;
  const outcome = test.data ?? (test.error ? { ok: false, result: test.error.message } : null);
  const hint = outcome ? (
    <span role="status" className={cn(!outcome.ok && "text-signal")}>
      {outcome.result}
    </span>
  ) : !mail ? (
    "Through the instance's mail. Give the workspace its own, and members, guests and invitations are sent from it."
  ) : mail.pausedUntil ? (
    `${mail.target} · paused after ${mail.failures} failures, until ${timeFormat.format(new Date(mail.pausedUntil))}; the instance's mail sends meanwhile`
  ) : mail.failures > 0 ? (
    `${mail.target} · ${mail.failures} failed in a row${mail.lastError ? `: ${mail.lastError}` : ""}`
  ) : (
    `${mail.target} · from ${mail.from}${mail.suppressed > 0 ? ` · ${mail.suppressed} not sent to after a bounce` : ""}`
  );
  return (
    <Row
      name={
        <span className="flex items-center gap-2.5">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-control bg-raised text-ink-2">
            <Icon name="mail" size={16} />
          </span>
          <span className="truncate">{mail ? mailProviders[mail.provider].label : "Mail"}</span>
          {mail && <StatusDot state={mail.pausedUntil ? "changes_requested" : "approved"} />}
          {mail && <span className="sr-only">{mail.pausedUntil ? "Paused" : "On"}</span>}
        </span>
      }
      hint={hint}
    >
      <span className="hidden text-[12px] text-ink-3 @3xl/app:inline">As each member chooses</span>
      <div className="flex items-center gap-1">
        {!mail ? (
          <Button variant="secondary" size="md" onClick={onEdit}>
            Use the workspace's own
          </Button>
        ) : mail.pausedUntil ? (
          <Button
            variant="secondary"
            size="md"
            disabled={resume.isPending}
            onClick={() => resume.mutate()}
          >
            Resume
          </Button>
        ) : (
          <Button
            variant="secondary"
            size="md"
            disabled={test.isPending}
            onClick={() => test.mutate()}
          >
            {test.isPending ? "Testing…" : "Test"}
          </Button>
        )}
        {mail && (
          <ActionMenu
            always
            label="Mail"
            actions={[
              { label: "Edit…", onSelect: onEdit },
              ...(mail.bounceUrl ? [{ label: "Bounced addresses…", onSelect: onBounced }] : []),
              "divider",
              {
                label: "Back to the instance's mail…",
                danger: true,
                onSelect: () =>
                  confirm({
                    title: "Go back to the instance's mail?",
                    description:
                      "The workspace's own mail settings are removed, and its mail is sent through the instance's again.",
                    action: "Remove the workspace's mail",
                    onConfirm: () => remove.mutateAsync(),
                  }),
              },
            ]}
          />
        )}
      </div>
      {confirmation}
    </Row>
  );
}

function WorkspaceMailDialog({
  saved,
  onClose,
}: {
  saved: WorkspaceMail | null;
  onClose: () => void;
}) {
  const { save } = useWorkspaceMail();
  const [mail, setMail] = useState({
    provider: saved?.provider ?? ("resend" as MailProvider),
    host: saved?.host ?? "",
    port: String(saved?.port ?? mailProviders[saved?.provider ?? "resend"].port ?? 587),
    username: saved?.username ?? "",
    password: "",
    webhookSecret: "",
    tenant: saved?.tenant ?? "",
    clientId: saved?.clientId ?? "",
    url: saved?.url ?? "",
    from: saved?.from ?? "",
  });
  const preset = mailProviders[mail.provider];
  const smtp = preset.transport === "smtp";
  // A secret already stored is kept unless another is typed, for the same provider.
  const keeps = Boolean(saved?.hasSecret && saved.provider === mail.provider);
  const keepsWebhook = Boolean(saved?.hasWebhookSecret && saved.provider === mail.provider);
  const set = (name: keyof typeof mail) => (e: { target: { value: string } }) =>
    setMail({ ...mail, [name]: e.target.value });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate(
      {
        provider: mail.provider,
        from: mail.from,
        ...(smtp && !preset.host && mail.host ? { host: mail.host } : {}),
        ...(smtp && mail.port ? { port: Number(mail.port) } : {}),
        ...(smtp && !preset.username && mail.username ? { username: mail.username } : {}),
        ...(mail.password ? { password: mail.password } : {}),
        ...(mail.webhookSecret ? { webhookSecret: mail.webhookSecret } : {}),
        ...(preset.transport === "microsoft"
          ? { tenant: mail.tenant, clientId: mail.clientId }
          : {}),
        ...(preset.transport === "mailcoach" ? { url: mail.url } : {}),
      },
      { onSuccess: onClose },
    );
  };
  const secret = (
    <Field
      label={preset.secret ?? "Password"}
      hint={keeps ? "Empty keeps the one saved." : undefined}
    >
      <Input
        type="password"
        value={mail.password}
        onChange={set("password")}
        autoComplete="off"
        required={!keeps && (preset.transport !== "smtp" || preset.username !== null)}
      />
    </Field>
  );
  return (
    <Dialog
      title="The workspace's own mail"
      description="Members, guests and invitations are sent through it. Should it keep failing, the instance's mail sends instead until it is put right."
      onClose={onClose}
      width="sm"
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Provider">
          <Select
            value={mail.provider}
            onChange={(e) => {
              const provider = e.target.value as MailProvider;
              setMail({ ...mail, provider, port: String(mailProviders[provider].port ?? "") });
            }}
          >
            {workspaceMailProviders.map((id) => (
              <option key={id} value={id}>
                {mailProviders[id].label}
              </option>
            ))}
          </Select>
        </Field>
        {preset.transport === "microsoft" ? (
          <>
            <Field label="Directory (tenant) ID">
              <Input value={mail.tenant} onChange={set("tenant")} required />
            </Field>
            <Field label="Application (client) ID" hint="An app registration granted Mail.Send.">
              <Input value={mail.clientId} onChange={set("clientId")} required />
            </Field>
            {secret}
          </>
        ) : preset.transport === "mailcoach" ? (
          <>
            <Field label="Address">
              <Input
                value={mail.url}
                onChange={set("url")}
                placeholder="https://endlesshall.mailcoach.app"
                required
              />
            </Field>
            {secret}
          </>
        ) : (
          <>
            {!preset.host && (
              <div className="grid grid-cols-[minmax(0,1fr)_96px] gap-3">
                <Field label="Host">
                  <Input
                    value={mail.host}
                    onChange={set("host")}
                    placeholder={
                      mail.provider === "ses"
                        ? "email-smtp.eu-west-1.amazonaws.com"
                        : "smtp.example.com"
                    }
                    required
                  />
                </Field>
                <Field label="Port">
                  <Input value={mail.port} onChange={set("port")} inputMode="numeric" />
                </Field>
              </div>
            )}
            {!preset.username && (
              <Field label="Username">
                <Input value={mail.username} onChange={set("username")} autoComplete="off" />
              </Field>
            )}
            {secret}
          </>
        )}
        {isBounceProvider(mail.provider) && (
          <Field
            label={bounceSecrets[mail.provider].label}
            hint={
              keepsWebhook
                ? "Empty keeps the one saved."
                : `For bounce reports, so mail stops going to addresses that bounce. ${bounceSecrets[mail.provider].hint}`
            }
          >
            <Input
              type="password"
              value={mail.webhookSecret}
              onChange={set("webhookSecret")}
              autoComplete="off"
            />
          </Field>
        )}
        {isBounceProvider(mail.provider) &&
          saved?.bounceUrl &&
          saved.provider === mail.provider && (
            <Field label="Bounce reports go to" hint="Paste this into the provider's webhook.">
              <Input value={saved.bounceUrl} readOnly onFocus={(e) => e.target.select()} />
            </Field>
          )}
        <Field label="From" hint="An address the provider lets the workspace send as.">
          <Input
            value={mail.from}
            onChange={set("from")}
            placeholder="Endless Hall Records <mail@endlesshall.example>"
            required
          />
        </Field>
        {save.error && <p className="m-0 text-[13px] text-signal">{save.error.message}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={save.isPending}>
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
