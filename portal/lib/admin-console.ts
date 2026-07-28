import path from "node:path";
import { randomUUID } from "node:crypto";
import protobuf from "protobufjs";
import { SignJWT } from "jose";
import WebSocket from "ws";
import { env } from "@/lib/env";
import { allModules } from "@/lib/catalog";

/**
 * Client for Webswing's admin-console channel.
 *
 * Webswing exposes no session REST API. Everything an operator can do — list
 * running sessions with their usernames, kill a session, mirror one — lives
 * behind a single WebSocket at `/async/adminconsole`, protobuf-framed, and
 * authenticated purely by a handshake JWT signed with
 * `webswing.connection.secret` (HS256 over the raw UTF-8 bytes of the secret).
 *
 * Two consequences shape this file:
 *
 *  - That secret is effectively a root credential for the Webswing server. It
 *    lives only here, server-side, and is never exposed to a browser.
 *  - **Only one admin-console connection may exist at a time.** This client is
 *    therefore a process-wide singleton, and the portal must run as a single
 *    replica. A second replica would fight this one for the channel.
 *
 * Wire format: each WebSocket binary message is exactly one encoded
 * `AdminConsoleFrameMsgInProto` / `AdminConsoleFrameMsgOutProto` — there is no
 * length prefix or envelope of our own.
 */

export type WebswingSession = {
  instanceId: string;
  user: string;
  application: string;
  applicationPath: string;
  status: string;
  connected: boolean;
  startedAt: number | null;
  disconnectedSince: number | null;
};

export type AdminConsoleState = {
  /** null until the first successful poll; distinguishes "empty" from "unknown". */
  sessions: WebswingSession[] | null;
  connected: boolean;
  lastError: string | null;
  updatedAt: number | null;
};

const HANDSHAKE_SUBJECT = "handshake";
const POLL_INTERVAL_MS = 5_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

type Listener = (state: AdminConsoleState) => void;

class AdminConsoleClient {
  private ws: WebSocket | null = null;
  private root: protobuf.Root | null = null;
  private frameIn: protobuf.Type | null = null;
  private frameOut: protobuf.Type | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private backoff = BACKOFF_MIN_MS;
  private started = false;
  private byPath = new Map<string, WebswingSession[]>();
  private listeners = new Set<Listener>();
  /** correlationId → resolver, for the request/response half of saveConfig. */
  private pendingSaves = new Map<string, (r: { ok: boolean; error: string | null }) => void>();
  /**
   * Session-pool ids, from `getServerInfo`.
   *
   * An application's configuration is split across two providers inside
   * Webswing: the path-level half (`name`, `enabled`, `maxClients`, security)
   * belongs to the server config, and **`swingConfig` belongs to the session
   * pool** — `LocalSessionPoolConfigurationProvider.saveConfiguration` is what
   * merges it back into the entry. A `saveConfig` that carries `swingConfig`
   * inside `serverConfig` is accepted and silently drops it, leaving an app
   * that resolves but answers "Access to this application is forbidden".
   * So every publish needs the pool ids to address the second half.
   */
  private sessionPoolIds: string[] = [];

  private state: AdminConsoleState = {
    sessions: null,
    connected: false,
    lastError: null,
    updatedAt: null,
  };

  /** Idempotent — safe to call from instrumentation and from any handler. */
  start(): void {
    if (this.started) return;
    if (!env.webswingConnectionSecret) {
      this.setState({
        lastError: "WEBSWING_CONNECTION_SECRET not set — session view disabled",
      });
      return;
    }
    this.started = true;
    void this.connect();
  }

  getState(): AdminConsoleState {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setState(patch: Partial<AdminConsoleState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) {
      try {
        listener(this.state);
      } catch {
        // One bad subscriber must not block the rest.
      }
    }
  }

  private async loadProto(): Promise<void> {
    if (this.frameIn && this.frameOut) return;
    const dir = process.env.PROTO_DIR ?? path.join(process.cwd(), "proto");
    const root = await protobuf.load(path.join(dir, "AdminConsoleProto.proto"));
    this.root = root;
    this.frameIn = root.lookupType("adminconsole.AdminConsoleFrameMsgInProto");
    this.frameOut = root.lookupType("adminconsole.AdminConsoleFrameMsgOutProto");
  }

  private async handshakeToken(): Promise<string> {
    const secret = env.webswingConnectionSecret;
    if (!secret) throw new Error("no connection secret");
    // Mirrors JwtUtil.buildToken: HS256, subject "handshake", 1 minute of life.
    return new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(HANDSHAKE_SUBJECT)
      .setIssuedAt()
      .setExpirationTime("60s")
      .setJti(randomUUID())
      .sign(new TextEncoder().encode(secret));
  }

