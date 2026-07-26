import { headers } from "next/headers";
import { env } from "@/lib/env";

export type Identity = {
  username: string;
  groups: string[];
  isAdmin: boolean;
};

/**
 * Same identity contract as the Webswing container's XForwardedUser realm: the
 * username is whatever Traefik's chain-authentik forward-auth put in the header.
 *
 * Two guards make that safe to trust:
 *
 *  1. `X-Forwarded-For` must be present. Traefik always sets it; a container
 *     talking to us directly on the stack network does not. This is what stops
 *     a compromised sidecar from simply asserting a username header.
 *  2. The username must satisfy the same character class the Webswing realm
 *     enforces, so the two systems can never disagree about who a user is.
 */
const USERNAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._@-]*[A-Za-z0-9])?$/;

export function sanitizeUsername(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = raw.trim();
  if (!v || v.length > 64 || !USERNAME_RE.test(v)) return null;
  return v;
}

export async function currentIdentity(): Promise<Identity | null> {
  const h = await headers();

  // Proof the request traversed the proxy rather than arriving on the internal net.
  if (!h.get("x-forwarded-for")) return null;

  const username = sanitizeUsername(h.get(env.userHeader));
  if (!username) return null;

  const groups = (h.get(env.groupsHeader) ?? "")
    .split("|")
    .map((g) => g.trim())
    .filter(Boolean);

  const adminGroups = env.adminGroups;
  return {
    username,
    groups,
    isAdmin: groups.some((g) => adminGroups.includes(g)),
  };
}

/** For route handlers: null identity is a 401, never a redirect (no login page exists). */
export async function requireIdentity(): Promise<Identity | Response> {
  const id = await currentIdentity();
  if (!id) {
    return new Response("Not authenticated. Reach the portal through its public URL.", {
      status: 401,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  return id;
}

export function isResponse(v: unknown): v is Response {
  return v instanceof Response;
}
