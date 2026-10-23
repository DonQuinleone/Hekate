import type {
  Incident,
  IncidentInput,
  IncidentUpdateInput,
  StatusNow,
  StatusPage,
} from "@hekate/shared";
import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { json } from "./queries";

/**
 * The status page (#183): read by anyone, signed in or not, and by the help menu and the
 * Support page for what is open; incidents posted by the operators from the support desk.
 */

/** Read again each minute: the page may be left open while something is being fixed. */
const MINUTE = 60_000;

export const statusPageQuery = queryOptions({
  queryKey: ["status", "page"],
  queryFn: async () => json<StatusPage>(await api.status.$get()),
  refetchInterval: MINUTE,
});

export const statusNowQuery = queryOptions({
  queryKey: ["status", "now"],
  queryFn: async () => json<StatusNow>(await api.status.now.$get()),
  refetchInterval: MINUTE,
  staleTime: 30_000,
});

export const incidentsQuery = queryOptions({
  queryKey: ["instance", "incidents"],
  queryFn: async () =>
    json<{ incidents: Incident[]; now: StatusNow }>(await api.instance.incidents.$get()),
});

function useAfterIncident() {
  const client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: ["instance", "incidents"] });
    void client.invalidateQueries({ queryKey: ["status"] });
  };
}

export function usePostIncident() {
  const after = useAfterIncident();
  return useMutation({
    mutationFn: async (input: IncidentInput) =>
      json<{ id: string; incidents: Incident[] }>(
        await api.instance.incidents.$post({ json: input }),
      ),
    onSuccess: after,
  });
}

export function useUpdateIncident(id: string) {
  const after = useAfterIncident();
  return useMutation({
    mutationFn: async (input: IncidentUpdateInput) =>
      json<{ incidents: Incident[] }>(
        await api.instance.incidents[":id"].updates.$post({ param: { id }, json: input }),
      ),
    onSuccess: after,
  });
}

export function useRemoveIncident() {
  const after = useAfterIncident();
  return useMutation({
    mutationFn: async (id: string) =>
      json<{ incidents: Incident[] }>(
        await api.instance.incidents[":id"].$delete({ param: { id } }),
      ),
    onSuccess: after,
  });
}
