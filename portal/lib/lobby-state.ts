import { tableNumberFromRoom } from "@/lib/tables";

/**
 * Live presence, as reported by the VASSAL lobby process.
 *
 * `VASSAL.chat.node.Server -URL <base>` runs a StatusReporter thread that POSTs
 * to `<base>updateConnections` whenever the roster changes (2 s minimum
 * interval, and only when the content actually differs — change-triggered, not
 * polling). The body is a form field `STATUS` holding lines of:
 *
 *     moduleId \t roomId \t playerName \n
 *
 * There is **one** lobby, so one push carries every room of every module and
 * each push replaces the whole picture. Rooms are the unit here: a table is a
 * room whose name ends in the portal's `(#n)` suffix, and everything else —
 * "Main Room", plus any room a player made by hand in VASSAL's own controls —
 * is someone who is connected but not at a table.
 *
 * That is the whole feed: no seat/side, no lock state, no turn number.
 *
 * The store is deliberately in-memory: it is a projection of live state the
 * lobby re-pushes in full on the next change, so there is nothing worth
 * persisting and nothing to reconcile after a restart.
 */

export type PresenceRow = {
  module: string;
  room: string;
  player: string;
};

export type RoomPresence = {
  /** Module id as the lobby reports it (VASSAL's own module name). */
  module: string;
  /** Room name exactly as VASSAL has it, `(#n)` suffix and all. */
  room: string;
  /** Table number parsed out of the room name; null for rooms we did not name. */
  table: number | null;
  players: string[];
};

export type LobbySnapshot = {
  /** epoch ms of the most recent accepted push; null means none ever arrived. */
  updatedAt: number | null;
  rooms: RoomPresence[];
  /** Distinct player names across every room. */
  playerCount: number;
};

export function parseStatus(body: string): PresenceRow[] {
  const rows: PresenceRow[] = [];
  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const [module, room, ...rest] = parts;
    // Player names cannot contain a tab (the reporter would corrupt its own
    // format), but rejoin defensively rather than dropping information.
    const player = rest.join("\t").trim();
    if (!module.trim() || !room.trim() || !player) continue;
    rows.push({ module: module.trim(), room: room.trim(), player });
  }
  return rows;
}

type Listener = (snapshot: LobbySnapshot) => void;

class LobbyStore {
  private rooms: RoomPresence[] = [];
  private listeners = new Set<Listener>();
  private lastUpdate: number | null = null;

  get(): LobbySnapshot {
    const players = new Set<string>();
    for (const r of this.rooms) for (const p of r.players) players.add(p);
    return { updatedAt: this.lastUpdate, rooms: this.rooms, playerCount: players.size };
  }

  /** Which table numbers hold at least one player — the occupancy truth. */
  occupiedTables(): Set<number> {
    const set = new Set<number>();
    for (const r of this.rooms) {
      if (r.table !== null && r.players.length > 0) set.add(r.table);
    }
    return set;
  }

  /** Everyone at table `n`, whatever module the row claims. */
  playersAt(table: number): string[] {
    for (const r of this.rooms) if (r.table === table) return r.players;
    return [];
  }

  /** Connected, but not at a table: Main Room and any hand-made room. */
  hall(): string[] {
    const names = new Set<string>();
    for (const r of this.rooms) {
      if (r.table === null) for (const p of r.players) names.add(p);
    }
    return [...names].sort((a, b) => a.localeCompare(b));
  }

  /** Replaces the entire picture — every push carries the lobby's full roster. */
  update(rows: PresenceRow[], at: number = Date.now()): LobbySnapshot {
    const byRoom = new Map<string, RoomPresence>();
    for (const row of rows) {
      const key = `${row.module}\t${row.room}`;
      let entry = byRoom.get(key);
      if (!entry) {
        entry = {
          module: row.module,
          room: row.room,
          table: tableNumberFromRoom(row.room),
          players: [],
        };
        byRoom.set(key, entry);
      }
      if (!entry.players.includes(row.player)) entry.players.push(row.player);
    }

    this.rooms = [...byRoom.values()]
      .filter((r) => r.players.length > 0)
      .map((r) => ({ ...r, players: r.players.sort((a, b) => a.localeCompare(b)) }))
      .sort((a, b) => (a.table ?? Infinity) - (b.table ?? Infinity) || a.room.localeCompare(b.room));
    this.lastUpdate = at;

    const snapshot = this.get();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // A wedged subscriber must not stop the others from being notified.
      }
    }
    return snapshot;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

// Pinned to globalThis: Next's dev server re-evaluates modules on HMR, and a
// second store would silently split the SSE subscribers from the POST handler.
const globalForLobby = globalThis as unknown as { __vassalLobbyStore?: LobbyStore };
export const lobbyStore: LobbyStore = (globalForLobby.__vassalLobbyStore ??= new LobbyStore());
