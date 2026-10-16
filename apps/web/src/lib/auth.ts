import { emailOTPClient, twoFactorClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  basePath: "/api/auth",
  // Sign-in reports a second factor is due in its result; the page moves on itself.
  plugins: [emailOTPClient(), twoFactorClient()],
});
