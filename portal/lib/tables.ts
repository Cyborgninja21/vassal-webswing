import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { env } from "@/lib/env";

/**
 * The table registry.
 *
 * A "table" is a **named room inside the one lobby process**. It used to be a
 * whole `VASSAL.chat.node.Server` container of its own, from a fixed pool of
 * eight: a stock client always lands in "Main Room", so the server had to be
 * the table. The engine patch that joins a named room removed that constraint,
 * and rooms are created on demand by the server, so nothing has to be
 * pre-provisioned and there is no pool to run out of.
 *
 * `slot` is therefore just the table's number — a small stable integer used in
 * portal URLs. It is **not** a container index. It does two jobs:
 *
 *  - it keys the registry and the `/watch/N` route, and
 *  - it is embedded in the VASSAL room name by {@link roomNameFor}, which is
 *    how the lobby feed's rows are attributed back to a table.
 *
 * Registry state is a small JSON file on the shared NFS volume. It holds names
 * and ownership only — never occupancy, which always comes live from the lobby
 * feed, so the two can never disagree.
 */

export type Table = {
  /** Table number. A portal identifier, not a container slot — see above. */
  slot: number;
  name: string;
  /** Webswing app path, e.g. "/his". */
  modulePath: string;
  createdBy: string;
  createdAt: number;
  /** Set when the table is retired; the slot is then reusable. */
  closedAt: number | null;
  /** Usernames the portal seated as observers rather than players. */
  spectators?: string[];
  /**
   * Portal-enforced seat cap. VASSAL's own room lock is cosmetic — its password
   * is a value the server already broadcasts to the module — so every access
   * decision belongs here, checked server-side on the way in.
   */
  maxSeats?: number;
  spectatorsAllowed?: boolean;
  /** Locked tables refuse new players; people already seated are unaffected. */
  locked?: boolean;
};

export type UserIdentity = {
  /** Display name VASSAL shows to the other players. */
  nickname: string;
  /** Pre-selected game when opening a table. */
  defaultModule?: string;
  /** Prefer the Watch button over Take a seat. */
  spectateByDefault?: boolean;
  /**
   * Stable per-user token written to the module's `SecretName` pref. VASSAL
   * matches it to hand a returning player their seat back. It is NOT a
   * credential: VASSAL stores it in clear and broadcasts it inside the node id.
   */
  secretName: string;
};

type State = {
  tables: Table[];
  users: Record<string, UserIdentity>;
};

const EMPTY: State = { tables: [], users: {} };

/** A table with nobody in it for this long is retired and its slot freed. */
const IDLE_REAP_MS = 15 * 60 * 1000;
/** ...but never before this much time has passed, so a new table can fill up. */
const CREATION_GRACE_MS = 5 * 60 * 1000;

/**
 * The VASSAL room name for a table.
 *
 * The trailing `(#n)` is load-bearing, not decoration. With every table sharing
 * one lobby, room names live in a single namespace per module, and the status
 * feed reports rooms by name only — so the number is both what keeps two tables
 * called "Sunday game" apart and what maps a feed row back to a registry row.
 * `sanitizeTableName` rejects `#`, so a player cannot type a name that collides
 * with the suffix.
 */
export function roomNameFor(table: Pick<Table, "slot" | "name">): string {
  return `${table.name} (#${table.slot})`;
}

