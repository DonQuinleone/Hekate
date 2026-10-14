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
