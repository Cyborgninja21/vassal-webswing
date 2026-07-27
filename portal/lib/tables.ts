import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { env } from "@/lib/env";

/**
 * The table registry.
 *
 * A "table" is one `VASSAL.chat.node.Server` process. VASSAL gives a client no
 * way to choose a room — `setDefaultRoomName()` is dead code in 3.7.24 and the
 * launcher has no room argument — so every client lands in "Main Room" of
 * whichever server its preferences name. Therefore **the server is the table**,
 * and picking a table means pointing the player's prefs at a different port.
 *
 * The lobby processes are a fixed pool declared in compose (`vassal-table-1..N`
 * on ports 5051..505N), not spawned on demand: a dynamic spawner would need the
 * docker socket, which is root on the host, to save ~25 MB per idle slot.
 * Allocating a table is therefore just claiming a free slot.
 *
 * Registry state is a small JSON file on the shared NFS volume. It holds names
 * and ownership only — never occupancy, which always comes live from the lobby
 * feed, so the two can never disagree.
 */

export type Table = {
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

export function slotHost(slot: number): string {
  return env.tableHostPattern.replace("{n}", String(slot));
}

export function slotPort(slot: number): number {
  return env.tablePortBase + slot;
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
   * Claim the lowest free slot. `occupied` is the set of slots the lobby feed
   * currently reports players in — a slot can never be reused under a live game
   * even if the registry thinks it is closed.
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
      for (let i = 1; i <= env.tableSlots; i += 1) {
        if (!taken.has(i)) {
          slot = i;
          break;
        }
      }
      if (!slot) {
        throw new Error(
          `all ${env.tableSlots} tables are in use — close one, or raise VASSAL_TABLE_SLOTS`,
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

/** Table names are shown in the portal only, but keep them boring and short. */
export function sanitizeTableName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim().replace(/\s+/g, " ");
  if (name.length < 1 || name.length > 40) return null;
  if (!/^[\p{L}\p{N} '’\-!?.:()&]+$/u.test(name)) return null;
  return name;
}