/** Inverse of {@link roomNameFor}; null for rooms the portal did not name. */
export function tableNumberFromRoom(room: string): number | null {
  const m = /\(#(\d+)\)\s*$/.exec(room);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

class TableStore {
  private state: State | null = null;
  /** Serialises read-modify-write; the portal is single-replica by design. */
  private queue: Promise<unknown> = Promise.resolve();

  private get file(): string {
    return path.join(env.stateDir, "tables.json");
  }

  private async load(): Promise<State> {
    if (this.state) return this.state;
    try {
      const raw = await fs.readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as Partial<State>;
      this.state = {
        tables: Array.isArray(parsed.tables) ? parsed.tables : [],
        users: parsed.users && typeof parsed.users === "object" ? parsed.users : {},
      };
    } catch {
      // Missing or corrupt: start clean. Nothing here is irreplaceable — table
      // names are ephemeral and identities are regenerated on next join.
      this.state = { ...EMPTY, tables: [], users: {} };
    }
    return this.state;
  }

  private async persist(): Promise<void> {
    if (!this.state) return;
    // 0700, not 0777: this directory holds the table registry and every
    // player's SecretName. It is not an isolation boundary against module code
    // (every Player JVM runs as this same uid — Webswing does not switch users
    // per session), but it does keep the state out of reach of any *other* uid
    // that mounts the same NFS export.
    await fs.mkdir(env.stateDir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.state, null, 2), "utf8");
    await fs.rename(tmp, this.file);
  }

  /** Run `fn` with exclusive access to the state. */
  private run<T>(fn: (state: State) => Promise<T> | T): Promise<T> {
    const next = this.queue.then(async () => {
      const state = await this.load();
      const result = await fn(state);
      await this.persist();
      return result;
    });
    // Keep the chain alive even if this operation rejects.
    this.queue = next.catch(() => undefined);
    return next;
  }

  async list(): Promise<Table[]> {
    const state = await this.load();
    return state.tables.filter((t) => t.closedAt === null);
  }

  async get(slot: number): Promise<Table | null> {
    const state = await this.load();
    return state.tables.find((t) => t.slot === slot && t.closedAt === null) ?? null;
  }

  /**
   * Claim the lowest free table number. `occupied` is the set of numbers the
   * lobby feed currently reports players in — a number can never be reused
   * under a live game even if the registry thinks the table is closed.
   */
  async create(
    input: {
      name: string;
      modulePath: string;
      createdBy: string;
      maxSeats?: number;
      spectatorsAllowed?: boolean;
    },
    occupied: ReadonlySet<number>,
  ): Promise<Table> {
    return this.run((state) => {
      const taken = new Set<number>(occupied);
      for (const t of state.tables) if (t.closedAt === null) taken.add(t.slot);

      let slot = 0;
      for (let i = 1; i <= env.maxTables; i += 1) {
        if (!taken.has(i)) {
          slot = i;
          break;
        }
      }
      if (!slot) {
        throw new Error(
          `${env.maxTables} tables are already open — close one, or raise VASSAL_MAX_TABLES`,
        );
      }

      const table: Table = {
        slot,
        name: input.name,
        modulePath: input.modulePath,
        createdBy: input.createdBy,
        createdAt: Date.now(),
        closedAt: null,
        spectators: [],
        maxSeats: input.maxSeats ?? env.defaultMaxSeats,
        spectatorsAllowed: input.spectatorsAllowed ?? true,
        locked: false,
      };
      state.tables.push(table);
      return table;
    });
  }

  /** Record (or clear) that a user is watching rather than playing. */
  async setSpectator(slot: number, username: string, watching: boolean): Promise<void> {
    await this.run((state) => {
      const table = state.tables.find((x) => x.slot === slot && x.closedAt === null);
      if (!table) return;
      const current = new Set(table.spectators ?? []);
      if (watching) current.add(username);
      else current.delete(username);
      table.spectators = [...current];
    });
  }

  /** Update a table's portal-side settings. Returns the updated row. */
  async configure(
    slot: number,
    patch: Partial<Pick<Table, "name" | "maxSeats" | "spectatorsAllowed" | "locked">>,
  ): Promise<Table | null> {
    return this.run((state) => {
      const table = state.tables.find((x) => x.slot === slot && x.closedAt === null);
      if (!table) return null;
      if (patch.name !== undefined) table.name = patch.name;
      if (patch.maxSeats !== undefined) table.maxSeats = patch.maxSeats;
      if (patch.spectatorsAllowed !== undefined) {
        table.spectatorsAllowed = patch.spectatorsAllowed;
      }
      if (patch.locked !== undefined) table.locked = patch.locked;
      return table;
    });
  }

  /** Update a user's own preferences. */
  async updateIdentity(
    username: string,
    patch: Partial<Pick<UserIdentity, "nickname" | "defaultModule" | "spectateByDefault">>,
  ): Promise<UserIdentity> {
    return this.run((state) => {
      const identity = state.users[username] ?? {
        nickname: username,
        secretName: randomBytes(16).toString("hex"),
      };
      if (patch.nickname) identity.nickname = patch.nickname;
      if (patch.defaultModule !== undefined) identity.defaultModule = patch.defaultModule;
      if (patch.spectateByDefault !== undefined) {
        identity.spectateByDefault = patch.spectateByDefault;
      }
      state.users[username] = identity;
      return identity;
    });
  }

  async close(slot: number): Promise<void> {
    await this.run((state) => {
      for (const t of state.tables) {
        if (t.slot === slot && t.closedAt === null) t.closedAt = Date.now();
      }
    });
  }

  /**
   * Retire tables that have been empty long enough, and drop closed rows once
   * nothing references them. Called opportunistically on list/join rather than
   * from a timer — an unobserved portal has nothing to reap for.
   */
  async reap(occupied: ReadonlySet<number>): Promise<void> {
    const now = Date.now();
    await this.run((state) => {
      for (const t of state.tables) {
        if (t.closedAt !== null) continue;
        if (occupied.has(t.slot)) continue;
        if (now - t.createdAt < CREATION_GRACE_MS) continue;
        if (now - t.createdAt < IDLE_REAP_MS) continue;
        t.closedAt = now;
      }
      state.tables = state.tables.filter(
        (t) => t.closedAt === null || now - t.closedAt < 24 * 60 * 60 * 1000,
      );
    });
  }

  /** username → display nickname, for turning lobby names back into accounts. */
  async nicknames(): Promise<Map<string, string>> {
    const state = await this.load();
    return new Map(Object.entries(state.users).map(([u, i]) => [u, i.nickname]));
  }

  /** Stable identity, minted on first use and reused forever after. */
  async identity(username: string, preferredNickname?: string): Promise<UserIdentity> {
    return this.run((state) => {
      let identity = state.users[username];
      if (!identity) {
        identity = {
          nickname: preferredNickname?.trim() || username,
          secretName: randomBytes(16).toString("hex"),
        };
        state.users[username] = identity;
      } else if (preferredNickname && preferredNickname.trim() !== identity.nickname) {
        identity.nickname = preferredNickname.trim();
      }
      return identity;
    });
  }
}

const globalForTables = globalThis as unknown as { __vassalTableStore?: TableStore };
export const tableStore: TableStore = (globalForTables.__vassalTableStore ??= new TableStore());

/**
 * Table names now reach VASSAL — {@link roomNameFor} turns one into a room
 * name — so keep them boring, short, and free of `#`, which would let a player
 * forge the table-number suffix the feed is attributed by.
 */
export function sanitizeTableName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim().replace(/\s+/g, " ");
  if (name.length < 1 || name.length > 40) return null;
  if (!/^[\p{L}\p{N} '’\-!?.:()&]+$/u.test(name)) return null;
  return name;
}
