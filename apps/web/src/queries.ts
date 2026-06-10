/**
 * Shared fetchers + hooks. Page-specific queries/mutations stay colocated
 * with their pages; only shapes used across routes live here.
 */
import { useQuery } from "@tanstack/react-query";
import { ApiError, api, keys, unwrap } from "./api";

export function fetchProjects() {
  return unwrap(api.api.projects.get());
}
export type ProjectListItem = Awaited<ReturnType<typeof fetchProjects>>[number];

export async function fetchProject(projectId: string) {
  const detail = await unwrap(api.api.projects({ projectId }).get());
  // The service-token branch of this route returns a filtered shape without
  // `role`; the web app is always a user principal, so narrow it away.
  if (!("role" in detail)) {
    throw new ApiError(500, null, "Unexpected project response shape");
  }
  return detail;
}
export type ProjectDetail = Awaited<ReturnType<typeof fetchProject>>;
export type Environment = ProjectDetail["environments"][number];
export type ProjectRole = ProjectDetail["role"];

export function fetchMe() {
  return unwrap(api.api.me.get());
}
export type Me = Awaited<ReturnType<typeof fetchMe>>;

export function useMe() {
  return useQuery({ queryKey: keys.me, queryFn: fetchMe });
}

export function useProjects() {
  return useQuery({ queryKey: keys.projects, queryFn: fetchProjects });
}

export function useProject(projectId: string) {
  return useQuery({
    queryKey: keys.project(projectId),
    queryFn: () => fetchProject(projectId),
  });
}

export function useBootstrap() {
  return useQuery({
    queryKey: keys.bootstrap,
    queryFn: () => unwrap(api.api.bootstrap.get()),
    staleTime: 30_000,
  });
}
