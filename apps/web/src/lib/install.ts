import type { InstallCheck, InstallState } from "@hekate/shared";
import { api } from "./api";
import { json } from "./queries";

/**
 * The setup code from the server's log (decision 061), kept for this tab only: every
 * installer request carries it, and so does creating the first owner.
 */
const key = "hekate-setup-code";
export const setupCode = {
  get(): string | null {
    try {
      return sessionStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(code: string) {
    try {
      sessionStorage.setItem(key, code);
    } catch {
      // Private windows may refuse storage; the code is asked for again after a reload.
    }
  },
  clear() {
    try {
      sessionStorage.removeItem(key);
    } catch {
      // As above.
    }
  },
};

/** The header the server reads the code from. */
export const codeHeaders = (code: string) => ({ headers: { "x-hekate-setup-code": code } });

export type StepResult = { checks: InstallCheck[]; state?: InstallState };

/** Asks the server whether the code is right; throws its refusal when it is not. */
export async function checkCode(code: string) {
  const res = await api.install.code.$post({ json: { code } });
  if (!res.ok) await json(res);
}

export const installState = async (code: string) =>
  json<InstallState>(await api.install.state.$get(undefined, codeHeaders(code)));
