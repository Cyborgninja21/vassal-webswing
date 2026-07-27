/**
 * Live presence, as reported by the VASSAL lobby processes.
 *
 * `VASSAL.chat.node.Server -URL <base>` runs a StatusReporter thread that POSTs
 * to `<base>updateConnections` whenever the roster changes (2 s minimum
 * interval, and only when the content actually differs — change-triggered, not
 * polling). The body is a form field `STATUS` holding lines of:
 *
 *     moduleId \t roomId \t playerName \n
 *
 * Each table runs its own server, so each posts to its own base URL and the
 * slot number comes from the path rather than from the payload. That is the
 * whole feed: no seat/side, no lock state, no turn number.
 *
 * The store is deliberately in-memory: it is a projection of live state that
 * each lobby re-pushes in full on the next change, so there is nothing worth
 * persisting and nothing to reconcile after a restart.
 */

export type PresenceRow = {
  module: string;
  room: string;
  player: string;
};

export type SlotPresence = {
  slot: number;
  /** Module id as the lobby reports it (VASSAL's own module name). */
  module: string | null;
  players: string[];
  updatedAt: number;
};

export type LobbySnapshot = {
  /** epoch ms of the most recent accepted push; null means none ever arrived. */
  updatedAt: number | null;
  slots: SlotPresence[];
  /** Distinct player names across every slot. */
  playerCount: number;
};

/** The shared default lobby (port 5050) — players who launched without a table. */
export const HALL_SLOT = 0;

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
  private bySlot = new Map<number, SlotPresence>();
  private listeners = new Set<Listener>();
  private lastUpdate: number | null = null;

  get(): LobbySnapshot {
    const slots = [...this.bySlot.values()]
      .filter((s) => s.players.length > 0)
      .sort((a, b) => a.slot - b.slot);
    const players = new Set<string>();
    for (const s of slots) for (const p of s.players) players.add(p);
    return { updatedAt: this.lastUpdate, slots, playerCount: players.size };
  }

  /** Which slots currently hold at least one player — the occupancy truth. */
  occupiedSlots(): Set<number> {
    const set = new Set<number>();
    for (const s of this.bySlot.values()) {
      if (s.players.length > 0) set.add(s.slot);
    }
    return set;
  }

  /** Replaces one slot's roster — each push carries that lobby's full roster. */
  update(slot: number, rows: PresenceRow[], at: number = Date.now()): LobbySnapshot {
    const players: string[] = [];
    let moduleId: string | null = null;
    for (const row of rows) {
      moduleId ??= row.module;
      if (!players.includes(row.player)) players.push(row.player);
    }
    players.sort((a, b) => a.localeCompare(b));

    this.bySlot.set(slot, { slot, module: moduleId, players, updatedAt: at });
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
