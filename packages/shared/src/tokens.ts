export const TOKEN_PREFIXES = {
  serviceToken: "safe_st_",
  userToken: "safe_ut_",
} as const;

export type TokenKind = "service" | "user" | null;

export function classifyToken(token: string): TokenKind {
  if (token.startsWith(TOKEN_PREFIXES.serviceToken)) return "service";
  if (token.startsWith(TOKEN_PREFIXES.userToken)) return "user";
  return null;
}
