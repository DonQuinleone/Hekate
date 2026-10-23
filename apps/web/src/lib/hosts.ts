import type { Me } from "./queries";

/**
 * Where a page belongs, with workspace subdomains on (#176): the root's address for the
 * instance's pages, the active workspace's for the rest. Null where it is already there, or
 * subdomains are off.
 */
export function addressFor(me: Me, path: string, host: string): string | null {
  if (!me.root) return null;
  const rootHost = new URL(me.root).host;
  if (path.startsWith("/instance")) return host === rootHost ? null : me.root;
  const active = me.organisations.find((o) => o.id === me.activeOrganisationId)?.url;
  if (!active || new URL(active).host === host) return null;
  return active;
}