  private send(payload: Record<string, unknown>): void {
    if (!this.frameIn || this.ws?.readyState !== WebSocket.OPEN) return;
    const err = this.frameIn.verify(payload);
    if (err) {
      this.setState({ lastError: `admin console encode error: ${err}` });
      return;
    }
    const buf = this.frameIn.encode(this.frameIn.create(payload)).finish();
    this.ws.send(buf);
  }

  private async connect(): Promise<void> {
    if (!this.started) return;
    this.clearTimers();

    try {
      await this.loadProto();
    } catch (e) {
      this.scheduleReconnect(`proto load failed: ${(e as Error).message}`);
      return;
    }

    const url = `${env.webswingBaseUrl.replace(/^http/, "ws")}/async/adminconsole`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      this.scheduleReconnect((e as Error).message);
      return;
    }
    this.ws = ws;
    ws.binaryType = "nodebuffer";

    ws.on("open", async () => {
      try {
        // The server disconnects anything that does not handshake first.
        this.send({ handshake: { secretMessage: await this.handshakeToken() } });
        this.backoff = BACKOFF_MIN_MS;
        this.setState({ connected: true, lastError: null });
        this.send({ getServerInfo: {} });
        this.poll();
        this.pollTimer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
      } catch (e) {
        this.scheduleReconnect(`handshake failed: ${(e as Error).message}`);
      }
    });

