import type {
  AuthorizeParams,
  AuthorizeRefusal,
  AuthorizeRequestView,
  ConnectedAppRow,
  CreatedOAuthClient,
  CreateOAuthClientInput,
  OAuthClientRow,
  OAuthConnectionRow,
  UpdateOAuthClientInput,
} from "@hekate/shared";
import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { json } from "./queries";

/** The workspace's OAuth clients (#447), for its owners and admins. */
export const oauthClientsQuery = queryOptions({
  queryKey: ["organisation", "oauth-clients"],
  queryFn: async () =>
    (await json<{ clients: OAuthClientRow[] }>(await api.organisation["oauth-clients"].$get()))
      .clients,
});

/** Who has a client connected now. */
export const oauthConnectionsQuery = (id: string) =>
  queryOptions({
    queryKey: ["organisation", "oauth-clients", id, "connections"],
    queryFn: async () =>
      (
        await json<{ connections: OAuthConnectionRow[] }>(
          await api.organisation["oauth-clients"][":id"].connections.$get({ param: { id } }),
        )
      ).connections,
  });

/** The applications the member connected to this workspace. */
export const connectedAppsQuery = queryOptions({
  queryKey: ["me", "connected-apps"],
  queryFn: async () =>
    (await json<{ apps: ConnectedAppRow[] }>(await api.me["connected-apps"].$get())).apps,
});

/** Register, change, rotate the secret of and delete clients. A secret comes back once. */
export function useOAuthClients() {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: oauthClientsQuery.queryKey });
  const routes = api.organisation["oauth-clients"];
  return {
    create: useMutation({
      mutationFn: async (input: CreateOAuthClientInput) =>
        json<CreatedOAuthClient>(await routes.$post({ json: input })),
      onSuccess: refresh,
    }),
    change: useMutation({
      mutationFn: async ({ id, ...input }: UpdateOAuthClientInput & { id: string }) =>
        json<{ client: OAuthClientRow }>(
          await routes[":id"].$patch({ param: { id }, json: input }),
        ),
      onSuccess: refresh,
    }),
    rotate: useMutation({
      mutationFn: async (id: string) =>
        json<CreatedOAuthClient>(await routes[":id"].secret.$post({ param: { id } })),
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: async (id: string) => {
        await json(await routes[":id"].$delete({ param: { id } }));
      },
      onSuccess: refresh,
    }),
  };
}

/** Disconnect an application: every token it holds stops working. */
export function useDisconnect() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await json(await api.me["connected-apps"][":id"].$delete({ param: { id } }));
    },
    onSuccess: () => client.invalidateQueries({ queryKey: connectedAppsQuery.queryKey }),
  });
}

/** What the consent screen shows for a request, or why it cannot. */
export type AuthorizeView = { request: AuthorizeRequestView } | { refusal: AuthorizeRefusal };

export const authorizeQuery = (params: AuthorizeParams) =>
  queryOptions({
    queryKey: ["oauth", "authorize", params],
    queryFn: async () => json<AuthorizeView>(await api.oauth.authorize.$get({ query: params })),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });

/** The person's answer: where to go next, with a code or with `access_denied`. */
export function useAuthorize() {
  return useMutation({
    mutationFn: async (input: AuthorizeParams & { approve: boolean }) =>
      json<{ redirect?: string; refusal?: AuthorizeRefusal }>(
        await api.oauth.authorize.$post({ json: input }),
      ),
  });
}
