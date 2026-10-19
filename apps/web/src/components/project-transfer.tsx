import { nameMatches, type ProjectTransfer } from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useState } from "react";
import { formatDates } from "~/lib/locale";
import {
  meQuery,
  projectTransferQuery,
  transferDestinationsQuery,
  transfersQuery,
  useSwitchOrganisation,
  useTransferMutations,
} from "~/lib/queries";
import { useIdentityCheck } from "./identity-check";
import { Row, Section } from "./settings";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { Field } from "./ui/field";
import { Input, Select } from "./ui/input";

const dayFormat = formatDates({ day: "numeric", month: "long" });
const day = (iso: string) => dayFormat.format(new Date(iso));

/** What a waiting transfer still needs, in words. */
function waitingFor(t: ProjectTransfer): string {
  const needs = [
    t.approvedAt ? null : `approval by a second member of ${t.from.name}`,
    t.acceptedAt ? null : `acceptance by ${t.to.name}`,
  ].filter(Boolean);
  return needs.length > 0 ? `Waiting for ${needs.join(" and ")}.` : "Moving now.";
}

/** The step a person confirms: the project's name typed, and that it is them. */
export function ConfirmStep({
  title,
  description,
  projectName,
  action,
  pending,
  error,
  onConfirm,
  onClose,
  children,
}: {
  title: string;
  description: string;
  projectName: string;
  action: string;
  pending: boolean;
  error: Error | null;
  onConfirm: (input: { name: string; password?: string }) => void;
  onClose: () => void;
  children?: ReactNode;
}) {
  const [typed, setTyped] = useState("");
  const identity = useIdentityCheck(true, window.location.pathname);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onConfirm({ name: typed, ...identity.proof });
  };
  return (
    <Dialog title={title} description={description} onClose={onClose} width="sm">
      <form onSubmit={submit} className="flex flex-col gap-4">
        {children}
        <Field label={`Type ${projectName} to confirm`}>
          <Input
            value={typed}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setTyped(e.target.value)}
          />
        </Field>
        {identity.fields}
        {error && (
          <p role="alert" className="m-0 text-[12px] text-signal">
            {error.message}
          </p>
        )}
        <span className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Keep it here
          </Button>
          <Button
            type="submit"
            variant="secondary"
            className="text-signal"
            disabled={!nameMatches(typed, projectName) || !identity.ready || pending}
          >
            {action}
          </Button>
        </span>
      </form>
    </Dialog>
  );
}

/**
 * Asking to move a project to another workspace (#240): one of the person's own, or another
 * by its address. Where they are an owner or admin there, it moves as they confirm.
 */
