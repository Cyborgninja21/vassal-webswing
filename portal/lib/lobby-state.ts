/**
 * Live presence, as reported by the VASSAL lobby.
 *
 * `VASSAL.chat.node.Server -URL <base>` runs a StatusReporter thread that POSTs
 * to `<base>updateConnections` whenever the roster changes (2 s minimum
 * interval, and it only sends when the content actually differs — so this is
 * change-triggered, not polling). The body is a form field `STATUS` holding
 * lines of:
 *
 *     moduleId \t roomId \t playerName \n
 *
 * That is the whole feed: no seat/side, no lock state, no turn number. Anything
 * richer has to come from somewhere else (see the plan's Phase 7 notes).
 *
 * The store is deliberately in-memory: it is a projection of live state that the
 * lobby will re-push in full on the next change, so there is nothing worth
 * persisting and nothing to reconcile after a restart.
 */

export type PresenceRow = {
  module: string;
  room: string;
  player: string;
};

export type LobbyTable = {
  /** Stable within a snapshot; module+room is the natural key the feed gives us. */
  id: string;
  module: string;
  room: string;
  players: string[];
  /** VASSAL drops every client into "Main Room" — that is the hall, not a table. */
  isMainRoom: boolean;
};

export type LobbySnapshot = {
  /** epoch ms of the last accepted push; null means the lobby has never reported. */
  updatedAt: number | null;
  tables: LobbyTable[];
  /** Distinct player names seen anywhere in the feed. */
  playerCount: number;
};

const MAIN_ROOM = "Main Room";

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

export function toSnapshot(rows: PresenceRow[], updatedAt: number | null): LobbySnapshot {
  const byKey = new Map<string, LobbyTable>();
  const players = new Set<string>();

  for (const row of rows) {
    const id = `${row.module} :: ${row.room}`;
    let table = byKey.get(id);
    if (!table) {
      table = {
        id,
        module: row.module,
        room: row.room,
        players: [],
        isMainRoom: row.room === MAIN_ROOM,
      };
      byKey.set(id, table);
    }
    if (!table.players.includes(row.player)) table.players.push(row.player);
    players.add(row.player);
  }

  const tables = [...byKey.values()].sort((a, b) => {
    if (a.isMainRoom !== b.isMainRoom) return a.isMainRoom ? 1 : -1;
    return a.module.localeCompare(b.module) || a.room.localeCompare(b.room);
  });
  for (const t of tables) t.players.sort((a, b) => a.localeCompare(b));

  return { updatedAt, tables, playerCount: players.size };
}

type Listener = (snapshot: LobbySnapshot) => void;

class LobbyStore {
  private snapshot: LobbySnapshot = { updatedAt: null, tables: [], playerCount: 0 };
  private listeners = new Set<Listener>();

  get(): LobbySnapshot {
    return this.snapshot;
  }

  /** Replaces the whole projection — every push carries the complete roster. */
  update(rows: PresenceRow[], at: number = Date.now()): LobbySnapshot {
    this.snapshot = toSnapshot(rows, at);
    for (const listener of this.listeners) {
      try {
        listener(this.snapshot);
      } catch {
        // A wedged subscriber must not stop the others from being notified.
      }
    }
    return this.snapshot;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get subscriberCount(): number {
    return this.listeners.size;
  }
}

// Pinned to globalThis: Next's dev server re-evaluates modules on HMR, and a
// second store would silently split the SSE subscribers from the POST handler.
const globalForLobby = globalThis as unknown as { __vassalLobbyStore?: LobbyStore };
export const lobbyStore: LobbyStore = (globalForLobby.__vassalLobbyStore ??= new LobbyStore());
