import { lookup as dnsLookup } from "node:dns";
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { type Database, inOrg, schema } from "@hekate/db";
import {
  defaultSsoSettings,
  roleForGroups,
  type SsoServiceProvider,
  type SsoSettings,
  type SsoSettingsInput,
} from "@hekate/shared";
import { eq } from "drizzle-orm";
import type { Audit } from "./audit.ts";
import { memberRoom } from "./usage.ts";

const { authAccounts, members, ssoProviders } = schema;

/**
 * A workspace's single sign-on (#37), on Better Auth's SSO plugin. Hekate keeps the settings an
 * admin sees and writes the configuration the plugin reads (`oidcConfig`, `samlConfig`); people
 * are found by workspace, never by the domain of their address, and an account that exists
 * already is never taken over (see auth.ts and docs/security.md).
 */

/** The provider's name in sign-in and callback addresses. */
export const providerIdFor = (organisationId: string) => `workspace-${organisationId}`;

/** What the identity provider is told: where people come back to. */
export function serviceProvider(baseURL: string, organisationId: string): SsoServiceProvider {
  const base = `${baseURL.replace(/\/$/, "")}/api/auth`;
  const providerId = providerIdFor(organisationId);
  return {
    redirectUri: `${base}/sso/callback/${providerId}`,
    entityId: `${base}/sso/saml2/sp/metadata?providerId=${providerId}`,
    acsUrl: `${base}/sso/saml2/sp/acs/${providerId}`,
  };
}

export async function ssoOf(db: Database, organisationId: string): Promise<SsoSettings> {
  const [row] = await db.select().from(ssoProviders).where(inOrg(ssoProviders, organisationId));
  if (!row) return defaultSsoSettings;
  const oidc = row.oidcConfig ? (JSON.parse(row.oidcConfig) as { clientSecret?: string }) : null;
  return {
    enabled: row.enabled,
    protocol: row.protocol,
    issuer: row.protocol === "oidc" ? row.issuer : "",
    clientId: row.clientId,
    hasClientSecret: Boolean(oidc?.clientSecret),
    entryPoint: row.entryPoint,
    idpEntityId: row.protocol === "saml" ? row.issuer : "",
    certificate: row.certificate,
    groupsClaim: row.groupsClaim,
    roles: row.roles,
    enforce: row.enforce,
  };
}

/** A problem with what an admin entered, in words for them. */
export class SsoProblem extends Error {}

/**
 * Every address range that is not the public internet (RFC 6890 and its successors): private,
 * shared, loopback, link-local, documentation, benchmarking, multicast and reserved, and the
 * IPv6 ranges that can carry an IPv4 address inside them (mapped, NAT64, 6to4, Teredo).
 */
// Two lists: one list would match every IPv4 address against the IPv4-mapped IPv6 range.
const reserved4 = new BlockList();
const reserved6 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  reserved4.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const)
  reserved6.addSubnet(network, prefix, "ipv6");

/** Whether an address is anywhere but the public internet, which an identity provider is. */
export function privateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  return family === 4 ? reserved4.check(address, "ipv4") : reserved6.check(address, "ipv6");
}

/**
 * Whether the server may fetch from this address: a public host, or an origin the operator
 * trusts (`SSO_TRUSTED_ORIGINS`, for an identity provider on a private network). Without it an
 * admin could point the server at anything inside the network it runs in.
 */
export async function mayFetch(url: string, trusted: string[]): Promise<boolean> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  if (trusted.includes(parsed.origin)) return true;
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal"))
    return false;
  if (isIP(host)) return !privateAddress(host);
  const addresses = await lookup(host, { all: true }).catch(() => []);
  return addresses.length > 0 && addresses.every((a) => !privateAddress(a.address));
}

/**
 * A lookup that answers only with public addresses, so the address checked is the address
 * connected to: a name that resolves somewhere public for the check and somewhere private for
 * the request (DNS rebinding) is refused at the connection itself.
 */
export const publicLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, "", 0);
    if (addresses.length === 0 || addresses.some((a) => privateAddress(a.address))) {
      const refused = Object.assign(new Error(`${hostname} is on a private network`), {
        code: "EPRIVATE",
      });
      return callback(refused, "", 0);
    }
    if (options.all) return callback(null, addresses);
    const [first] = addresses;
    callback(null, first?.address ?? "", first?.family ?? 4);
  });
};

/**
 * Reads a JSON document from an identity provider: no redirects, ten seconds, a megabyte at
 * most, and connected only to a public address unless the operator trusts the origin.
 */
