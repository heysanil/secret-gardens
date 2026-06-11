/**
 * API seeding helpers over Playwright request contexts. Used to provision
 * projects/users/secrets so each spec file is self-contained without going
 * through the UI for everything.
 */
import {
  type APIRequestContext,
  type APIResponse,
  expect,
  request as pwRequest,
} from "@playwright/test";
import { BASE_URL, MEMBER_PASSWORD, OWNER_STATE } from "./constants";

export interface Environment {
  id: string;
  name: string;
  slug: string;
  position: number;
}

export interface ProjectDetail {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  role: string;
  environments: Environment[];
}

/**
 * Standalone request context authenticated with the owner session saved by
 * 01-setup.spec. For use in beforeAll hooks (the `request` fixture is
 * test-scoped); callers must dispose() it.
 */
export async function newOwnerContext(): Promise<APIRequestContext> {
  return pwRequest.newContext({
    baseURL: BASE_URL,
    storageState: OWNER_STATE,
    // better-auth's cookie-authenticated POST endpoints (e.g. the admin
    // create-user API) reject requests without an Origin header.
    extraHTTPHeaders: { origin: BASE_URL },
  });
}

/** Bearer-token request context (PATs and service tokens). */
export async function newBearerContext(
  token: string,
): Promise<APIRequestContext> {
  return pwRequest.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: { authorization: `Bearer ${token}` },
  });
}

async function ok<T>(res: APIResponse, what: string): Promise<T> {
  expect(res.ok(), `${what}: ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

export async function createProject(
  api: APIRequestContext,
  name: string,
  description?: string,
): Promise<ProjectDetail> {
  const res = await api.post("/api/projects", {
    data: { name, ...(description !== undefined && { description }) },
  });
  return ok<ProjectDetail>(res, `create project ${name}`);
}

export function envBySlug(project: ProjectDetail, slug: string): Environment {
  const env = project.environments.find((e) => e.slug === slug);
  if (env === undefined) {
    throw new Error(`project ${project.slug} has no environment "${slug}"`);
  }
  return env;
}

export async function putSecret(
  api: APIRequestContext,
  projectId: string,
  envId: string,
  key: string,
  value: string,
): Promise<{ key: string; version: number; op: string }> {
  const res = await api.put(
    `/api/projects/${projectId}/environments/${envId}/secrets/${key}`,
    { data: { value } },
  );
  return ok(res, `put secret ${key}`);
}

export async function bulkPutSecrets(
  api: APIRequestContext,
  projectId: string,
  envId: string,
  secrets: Record<string, string>,
): Promise<void> {
  const res = await api.put(
    `/api/projects/${projectId}/environments/${envId}/secrets`,
    { data: { secrets } },
  );
  await ok(res, "bulk put secrets");
}

export async function deleteSecret(
  api: APIRequestContext,
  projectId: string,
  envId: string,
  key: string,
): Promise<void> {
  const res = await api.delete(
    `/api/projects/${projectId}/environments/${envId}/secrets/${key}`,
  );
  await ok(res, `delete secret ${key}`);
}

/** Creates a member-role user via the better-auth admin API (owner only). */
export async function createUser(
  api: APIRequestContext,
  email: string,
  name: string,
  password: string = MEMBER_PASSWORD,
): Promise<{ id: string; email: string; password: string }> {
  const res = await api.post("/api/auth/admin/create-user", {
    data: { email, password, name },
  });
  const body = await ok<{ user: { id: string } }>(res, `create user ${email}`);
  return { id: body.user.id, email, password };
}

export async function addMember(
  api: APIRequestContext,
  projectId: string,
  userId: string,
  role: "admin" | "write" | "read",
): Promise<void> {
  const res = await api.post(`/api/projects/${projectId}/members`, {
    data: { userId, role },
  });
  await ok(res, `add member ${userId} as ${role}`);
}

export async function createPat(
  api: APIRequestContext,
  name: string,
): Promise<{ id: string; token: string }> {
  const res = await api.post("/api/me/tokens", { data: { name } });
  return ok(res, `create PAT ${name}`);
}
