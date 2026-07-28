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

  /**
   * Shared secret Traefik injects on every request it forwards to the portal.
   *
   * Without it the only proof a request came through the proxy is "an
   * X-Forwarded-For header is present", which any client can set. Containers on
   * the stack network can reach `vassal-portal:3000` directly — including the
   * Webswing container, where third-party module code runs — so that check
   * stops accidents, not intent. Since the admin API can publish a module, and
   * publishing a module runs its code, this needs to be real.
   *
   * Optional so the Phase 0/1 scratch stack and local dev still work; when it
   * is unset the portal falls back to the old check and says so loudly.
   */
  get portalEdgeSecret(): string | null {
    const v = process.env.PORTAL_EDGE_SECRET;
    return v && v.trim() ? v.trim() : null;
  },
  get portalEdgeHeader(): string {
    return optional("PORTAL_EDGE_HEADER", "x-portal-edge").toLowerCase();
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

  /**
   * Per-player VASSAL homes, shared read-write with the Webswing container.
   * The portal writes preferences here before a launch so the player lands at
   * the right table already named.
   */
  get usersDir(): string {
    return optional("VASSAL_USERS_DIR", "/data/users");
  },

  /** Portal-owned state (table registry, per-user identities). */
  get stateDir(): string {
    return optional("PORTAL_STATE_DIR", "/data/users/_portal");
  },

  /**
   * The one VASSAL lobby process. Every table is a named room inside it.
   *
   * There used to be a pool of eight `vassal-table-N` containers, one per
   * table, because a stock VASSAL client always lands in "Main Room" — so the
   * server had to *be* the table. The engine patch that joins a named room
   * retired that constraint; the pool outlived it until this change. Rooms are
   * created on demand by the server, so the table count is now a portal-side
   * number rather than a container count.
   */
  get lobbyHost(): string {
    return optional("VASSAL_LOBBY_HOST", "vassal-lobby");
  },
  get lobbyPort(): number {
    const n = Number.parseInt(optional("VASSAL_LOBBY_PORT", "5050"), 10);
    return Number.isFinite(n) && n > 0 && n < 65536 ? n : 5050;
  },

  /**
   * Ceiling on simultaneously open tables. Not a resource limit — the binding
   * constraint is `maxConcurrentSeats` below, since a table with nobody in it
   * costs nothing — just a guard against a runaway client filling the registry.
   */
  get maxTables(): number {
    const n = Number.parseInt(optional("VASSAL_MAX_TABLES", "64"), 10);
    return Number.isFinite(n) && n > 0 && n <= 512 ? n : 64;
  },

  /** Default seat cap for a new table; the host can lower or raise it. */
  get defaultMaxSeats(): number {
    const n = Number.parseInt(optional("VASSAL_DEFAULT_MAX_SEATS", "6"), 10);
    return Number.isFinite(n) && n > 0 ? n : 6;
  },

  /**
   * How many *different* games one person may have open at once.
   *
   * Each is a ~500 MB JVM that outlives the browser tab, so without this one
   * person clicking through the catalogue can consume the whole stack ceiling.
   * Re-opening the same module is not affected: Webswing's `CONTINUE_FOR_USER`
   * hands back the existing session rather than starting a second one.
   */
  get maxSeatsPerUser(): number {
    const n = Number.parseInt(optional("VASSAL_MAX_SEATS_PER_USER", "3"), 10);
    return Number.isFinite(n) && n > 0 ? n : 3;
  },

  /**
   * Ceiling on concurrent Player JVMs across the whole stack. Each is ~600 MB
   * against a 24 GB container limit, so the portal refuses a seat *before*
   * Webswing's maxClients does — a clear message beats an opaque error.
   */
  get maxConcurrentSeats(): number {
    const n = Number.parseInt(optional("VASSAL_MAX_CONCURRENT_SEATS", "16"), 10);
    return Number.isFinite(n) && n > 0 ? n : 16;
  },

  /**
   * Ingested module store, shared with the Webswing container. The portal
   * mounts it read-write; Webswing mounts it **read-only**, so a module's own
   * code cannot rewrite the store other players load from, and a failing
   * extension cannot rename itself into `inactive/` for everybody.
   */
  get modulesDir(): string {
    return optional("VASSAL_MODULES_DIR", "/data/modules");
  },

  /** Ceiling on a single downloaded archive. Enforced on bytes written. */
  get moduleMaxBytes(): number {
    return positive("VASSAL_MODULE_MAX_BYTES", 1024 * 1024 * 1024);
  },

  /** Zip-bomb guards: total inflated size and entry count of one archive. */
  get moduleMaxUnpackedBytes(): number {
    return positive("VASSAL_MODULE_MAX_UNPACKED_BYTES", 4 * 1024 * 1024 * 1024);
  },
  get moduleMaxEntries(): number {
    return positive("VASSAL_MODULE_MAX_ENTRIES", 20_000);
  },

  /**
   * VASSAL release inside the webswing image. A module saved by a *newer*
   * VASSAL cannot be opened by an older engine, so ingest refuses it rather
   * than publishing a game that dies on launch. Keep in step with the
   * Dockerfile's `VASSAL_VERSION`.
   */
  get vassalEngineVersion(): string {
    return optional("VASSAL_ENGINE_VERSION", "3.7.24");
  },

  /** Defaults for a newly published module's Webswing app entry. */
  get moduleDefaultMaxClients(): number {
    return positive("VASSAL_MODULE_DEFAULT_MAX_CLIENTS", 8);
  },
  get moduleDefaultHeap(): string {
    return optional("VASSAL_MODULE_DEFAULT_HEAP", "2g");
  },

  /**
   * Whether the fetcher may resolve to a private address. Off by default: the
   * portal sits on the stack network and can reach every table lobby and the
   * Traefik API, so an unguarded fetcher would be an SSRF pivot. Only turn this
   * on to ingest from a deliberately-hosted internal mirror.
   */
  get moduleAllowPrivateFetch(): boolean {
    return optional("VASSAL_MODULE_ALLOW_PRIVATE_FETCH", "false").toLowerCase() === "true";
  },
} as const;

function positive(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
