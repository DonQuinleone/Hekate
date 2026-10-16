import { z } from "zod";
import { directoryRoleRule } from "./directory.ts";

/**
 * A workspace's single sign-on (#37): one identity provider, by OpenID Connect or SAML 2.0.
 * Members sign in through it, become members on their first sign-in, and take a role from
 * their groups; a workspace can make it the only way in (docs/security.md, Authentication).
 */

export const ssoProtocols = ["oidc", "saml"] as const;
export type SsoProtocol = (typeof ssoProtocols)[number];

const url = z
  .string()
  .trim()
  .max(500)
  .regex(/^https?:\/\/[^\s]+$/, "An http:// or https:// address");
const optionalUrl = z.union([z.literal(""), url]);

export const ssoSettingsInput = z
  .object({
    enabled: z.boolean(),
    protocol: z.enum(ssoProtocols),
    /** OIDC: the issuer, whose discovery document says where everything else is. */
    issuer: optionalUrl,
    clientId: z.string().trim().max(300),
    /** OIDC: left out to keep the one stored; never sent back. */
    clientSecret: z.string().max(500).optional(),
    /** SAML: where the identity provider takes sign-in requests. */
    entryPoint: optionalUrl,
    /** SAML: the identity provider's entity ID. */
    idpEntityId: z.string().trim().max(500),
    /** SAML: the identity provider's signing certificate, in PEM or bare base64. */
    certificate: z.string().trim().max(20_000),
    /** The claim (OIDC) or attribute (SAML) that lists a person's groups. */
    groupsClaim: z.string().trim().min(1).max(100),
    /** Groups that make admins; everyone else is a member, and owners stay owners. */
    roles: z.array(directoryRoleRule).max(50),
    /** Members (not owners) may sign in to this workspace only through it. */
    enforce: z.boolean(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (!input.enabled) return;
    const need = (field: keyof typeof input, message: string) => {
      if (!input[field]) ctx.addIssue({ code: "custom", path: [field], message });
    };
    if (input.protocol === "oidc") {
      need("issuer", "The issuer is needed");
      need("clientId", "The client ID is needed");
    } else {
      need("entryPoint", "The sign-in address is needed");
      need("idpEntityId", "The entity ID is needed");
      need("certificate", "The signing certificate is needed");
    }
  });
export type SsoSettingsInput = z.infer<typeof ssoSettingsInput>;

/** Single sign-on as the settings page shows it: everything but the client secret. */
export type SsoSettings = Omit<SsoSettingsInput, "clientSecret"> & { hasClientSecret: boolean };

/** What an identity provider is told about Hekate: where it sends people back. */
export interface SsoServiceProvider {
  /** OIDC: the redirect URI to register with the provider. */
  redirectUri: string;
  /** SAML: Hekate's entity ID, which is also where its metadata is. */
  entityId: string;
  /** SAML: where the provider posts its response (the ACS). */
  acsUrl: string;
}

export const defaultSsoSettings: SsoSettings = {
  enabled: false,
  protocol: "oidc",
  issuer: "",
  clientId: "",
  hasClientSecret: false,
  entryPoint: "",
  idpEntityId: "",
  certificate: "",
  groupsClaim: "groups",
  roles: [],
  enforce: false,
};

/** Starting a sign-in through a workspace's single sign-on: which workspace. */
export const ssoStartInput = z.object({ workspace: z.string().trim().min(1).max(100) });
