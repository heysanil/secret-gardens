/**
 * better-auth client. All /api/auth/* traffic goes through this — the Eden
 * client in api.ts never touches auth routes.
 */
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  baseURL: window.location.origin,
  basePath: "/api/auth",
});

export const { useSession, signIn, signUp, signOut } = authClient;
