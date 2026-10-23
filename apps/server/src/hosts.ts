import { type Database, schema } from "@hekate/db";
import { isReservedSlug } from "@hekate/shared";
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";

/**
 * Workspace subdomains (#176, decision 208). With WORKSPACE_SUBDOMAINS on, each workspace also
 * answers at its own name under the instance's address: `endless-hall.review.example` beside
 * `review.example`. The host says which workspace a request is for; the root host keeps the
 * instance pages and the sign-in. One session serves them all: its cookie is the root's, so
 * signing in once reaches every workspace someone belongs to, and each host still admits only
 * that workspace's members.
 */

export interface Subdomains {
  /** The root's host, as PUBLIC_URL gives it, without a port: `review.example`. */
  root: string;
  /** PUBLIC_URL, parsed. */
  url: URL;
}

/** The subdomains of PUBLIC_URL, or null where they are off. */
export function subdomainsOf(publicUrl: string, on: boolean): Subdomains | null {
  if (!on) return null;
  const url = new URL(publicUrl);
  return { root: url.hostname, url };
}

/** A workspace's own address: `https://endless-hall.review.example`, with the root's port. */
export function workspaceAddress(subdomains: Subdomains, slug: string): string {
  const { url } = subdomains;
  return `${url.protocol}//${slug}.${url.host}`;
}

/** The root's address, without a trailing slash. */
export const rootAddress = (subdomains: Subdomains) => subdomains.url.origin;

/**
 * What links sent out (in mail above all) are made from (#437): PUBLIC_URL, and the
 * subdomains where they are on. Most dependencies that send mail carry both.
 */
export interface LinkRoots {
  publicUrl: string;
  subdomains?: Subdomains | null;
}

/**
 * The address a workspace's links start from, without a trailing slash: its own host with
 * subdomains on, so a link opens in the workspace it names whatever the person's active one
 * is; PUBLIC_URL otherwise.
 */
export function linkBase(roots: LinkRoots, slug: string | null | undefined): string {
  if (roots.subdomains && slug) return workspaceAddress(roots.subdomains, slug);
  return roots.publicUrl.replace(/\/$/, "");
}

/** The address a workspace's links start from, by its id: read only with subdomains on. */
export async function workspaceLinkBase(
  db: Pick<Database, "select">,
  roots: LinkRoots,
  organisationId: string,
): Promise<string> {
  if (!roots.subdomains) return linkBase(roots, null);
  const [row] = await db
    .select({ slug: schema.organisations.slug })
    .from(schema.organisations)
    .where(eq(schema.organisations.id, organisationId));
  return linkBase(roots, row?.slug);
}

/**
 * Which host a request names: the root, a workspace's (by its name), or neither (an address
 * that is not this instance's, as a health check by IP sends). Ports are ignored.
 */
export function hostKind(
  host: string | undefined,
  subdomains: Subdomains,
): { kind: "root" } | { kind: "workspace"; slug: string } | { kind: "other" } {
  const name = (host ?? "").toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
  if (name === subdomains.root) return { kind: "root" };
  const suffix = `.${subdomains.root}`;
  if (!name.endsWith(suffix)) return { kind: "other" };
  const slug = name.slice(0, -suffix.length);
  // One label only: `a.b.review.example` is no workspace's.
  if (!/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(slug) || isReservedSlug(slug))
    return { kind: "other" };
  return { kind: "workspace", slug };
}

/** The host a request was sent to: the proxy's forwarded host, where it is trusted. */
export function requestHost(c: Context, trustProxy: boolean): string | undefined {
  const forwarded = trustProxy ? c.req.header("x-forwarded-host")?.split(",")[0]?.trim() : "";
  return forwarded || c.req.header("host");
}

/** The workspace a request's host names; absent on the root, or with subdomains off. */
export interface HostWorkspace {
  id: string;
  slug: string;
  name: string;
}

export interface HostVariables {
  /** Set on a workspace's host; undefined elsewhere. */
  hostWorkspace?: HostWorkspace;
}

/** The workspace a request's host pins it to, for the tenancy checks to hold it to. */
export const pinnedWorkspace = (c: Context): HostWorkspace | undefined =>
  (c.var as HostVariables).hostWorkspace;

/**
 * Reads the workspace from the host, for every API request. An address under the root that
 * names no workspace is answered 404, so nothing below needs to ask.
 */
export const workspaceFromHost = (
  db: Database,
  subdomains: Subdomains | null,
  trustProxy: boolean,
) =>
  createMiddleware<{ Variables: HostVariables }>(async (c, next) => {
    if (!subdomains) return next();
    const host = hostKind(requestHost(c, trustProxy), subdomains);
    if (host.kind !== "workspace") return next();
    const [row] = await db
      .select({
        id: schema.organisations.id,
        slug: schema.organisations.slug,
        name: schema.organisations.name,
      })
      .from(schema.organisations)
      .where(eq(schema.organisations.slug, host.slug));
    if (!row)
      return c.json(
        { error: { code: "no_workspace", message: "No workspace answers at this address" } },
        404,
      );
    c.set("hostWorkspace", row);
    await next();
  });

/**
 * The origins a passkey may be used at: the root's and the trusted ones, and with subdomains on
 * every workspace's. SimpleWebAuthn checks an origin list with `includes`, so this list answers
 * yes for any workspace host under the root as well as for those it holds.
 */
class PasskeyOriginList extends Array<string> {
  subdomains: Subdomains | null = null;

  override includes(origin: string): boolean {
    return super.includes(origin) || workspaceOrigin(this.subdomains, origin);
  }
}

/** Whether an origin is exactly a workspace's host under the root, by the root's scheme and port. */
export function workspaceOrigin(subdomains: Subdomains | null, origin: string): boolean {
  if (!subdomains) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const root = subdomains.url;
  return (
    url.protocol === root.protocol &&
    url.port === root.port &&
    url.origin === origin &&
    hostKind(url.host, subdomains).kind === "workspace"
  );
}

/** The origin list for the passkey plugin: these, and every workspace's with subdomains on. */
export function passkeyOrigins(origins: string[], subdomains: Subdomains | null): string[] {
  const list = new PasskeyOriginList();
  list.push(...origins);
  list.subdomains = subdomains;
  return list;
}
