// The request principal (storage.mdx §4/§10). No anonymous account: DEFAULT_USER only IDENTIFIES
// an unauthenticated caller; LFB routes return no data unless allowListed is true.
import type { Request } from "express";
import type { CurrentUser } from "@lfb/shared";

export interface AuthUser extends CurrentUser {
  sessionId: string | null;
}

export const DEFAULT_USER: AuthUser = Object.freeze({
  authenticated: false,
  email: null,
  name: null,
  roles: [],
  permissions: [],
  allowListed: false,
  sessionId: null,
});

export function currentUser(req: Request): AuthUser {
  return (req as Request & { user?: AuthUser }).user ?? DEFAULT_USER;
}
