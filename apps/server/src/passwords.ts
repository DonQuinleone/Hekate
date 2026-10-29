import { hashPassword } from "better-auth/crypto";
import { isPasswordCompromised } from "better-auth/plugins";
import { HTTPException } from "hono/http-exception";

/**
 * A new account's password, checked against known breaches (where the instance checks) and
 * hashed, for the routes that make an account themselves: setup, sign-up and an invitation
 * accepted with a new account. They run outside Better Auth's own endpoints, where the
 * breach-check plugin's wrapped `ctx.password.hash` cannot be called (it asks for the
 * endpoint it is in), so they use Better Auth's own hasher, as Hekate configures none of its
 * own, and ask about breaches directly. Called before anything is written, so a refusal
 * leaves no account behind.
 */
export async function newAccountPassword(password: string, leakCheck: boolean): Promise<string> {
  if (leakCheck) {
    const compromised = await isPasswordCompromised(password).catch(() => {
      throw new HTTPException(503, {
        message: "The password could not be checked against known breaches. Try again.",
      });
    });
    if (compromised)
      throw new HTTPException(400, {
        message: "That password appears in known data breaches. Choose another one.",
      });
  }
  return hashPassword(password);
}