export function fetchJson(
  url: string,
  trusted: string[],
): Promise<{ status: number; body: unknown }> {
  const target = new URL(url);
  const request = target.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = request(
      target,
      {
        method: "GET",
        headers: { accept: "application/json" },
        timeout: 10_000,
        ...(trusted.includes(target.origin) ? {} : { lookup: publicLookup }),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 1_000_000) req.destroy(new Error("The document is too large"));
          else chunks.push(chunk);
        });
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let body: unknown = null;
          try {
            body = JSON.parse(text);
          } catch {
            body = null;
          }
          resolve({ status: res.statusCode ?? 0, body });
        });
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("Timed out")));
    req.on("error", reject);
    req.end();
  });
}

interface Discovered {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
  token_endpoint_auth_methods_supported?: string[];
}

/** Reads an OIDC issuer's discovery document, once, when the settings are saved. */
export async function discover(issuer: string, trusted: string[]): Promise<Discovered> {
  const address = `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
  if (!(await mayFetch(address, trusted)))
    throw new SsoProblem(
      "That issuer is on a private network. The operator can allow it with SSO_TRUSTED_ORIGINS.",
    );
  const res = await fetchJson(address, trusted).catch((error: { code?: string }) => {
    throw new SsoProblem(
      error.code === "EPRIVATE"
        ? "That issuer is on a private network. The operator can allow it with SSO_TRUSTED_ORIGINS."
        : "The issuer could not be reached.",
    );
  });
  if (res.status < 200 || res.status >= 300)
    throw new SsoProblem(`The issuer answered ${res.status} for its discovery document.`);
  const doc = res.body as Partial<Discovered> | null;
  if (
    !doc?.authorization_endpoint ||
    !doc.token_endpoint ||
    !doc.jwks_uri ||
    doc.issuer?.replace(/\/$/, "") !== issuer.replace(/\/$/, "")
  )
    throw new SsoProblem("The issuer's discovery document is not one Hekate can use.");
  for (const endpoint of [doc.token_endpoint, doc.jwks_uri, doc.userinfo_endpoint]) {
    if (endpoint && !(await mayFetch(endpoint, trusted)))
      throw new SsoProblem("The issuer names an address on a private network.");
  }
  return doc as Discovered;
}

/** A certificate as SAML libraries take it: the base64 alone, without the PEM lines. */
export const bareCertificate = (pem: string) =>
  pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, "").replace(/\s+/g, "");

export async function saveSso(
  db: Database,
  organisationId: string,
  userId: string,
  input: SsoSettingsInput,
  context: { baseURL: string; trusted: string[] },
) {
  const [current] = await db.select().from(ssoProviders).where(inOrg(ssoProviders, organisationId));
  const previous = current?.oidcConfig
    ? (JSON.parse(current.oidcConfig) as { clientSecret?: string })
    : null;
  // Better Auth knows an account by its provider and its subject there. Another identity
  // provider's subjects are other people, so once anyone has signed in through this one, it
  // cannot be swapped for another under the same name.
  const identity = (protocol: string, issuer: string) =>
    `${protocol} ${issuer.trim().replace(/\/$/, "")}`;
  const nextIssuer = input.protocol === "oidc" ? input.issuer : input.idpEntityId;
  if (
    current &&
    identity(current.protocol, current.issuer) !== identity(input.protocol, nextIssuer)
  ) {
    const [linked] = await db
      .select({ id: authAccounts.id })
      .from(authAccounts)
      .where(eq(authAccounts.providerId, providerIdFor(organisationId)))
      .limit(1);
    if (linked)
      throw new SsoProblem(
        "People already sign in through this identity provider, so it cannot be swapped for another: a different provider's accounts are different people. Its other settings can still change.",
      );
  }
  const sp = serviceProvider(context.baseURL, organisationId);
  const extraFields = { groups: input.groupsClaim };
  let oidcConfig: string | null = null;
  let samlConfig: string | null = null;
  if (input.protocol === "oidc" && input.issuer) {
    const doc = await discover(input.issuer, context.trusted);
    const clientSecret = input.clientSecret ?? previous?.clientSecret;
    oidcConfig = JSON.stringify({
      issuer: doc.issuer,
      pkce: true,
      clientId: input.clientId,
      ...(clientSecret ? { clientSecret } : {}),
      discoveryEndpoint: `${input.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
      authorizationEndpoint: doc.authorization_endpoint,
      tokenEndpoint: doc.token_endpoint,
      jwksEndpoint: doc.jwks_uri,
      ...(doc.userinfo_endpoint ? { userInfoEndpoint: doc.userinfo_endpoint } : {}),
      tokenEndpointAuthentication: doc.token_endpoint_auth_methods_supported?.includes(
        "client_secret_basic",
      )
        ? "client_secret_basic"
        : "client_secret_post",
      scopes: ["openid", "email", "profile"],
      mapping: { id: "sub", email: "email", name: "name", extraFields },
    });
  }
  if (input.protocol === "saml" && input.entryPoint) {
    const cert = bareCertificate(input.certificate);
    samlConfig = JSON.stringify({
      issuer: sp.entityId,
      entryPoint: input.entryPoint,
      cert,
      callbackUrl: "/",
      idpMetadata: {
        entityID: input.idpEntityId,
        cert,
        singleSignOnService: [
          {
            Binding: "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect",
            Location: input.entryPoint,
          },
        ],
      },
      wantAssertionsSigned: true,
      identifierFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified",
      mapping: {
        id: "nameID",
        email: "email",
        name: "displayName",
        firstName: "givenName",
        lastName: "surname",
        extraFields,
      },
    });
  }
  const values = {
    providerId: providerIdFor(organisationId),
    issuer: nextIssuer,
    oidcConfig,
    samlConfig,
    userId,
    enabled: input.enabled,
    protocol: input.protocol,
    clientId: input.clientId,
    entryPoint: input.entryPoint,
    certificate: input.certificate,
    groupsClaim: input.groupsClaim,
    roles: input.roles,
    enforce: input.enforce,
    updatedAt: new Date(),
  };
  if (current)
    await db
      .update(ssoProviders)
      .set(values)
      .where(inOrg(ssoProviders, organisationId, eq(ssoProviders.id, current.id)));
  else await db.insert(ssoProviders).values({ organisationId, ...values });
}

