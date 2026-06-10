import type { InstanceRole } from "./roles";

export type ServiceTokenScope = "read" | "read_write";

export interface UserPrincipal {
  type: "user";
  userId: string;
  instanceRole: InstanceRole;
}

export interface ServicePrincipal {
  type: "service";
  tokenId: string;
  projectId: string;
  scope: ServiceTokenScope;
  /** Environment ids the token may access; null = all environments. */
  environmentIds: string[] | null;
}

export type Principal = UserPrincipal | ServicePrincipal;
