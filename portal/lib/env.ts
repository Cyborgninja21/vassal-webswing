/**
 * Runtime configuration. Read once, in one place, so a missing value fails at
 * the first request with a clear message instead of surfacing as a confusing
 * 500 deep in a handler.
 */

function required(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`${name} is required — inject it via Komodo (see .env.example)`);
  }
  return v.trim();
}

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
}

export const env = {
  /** Webswing server, reached over the stack-internal network (never via Traefik). */
  get webswingBaseUrl(): string {
    return optional("WEBSWING_BASE_URL", "http://vassal-webswing:8080").replace(/\/+$/, "");
  },

  /**
   * Webswing's `webswing.connection.secret`. It signs the admin-console handshake
   * JWT and is effectively a root credential for the Webswing server — the portal
   * is its only holder, and it never reaches the browser.
   */
  get webswingConnectionSecret(): string | null {
    const v = process.env.WEBSWING_CONNECTION_SECRET;
    return v && v.trim() ? v.trim() : null;
  },

  /**
   * Secret path segment the VASSAL lobby posts its status to. The lobby's
   * `-URL` reporter cannot send headers, so the shared secret has to live in the
   * URL: `-URL http://vassal-portal:3000/lobby/<token>/`.
   */
  get lobbyPushToken(): string {
    return required("LOBBY_PUSH_TOKEN");
  },

  /** Headers set by Traefik's chain-authentik forward-auth. */
  get userHeader(): string {
    return optional("FORWARD_AUTH_USER_HEADER", "x-authentik-username").toLowerCase();
  },
  get groupsHeader(): string {
    return optional("FORWARD_AUTH_GROUPS_HEADER", "x-authentik-groups").toLowerCase();
  },

  /** Authentik groups granting operator controls (Phase 7); pipe-separated. */
  get adminGroups(): string[] {
    return optional("PORTAL_ADMIN_GROUPS", "Homelab Admins")
      .split("|")
      .map((g) => g.trim())
      .filter(Boolean);
  },

  get publicBaseUrl(): string {
    return optional("PORTAL_PUBLIC_BASE_URL", "https://vassal.epikos-kyklos.com").replace(/\/+$/, "");
  },
} as const;