function AskToMove({
  project,
  onClose,
}: {
  project: { id: string; name: string };
  onClose: () => void;
}) {
  const { data: destinations } = useQuery(transferDestinationsQuery(project.id));
  const { data: me } = useQuery(meQuery);
  const { ask } = useTransferMutations();
  const switchTo = useSwitchOrganisation();
  const navigate = useNavigate();
  const [choice, setChoice] = useState<string>("");
  const [address, setAddress] = useState("");
  // Nothing is chosen for the person while their workspaces load, so the choice never changes under them.
  const loading = destinations === undefined;
  const options = destinations ?? [];
  const chosen = choice || options[0]?.id || "address";
  // An address that is one of their own workspaces is that workspace, as the server takes it.
  const typed = address.trim().toLowerCase();
  const ownAddress = me?.organisations.find((o) => o.address === typed)?.id;
  const destination =
    options.find((d) => d.id === (chosen === "address" ? ownAddress : chosen)) ?? null;
  return (
    <ConfirmStep
      title={`Move ${project.name} to another workspace?`}
      description="Its files, comments, reviews and their sign-offs, roles and workflows go with it, its files re-encrypted under that workspace's key. People who are not members there lose their place in it; guests, tags and delivery profiles are matched there or copied."
      projectName={project.name}
      action={destination?.atOnce ? "Move now" : "Ask to move"}
      pending={ask.isPending || loading || switchTo.isPending}
      error={ask.error}
      onClose={onClose}
      onConfirm={(input) =>
        ask.mutate(
          {
            projectId: project.id,
            to: destination ? { id: destination.id } : { address },
            ...input,
          },
          {
            onSuccess: (transfer) => {
              if (transfer?.status !== "moved") return onClose();
              // It is no longer in this workspace: follow it to its new one.
              switchTo.mutate(transfer.to.id, {
                onSuccess: () =>
                  void navigate({ to: "/projects/$projectId", params: { projectId: project.id } }),
              });
            },
          },
        )
      }
    >
      <Field label="Workspace">
        <Select
          value={loading ? "" : chosen}
          disabled={loading}
          onChange={(e) => setChoice(e.target.value)}
        >
          {loading && <option value="">Loading your workspaces…</option>}
          {options.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
          {!loading && <option value="address">Another workspace, by its address</option>}
        </Select>
      </Field>
      {!loading && chosen === "address" && (
        <Field
          label="Its address"
          hint="Its owners and admins find it in their workspace settings, under Transfers."
        >
          <Input
            value={address}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setAddress(e.target.value)}
          />
        </Field>
      )}
      <p className="m-0 text-[13px] text-ink-2">
        {destination?.atOnce
          ? `You are an owner or admin of ${destination.name}, so it moves as soon as you confirm.`
          : "A second member here approves it, and an owner or admin of that workspace accepts it, before anything moves. It lapses after a week."}
      </p>
    </ConfirmStep>
  );
}

/** Approving a transfer out, or accepting one in: confirmed as the asking was. */
function SignOff({
  transfer,
  kind,
  onClose,
}: {
  transfer: ProjectTransfer;
  kind: "approve" | "accept";
  onClose: () => void;
}) {
  const { approve, accept } = useTransferMutations();
  const mutation = kind === "approve" ? approve : accept;
  return (
    <ConfirmStep
      title={
        kind === "approve"
          ? `Approve moving ${transfer.project.name} to ${transfer.to.name}?`
          : `Accept ${transfer.project.name} from ${transfer.from.name}?`
      }
      description={
        kind === "approve"
          ? `Everything in it goes to ${transfer.to.name} once they accept, and members here who are not in that workspace lose their place in it.`
          : "It arrives with its files, comments, reviews and their sign-offs. People already in this workspace keep their place in it; others are left behind."
      }
      projectName={transfer.project.name}
      action={kind === "approve" ? "Approve" : "Accept"}
      pending={mutation.isPending}
      error={mutation.error}
      onClose={onClose}
      onConfirm={(input) => mutation.mutate({ id: transfer.id, ...input }, { onSuccess: onClose })}
    />
  );
}

/** What someone may do about a waiting transfer, as buttons. */
function TransferActions({ transfer }: { transfer: ProjectTransfer }) {
  const { refuse, withdraw } = useTransferMutations();
  const [signing, setSigning] = useState<"approve" | "accept" | null>(null);
  const { you } = transfer;
  return (
    <span className="flex flex-wrap justify-end gap-2">
      {you.mayCancel && (
        <Button
          variant="ghost"
          size="md"
          disabled={withdraw.isPending}
          onClick={() => withdraw.mutate(transfer.id)}
        >
          Withdraw
        </Button>
      )}
      {you.mayRefuse && (
        <Button
          variant="ghost"
          size="md"
          disabled={refuse.isPending}
          onClick={() => refuse.mutate(transfer.id)}
        >
          Refuse
        </Button>
      )}
      {you.mayApprove && (
        <Button variant="secondary" size="md" onClick={() => setSigning("approve")}>
          Approve…
        </Button>
      )}
      {you.mayAccept && (
        <Button variant="secondary" size="md" onClick={() => setSigning("accept")}>
          Accept…
        </Button>
      )}
      {(refuse.error ?? withdraw.error) && (
        <span role="alert" className="basis-full text-right text-[12px] text-signal">
          {(refuse.error ?? withdraw.error)?.message}
        </span>
      )}
      {signing && <SignOff transfer={transfer} kind={signing} onClose={() => setSigning(null)} />}
    </span>
  );
}

