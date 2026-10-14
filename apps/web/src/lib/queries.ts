import type { ProjectProfile } from "@hekate/shared";
import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export const healthQuery = queryOptions({
  queryKey: ["health"],
  queryFn: async () => {
    const res = await api.health.$get();
    return (await res.json()) as {
      status: "ok" | "degraded";
      version: string;
      database: "ok" | "unreachable";
    };
  },
  refetchInterval: 30_000,
});

export interface Me {
  user: { id: string; name: string; email: string };
  organisations: { id: string; name: string; role: "owner" | "admin" | "member" }[];
  activeOrganisationId: string;
}

/** The signed-in member, or null when signed out. */
export const meQuery = queryOptions({
  queryKey: ["me"],
  queryFn: async (): Promise<Me | null> => {
    const res = await api.me.$get();
    if (res.status === 401) return null;
    return json<Me>(res);
  },
  staleTime: 60_000,
});

export const setupQuery = queryOptions({
  queryKey: ["setup"],
  queryFn: async () => (await json<{ needed: boolean }>(await api.setup.$get())).needed,
  staleTime: Number.POSITIVE_INFINITY,
});

export const projectsQuery = queryOptions({
  queryKey: ["projects"],
  queryFn: async () => (await json<{ projects: Project[] }>(await api.projects.$get())).projects,
});

export const projectQuery = (id: string) =>
  queryOptions({
    queryKey: ["projects", id],
    queryFn: async () =>
      (await json<{ project: Project }>(await api.projects[":id"].$get({ param: { id } }))).project,
  });

export interface Project {
  id: string;
  name: string;
  profile: ProjectProfile;
  createdAt: string;
}

export function useCreateProject() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { name: string; profile: ProjectProfile }) =>
      (await json<{ project: Project }>(await api.projects.$post({ json: input }))).project,
    onSuccess: () => client.invalidateQueries({ queryKey: ["projects"] }),
  });
}
