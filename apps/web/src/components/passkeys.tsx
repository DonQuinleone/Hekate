import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, type ReactNode, useState } from "react";
import { authClient } from "~/lib/auth";
import { ago } from "~/lib/comments";
import { passkeysQuery } from "~/lib/queries";
import { Icon } from "./icons";
import type { SetupStep } from "./second-factor";
import { Row, Section } from "./settings";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { Input } from "./ui/input";
import { ActionMenu } from "./ui/menu";

/**
 * Passkeys and hardware security keys (WebAuthn): they sign in on their own, and confirm a
 * password sign-in where a workspace asks for a second factor or a hardware security key.
 */

/** What went wrong with a key, in words: the browser's refusal, or the server's. */
export function keyProblem(error: { message?: string; status?: number } | null | undefined) {
  if (!error) return null;
  if (error.status === 403 && error.message) return error.message;
  return /cancel|not allowed|abort|timed out/i.test(error.message ?? "")
    ? "Nothing was added: the browser was cancelled, or the key took too long."
    : (error.message ?? "That did not go through. Try again.");
}

function Problem({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="m-0 flex items-center gap-2 text-[13px] text-ink">
      <span aria-hidden="true" className="size-[7px] rounded-full bg-signal" />
      {children}
    </p>
  );
}

/** Add a key: a name to know it by, then the browser asks for the touch or the unlock. */
export function AddPasskey({
  shell,
  onAdded,
  onCancel,
  reason,
  page = false,
}: {
  shell: (step: SetupStep) => ReactNode;
  onAdded: () => void;
  onCancel?: () => void;
  reason?: string;
  page?: boolean;
}) {
  const client = useQueryClient();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    const result = await authClient.passkey.addPasskey({ name: name.trim() || undefined });
    setPending(false);
    if (result?.error) {
      setError(keyProblem(result.error));
      return;
    }
    await client.invalidateQueries({ queryKey: ["me"] });
    onAdded();
  };
  const add = (
    <Button
      variant="primary"
      size={page ? "lg" : "md"}
      type="submit"
      disabled={pending}
      className={page ? undefined : "shrink-0"}
    >
      {pending ? "Waiting for the key" : "Add"}
    </Button>
  );
  return shell({
    title: "Add a passkey or hardware security key",
    intro: `${reason ? `${reason} ` : ""}Your browser asks you to touch the key (a YubiKey, or any FIDO2 key), or to unlock this device. A name helps you tell your keys apart.`,
    body: (
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="passkey-name" className="label">
            Name
          </label>
          <Input
            id="passkey-name"
            autoFocus
            placeholder="Work laptop, or YubiKey"
            maxLength={60}
            className="h-10"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        {error && <Problem>{error}</Problem>}
        {page ? (
          add
        ) : (
          <span className="flex justify-end gap-2">
            {onCancel && (
              <Button variant="ghost" onClick={onCancel}>
                Cancel
              </Button>
            )}
            {add}
          </span>
        )}
      </form>
    ),
  });
}

/** Sign in with a key; on success what the app knows of you is fetched again. */
export function usePasskeySignIn() {
  const client = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const signIn = async () => {
    setPending(true);
    setError(null);
    const result = await authClient.signIn.passkey();
    setPending(false);
    if (result?.error) {
      setError(keyProblem(result.error));
      return false;
    }
    await client.invalidateQueries();
    return true;
  };
  return { signIn, error, pending };
}

const kindOf = (deviceType: string) =>
  deviceType === "singleDevice" ? "Hardware security key" : "Passkey";

/** The account's keys: each named, when last used, renamed or revoked; up to the limit. */
export function PasskeysSection() {
  const client = useQueryClient();
  const { data } = useQuery(passkeysQuery);
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const keys = data?.passkeys ?? [];
  const full = data ? keys.length >= data.max : false;
  const refresh = () => client.invalidateQueries({ queryKey: ["me"] });
  return (
    <Section
      title="Passkeys and hardware security keys"
      intro={`Up to ${data?.max ?? 5}. A passkey signs you in without a password; a hardware security key, such as a YubiKey, can be required by a workspace.`}
      action={
        <Button size="sm" variant="secondary" disabled={full} onClick={() => setAdding(true)}>
          <Icon name="plus" size={14} />
          Add
        </Button>
      }
    >
      {keys.length === 0 && <Row name="None yet" hint="Add one to sign in with a touch." />}
      {keys.map((key) => (
        <Row
          key={key.id}
          name={
            <span className="flex items-center gap-2">
              <Icon name="key" size={14} className="text-ink-3" />
              {key.name || kindOf(key.deviceType)}
            </span>
          }
          hint={`${kindOf(key.deviceType)} · ${key.lastUsedAt ? `last used ${ago(key.lastUsedAt)}` : `added ${ago(key.createdAt)}`}`}
        >
          <ActionMenu
            always
            label={key.name || kindOf(key.deviceType)}
            actions={[
              {
                label: "Rename",
                onSelect: () => setRenaming({ id: key.id, name: key.name ?? "" }),
              },
              "divider",
              {
                label: "Revoke",
                danger: true,
                onSelect: async () => {
                  const result = await authClient.passkey.deletePasskey({ id: key.id });
                  setError(result?.error ? keyProblem(result.error) : null);
                  await refresh();
                },
              },
            ]}
          />
        </Row>
      ))}
      {full && <Row name="Limit reached" hint="Revoke a key to add another." />}
      {error && (
        <div className="px-4 py-2">
          <Problem>{error}</Problem>
        </div>
      )}
      {adding && (
        <AddPasskey
          onCancel={() => setAdding(false)}
          onAdded={() => setAdding(false)}
          shell={({ title, intro, body }) => (
            <Dialog title={title} description={intro} onClose={() => setAdding(false)} width="sm">
              {body}
            </Dialog>
          )}
        />
      )}
      {renaming && (
        <Dialog title="Rename the key" onClose={() => setRenaming(null)} width="sm">
          <form
            className="flex flex-col gap-4"
            onSubmit={async (event) => {
              event.preventDefault();
              const result = await authClient.passkey.updatePasskey({
                id: renaming.id,
                name: renaming.name.trim(),
              });
              setError(result?.error ? keyProblem(result.error) : null);
              setRenaming(null);
              await refresh();
            }}
          >
            <Input
              aria-label="Name"
              autoFocus
              maxLength={60}
              value={renaming.name}
              onChange={(e) => setRenaming({ ...renaming, name: e.target.value })}
            />
            <span className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setRenaming(null)}>
                Cancel
              </Button>
              <Button variant="primary" type="submit" disabled={!renaming.name.trim()}>
                Rename
              </Button>
            </span>
          </form>
        </Dialog>
      )}
    </Section>
  );
}
