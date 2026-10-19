import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useId, useState } from "react";
import { authClient } from "~/lib/auth";
import { deletionQuery } from "~/lib/queries";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

function Note({ error, children }: { error?: boolean; children: string }) {
  return (
    <p
      role={error ? "alert" : "status"}
      className={error ? "m-0 text-[12px] text-signal" : "m-0 text-[12px] text-ink-2"}
    >
      {children}
    </p>
  );
}

/**
 * Proving it is the account's owner at the keyboard, before something grave: deleting the
 * account, or moving a project to another workspace (#240). Their password (or directory
 * password) where they have one; otherwise a sign-in again with their passkey or identity
 * provider, after which they have ten minutes. The server checks it again.
 */
export function useIdentityCheck(open: boolean, returnTo: string) {
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState<{ pending?: boolean; error?: string }>({});
  const id = useId();
  const { data: confirm, refetch } = useQuery({ ...deletionQuery, enabled: open });
  const asksPassword = confirm?.with === "password" || confirm?.with === "directory";
  const signInAgain = async () => {
    setAgain({ pending: true });
    if (confirm?.with === "sign_in" && confirm.providerId) {
      const { data, error } = await authClient.$fetch<{ url: string }>("/sign-in/sso", {
        method: "POST",
        body: {
          providerId: confirm.providerId,
          callbackURL: returnTo,
          errorCallbackURL: returnTo,
        },
      });
      if (data?.url) return window.location.assign(data.url);
      return setAgain({ error: error?.message ?? "That did not go through. Try again." });
    }
    const { error } = await authClient.signIn.passkey();
    if (error) return setAgain({ error: error.message ?? "That did not go through. Try again." });
    setAgain({});
    await refetch();
  };
  const fields: ReactNode = (
    <>
      {asksPassword && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-password`} className="label">
            {confirm.with === "directory" ? "Directory password" : "Password"}
          </label>
          <Input
            id={`${id}-password`}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
      )}
      {confirm?.with === "sign_in" &&
        (confirm.fresh ? (
          <Note>You signed in just now, so that confirms it is you.</Note>
        ) : (
          <div className="flex flex-col items-start gap-2">
            <Note>
              {confirm.providerId
                ? "You sign in through your workspace's identity provider, so there is no password to give. Sign in again to confirm; for ten minutes after, that is enough."
                : "You sign in with a passkey, so there is no password to give. Sign in with it again to confirm; for ten minutes after, that is enough."}
            </Note>
            <Button size="sm" variant="secondary" disabled={again.pending} onClick={signInAgain}>
              {again.pending ? "Signing in" : "Sign in again"}
            </Button>
            {again.error && <Note error>{again.error}</Note>}
          </div>
        ))}
    </>
  );
  return {
    fields,
    /** Whatever the request carries to prove it: the password, where one is asked for. */
    proof: asksPassword ? { password } : {},
    ready: confirm ? (asksPassword ? password !== "" : confirm.fresh) : false,
    reset: () => {
      setPassword("");
      setAgain({});
    },
  };
}
