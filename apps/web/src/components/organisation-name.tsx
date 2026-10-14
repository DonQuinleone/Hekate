import { useQuery } from "@tanstack/react-query";
import { meQuery } from "~/lib/queries";

/** The active organisation's name as a page label. */
export function OrganisationName() {
  const { data: me } = useQuery(meQuery);
  const name = me?.organisations.find((o) => o.id === me.activeOrganisationId)?.name ?? "";
  return <span className="label">{name}</span>;
}
