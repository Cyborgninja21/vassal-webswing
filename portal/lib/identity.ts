import { timingSafeEqual } from "node:crypto";
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
 *  1. The request must carry the edge secret Traefik injects. Anything on the
 *     stack network can open a socket to `vassal-portal:3000` and assert any
 *     header it likes — including the Webswing container, where third-party
 *     module code runs — so a header-presence test is not a control. Proven
 *     against production 2026-07-27: a `wget` from inside `vassal-webswing`
 *     with a made-up `X-Forwarded-For` and `X-authentik-groups: Homelab Admins`
 *     was served the operator API.
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

/** Constant-time compare that tolerates length mismatch. */
function secretMatches(given: string | null, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

let warnedNoEdgeSecret = false;

export async function currentIdentity(): Promise<Identity | null> {
  const h = await headers();

  // Proof the request traversed the proxy rather than arriving on the internal net.
  const expected = env.portalEdgeSecret;
  if (expected) {
    if (!secretMatches(h.get(env.portalEdgeHeader), expected)) return null;
  } else {
    if (!warnedNoEdgeSecret) {
      warnedNoEdgeSecret = true;
      console.warn(
        "vassal_portal PORTAL_EDGE_SECRET is unset — identity headers are only " +
          "checked for presence, which anything on this network can forge.",
      );
    }
    if (!h.get("x-forwarded-for")) return null;
  }

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