/**
 * Moving the project to another workspace, in its danger zone (#240): the transfer waiting on
 * it, or the way to ask for one where the person's role may delete the project.
 */
export function TransferProject({
  project,
  mayMove,
}: {
  project: { id: string; name: string };
  mayMove: boolean;
}) {
  const { data: transfer } = useQuery(projectTransferQuery(project.id));
  const [asking, setAsking] = useState(false);
  if (transfer)
    return (
      <Row
        name={`Moving to ${transfer.to.name}`}
        hint={`${transfer.requestedBy ?? "Someone"} asked on ${day(transfer.requestedAt)}. ${waitingFor(transfer)} It lapses on ${day(transfer.expiresAt)}.`}
      >
        <TransferActions transfer={transfer} />
      </Row>
    );
  if (!mayMove) return null;
  return (
    <>
      <Row
        name="Move to another workspace"
        hint="Everything in it goes, files re-encrypted. Needs a second member here and the other workspace to agree, unless you run both."
      >
        <Button variant="secondary" size="md" onClick={() => setAsking(true)}>
          Move…
        </Button>
      </Row>
      {asking && <AskToMove project={project} onClose={() => setAsking(false)} />}
    </>
  );
}

const statusWords: Record<ProjectTransfer["status"], string> = {
  pending: "Waiting",
  moving: "Moving",
  moved: "Moved",
  cancelled: "Withdrawn",
  refused: "Refused",
  expired: "Lapsed",
};

/**
 * The workspace's transfers (#240): projects asked to move in or out, what each waits for and
 * what the person may do about it, then those already settled. Owners and admins also see the
 * workspace's address, which someone moving a project here gives.
 */
export function TransfersSection() {
  const { data: me } = useQuery(meQuery);
  const { data: transfers } = useQuery(transfersQuery);
  const here = me?.organisations.find((o) => o.id === me.activeOrganisationId);
  const admin = here?.role === "owner" || here?.role === "admin";
  if (!transfers) return null;
  const waiting = transfers.filter((t) => t.status === "pending" || t.status === "moving");
  const settled = transfers.filter((t) => t.status !== "pending" && t.status !== "moving");
  const direction = (t: ProjectTransfer) =>
    t.to.id === me?.activeOrganisationId ? `From ${t.from.name}` : `To ${t.to.name}`;
  return (
    <>
      {admin && here && (
        <Section title="This workspace">
          <Row
            name="Its address"
            hint="Someone moving a project here from a workspace you are not in gives it."
          >
            <code className="tabular text-[14px] text-ink">{here.address}</code>
          </Row>
        </Section>
      )}
      <Section title="Waiting">
        {waiting.length === 0 ? (
          <p className="m-0 px-4 py-3 text-[13px] text-ink-3">
            No project is waiting to move in or out. A project moves from the danger zone of its
            settings.
          </p>
        ) : (
          waiting.map((t) => (
            <Row
              key={t.id}
              name={`${t.project.name}`}
              hint={`${direction(t)}. ${t.requestedBy ?? "Someone"} asked on ${day(t.requestedAt)}. ${waitingFor(t)}`}
            >
              <TransferActions transfer={t} />
            </Row>
          ))
        )}
      </Section>
      {settled.length > 0 && (
        <Section title="Settled">
          {settled.map((t) => (
            <Row
              key={t.id}
              name={t.project.name}
              hint={`${direction(t)}. Asked on ${day(t.requestedAt)}.`}
            >
              <span className="text-[13px] text-ink-2">{statusWords[t.status]}</span>
            </Row>
          ))}
        </Section>
      )}
    </>
  );
}