/** The workspace a provider belongs to, and whether it signs anyone in. */
export async function providerState(db: Database, providerId: string) {
  const [row] = await db
    .select({
      organisationId: ssoProviders.organisationId,
      enabled: ssoProviders.enabled,
      roles: ssoProviders.roles,
    })
    .from(ssoProviders)
    // Deliberately by provider id alone: the request names the provider, not a workspace.
    .where(eq(ssoProviders.providerId, providerId));
  return row ?? null;
}

/** The groups a provider sent, however it sent them (one, a list, or none). */
export function groupsOf(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((g): g is string => typeof g === "string");
  return [];
}

/**
 * After every sign-in through a workspace's provider: the membership, and the role the
 * groups give (never an owner's, which people set). Logged.
 */
export async function provision(
  db: Database,
  audit: Audit | undefined,
  input: { userId: string; providerId: string; groups: unknown },
) {
  const provider = await providerState(db, input.providerId);
  if (!provider) return;
  const organisationId = provider.organisationId;
  const role = roleForGroups(groupsOf(input.groups), provider.roles);
  const [membership] = await db
    .select({ id: members.id, role: members.role })
    .from(members)
    .where(inOrg(members, organisationId, eq(members.userId, input.userId)));
  if (!membership) {
    // The workspace's member limit (#175): signed in, they join once there is room.
    const joined = await db.transaction(async (tx) => {
      const refusal = await memberRoom(tx, organisationId, "joining");
      if (refusal) {
        console.warn(`A first sign-in to workspace ${organisationId} was not joined: ${refusal}`);
        return false;
      }
      await tx.insert(members).values({ organisationId, userId: input.userId, role });
      return true;
    });
    if (!joined) return;
  } else if (membership.role !== "owner" && membership.role !== role)
    await db
      .update(members)
      .set({ role })
      .where(inOrg(members, organisationId, eq(members.id, membership.id)));
  if (audit)
    await audit.record(organisationId, await audit.member(input.userId), {
      action: "account.sso_sign_in",
      details: { role, joined: !membership },
    });
}

/** Whether a workspace takes its members only through its single sign-on. */
export async function enforcedProvider(db: Database, organisationId: string) {
  const [row] = await db
    .select({ providerId: ssoProviders.providerId })
    .from(ssoProviders)
    .where(
      inOrg(
        ssoProviders,
        organisationId,
        eq(ssoProviders.enabled, true),
        eq(ssoProviders.enforce, true),
      ),
    );
  return row?.providerId ?? null;
}