    ws.on("message", (data: Buffer) => this.onMessage(data));
    ws.on("error", (e: Error) => this.scheduleReconnect(e.message));
    ws.on("close", () => this.scheduleReconnect("admin console closed"));
  }

  /**
   * `getSwingSessions` filters by application path, so ask per configured module
   * rather than relying on the semantics of an absent path.
   */
  private poll(): void {
    for (const mod of allModules()) {
      this.send({ getSwingSessions: { path: mod.path, correlationId: mod.path } });
    }
  }

  /** Wait briefly for `getServerInfo` to land, then hand back the pool ids. */
  private async poolIds(): Promise<string[]> {
    for (let i = 0; i < 20 && !this.sessionPoolIds.length; i += 1) {
      if (i === 0) this.send({ getServerInfo: {} });
      await new Promise((r) => setTimeout(r, 250));
    }
    return this.sessionPoolIds;
  }

  /**
   * Publish (or re-publish) an application path.
   *
   * Webswing's own config file is the durable record; this asks Webswing to
   * write it rather than writing it ourselves, because the server holds the
   * write `synchronized` and reloads inline afterwards. Writing the file from
   * outside would race the 1 s config poller and could be read half-written.
   *
   * The two halves go in one message: `serverConfig` carries the path-level
   * fields, and `appConfigs` carries `swingConfig` **per session pool** —
   * see `sessionPoolIds` for why splitting it is not optional.
   *
   * `createConfig` deliberately materialises the entry `enabled:false` first so
   * a half-built app never initialises; the save that follows carries the real
   * configuration, `enabled` included.
   */
  async publishApp(
    path: string,
    pathConfig: Record<string, unknown>,
    swingConfig: Record<string, unknown>,
    opts: { create?: boolean } = {},
  ): Promise<{ ok: boolean; error: string | null }> {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      return { ok: false, error: "The Webswing admin channel is not connected." };
    }
    const pools = await this.poolIds();
    if (!pools.length) {
      return { ok: false, error: "Webswing reported no session pools to configure." };
    }
    if (opts.create !== false) {
      this.send({ createApp: { path } });
      // createConfig writes, then re-reads through the same provider; give the
      // server a beat to settle before overwriting what it just created.
      await new Promise((r) => setTimeout(r, 250));
    }

    const correlationId = randomUUID();
    const result = this.awaitSaveResult(correlationId);
    this.send({
      saveConfig: {
        path,
        // Both handlers unwrap a top-level `data` object.
        serverConfig: Buffer.from(JSON.stringify({ data: pathConfig }), "utf8"),
        saveAppConfigs: true,
        appConfigs: pools.map((sessionPoolId) => ({
          sessionPoolId,
          appConfig: Buffer.from(JSON.stringify({ data: swingConfig }), "utf8"),
        })),
        correlationId,
      },
    });
    return result;
  }

  /**
   * Remove an application path. Webswing refuses while the app is enabled
   * ("Stop the app first"), so this disables it and waits for the config poller
   * to pick that up before asking for removal.
   */
  async unpublishApp(
    path: string,
    pathConfig: Record<string, unknown>,
    swingConfig: Record<string, unknown>,
  ): Promise<{ ok: boolean; error: string | null }> {
    const disabled = await this.publishApp(
      path,
      { ...pathConfig, enabled: false },
      swingConfig,
      { create: false },
    );
    if (!disabled.ok) return disabled;
    // The reload interval is 1 s by default; one beat past it is enough.
    await new Promise((r) => setTimeout(r, 1_500));
    if (this.ws?.readyState !== WebSocket.OPEN) {
      return { ok: false, error: "The Webswing admin channel is not connected." };
    }
    this.send({ removeApp: { path } });
    return { ok: true, error: null };
  }

  private awaitSaveResult(
    correlationId: string,
  ): Promise<{ ok: boolean; error: string | null }> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingSaves.delete(correlationId);
        resolve({ ok: false, error: "Webswing did not answer the configuration save." });
      }, 15_000);
      this.pendingSaves.set(correlationId, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
    });
  }

  private onMessage(data: Buffer): void {
    if (!this.frameOut) return;
    let msg: Record<string, unknown>;
    try {
      msg = this.frameOut.toObject(this.frameOut.decode(data), {
        enums: String,
        longs: Number,
        defaults: true,
      });
    } catch (e) {
      this.setState({ lastError: `decode failed: ${(e as Error).message}` });
      return;
    }

    const serverInfo = msg.serverInfo as { spInfos?: { id?: string }[] } | undefined;
    if (serverInfo?.spInfos) {
      const ids = serverInfo.spInfos.map((p) => String(p.id ?? "")).filter(Boolean);
      if (ids.length) this.sessionPoolIds = ids;
    }

    const saveResult = msg.saveConfigResult as
      | { serverResult?: boolean; serverError?: string; correlationId?: string }
      | undefined;
    if (saveResult?.correlationId) {
      const resolve = this.pendingSaves.get(saveResult.correlationId);
      if (resolve) {
        this.pendingSaves.delete(saveResult.correlationId);
        resolve({
          ok: saveResult.serverResult !== false,
          // Webswing returns a full stack trace; the first line is the useful part.
          error: saveResult.serverError ? String(saveResult.serverError).split("\n")[0] : null,
        });
      }
      return;
    }

    const swingSessions = msg.swingSessions as
      | { runningSessions?: unknown[]; correlationId?: string }
      | undefined;
    if (!swingSessions) return;

    const key = (swingSessions.correlationId as string) ?? (msg.path as string) ?? "";
    const running = (swingSessions.runningSessions ?? []).map((raw) => {
      const s = raw as Record<string, unknown>;
      return {
        instanceId: String(s.instanceId ?? ""),
        user: String(s.user ?? ""),
        application: String(s.application ?? ""),
        applicationPath: String(s.applicationPath ?? key),
        status: String(s.status ?? ""),
        connected: Boolean(s.connected),
        startedAt: typeof s.startedAt === "number" && s.startedAt > 0 ? s.startedAt : null,
        disconnectedSince:
          typeof s.disconnectedSince === "number" && s.disconnectedSince > 0
            ? s.disconnectedSince
            : null,
      } satisfies WebswingSession;
    });

    this.byPath.set(key, running);
    this.setState({
      sessions: [...this.byPath.values()].flat(),
      updatedAt: Date.now(),
    });
  }

  /**
   * Terminate a running Player JVM.
   *
   * VASSAL reads its preferences once, at JVM start, so re-seating a player who
   * already has a live session for that module means ending it first — a
   * reconnect would otherwise attach to a JVM still pointed at the old table.
   * Webswing's `CONTINUE_FOR_USER` then gives them a fresh JVM on next open.
   */
  shutdownSession(applicationPath: string, instanceId: string, force = true): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.send({ shutdown: { path: applicationPath, instanceId, force } });
    // Drop it from our projection immediately; the next poll confirms.
    for (const [key, sessions] of this.byPath) {
      this.byPath.set(
        key,
        sessions.filter((s) => s.instanceId !== instanceId),
      );
    }
    this.setState({ sessions: [...this.byPath.values()].flat(), updatedAt: Date.now() });
    return true;
  }

  /** Live sessions belonging to one user, optionally narrowed to one module. */
  sessionsFor(user: string, applicationPath?: string): WebswingSession[] {
    return (this.state.sessions ?? []).filter(
      (s) => s.user === user && (!applicationPath || s.applicationPath === applicationPath),
    );
  }

  private clearTimers(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.pollTimer = null;
    this.reconnectTimer = null;
  }

  private scheduleReconnect(reason: string): void {
    if (!this.started || this.reconnectTimer) return;
    this.clearTimers();
    try {
      this.ws?.removeAllListeners();
      this.ws?.terminate();
    } catch {
      // already gone
    }
    this.ws = null;
    this.setState({ connected: false, lastError: reason });

    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }
}

const globalForAdmin = globalThis as unknown as { __vassalAdminConsole?: AdminConsoleClient };
export const adminConsole: AdminConsoleClient = (globalForAdmin.__vassalAdminConsole ??=
  new AdminConsoleClient());
