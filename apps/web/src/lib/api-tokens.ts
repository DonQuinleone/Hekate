import type {
  ApiLogRow,
  ApiTokenKind,
  ApiTokenRow,
  CreateApiTokenInput,
  CreatedApiToken,
  UpdateApiTokenInput,
} from "@hekate/shared";
import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { json } from "./queries";

/** A member's own API tokens (#198), in the workspace they are in now. */
export const personalTokensQuery = queryOptions({
  queryKey: ["me", "tokens"],
  queryFn: async () => (await json<{ tokens: ApiTokenRow[] }>(await api.me.tokens.$get())).tokens,
});

/** The workspace's service tokens, for its owners and admins. */
export const serviceTokensQuery = queryOptions({
  queryKey: ["organisation", "tokens"],
  queryFn: async () =>
    (await json<{ tokens: ApiTokenRow[] }>(await api.organisation.tokens.$get())).tokens,
});

/** The latest calls the workspace's tokens made, for its owners and admins. */
export const workspaceApiLogQuery = queryOptions({
  queryKey: ["organisation", "tokens", "log"],
  queryFn: async () =>
    (
      await json<{ rows: ApiLogRow[] }>(
        await api.organisation.tokens.log.$get({ query: { range: "7d", limit: "20" } }),
      )
    ).rows,
});

/** Make, change and revoke tokens of one kind. A new token's secret comes back once. */
export function useApiTokens(kind: ApiTokenKind) {
  const client = useQueryClient();
  const query = kind === "personal" ? personalTokensQuery : serviceTokensQuery;
  const routes = kind === "personal" ? api.me.tokens : api.organisation.tokens;
  const refresh = () => client.invalidateQueries({ queryKey: query.queryKey });
  return {
    create: useMutation({
      mutationFn: async (input: CreateApiTokenInput) =>
        json<CreatedApiToken>(await routes.$post({ json: input })),
      onSuccess: refresh,
    }),
    change: useMutation({
      mutationFn: async ({ id, ...input }: UpdateApiTokenInput & { id: string }) =>
        json<{ token: ApiTokenRow }>(await routes[":id"].$patch({ param: { id }, json: input })),
      onSuccess: refresh,
    }),
    revoke: useMutation({
      mutationFn: async (id: string) => {
        const res = await routes[":id"].$delete({ param: { id } });
        if (!res.ok) await json(res);
      },
      onSuccess: refresh,
    }),
  };
}
