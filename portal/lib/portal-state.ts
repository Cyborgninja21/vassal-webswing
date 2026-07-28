import { allModules, findModuleByPath } from "@/lib/catalog";
import { lobbyStore } from "@/lib/lobby-state";
import { adminConsole } from "@/lib/admin-console";
import { env } from "@/lib/env";
import { tableStore } from "@/lib/tables";

/**
 * The single shape the UI renders, composed from three sources:
 *
 *  - the table registry — names, module, who created them (portal-owned);
 *  - the lobby's status push — who is actually sitting in which room, and so
 *    at which table (the room name carries the table number);
 *  - Webswing's admin console — who has a Player JVM running, which catches
 *    people who have launched but not yet pressed Connect.
 *
 * Occupancy is never read from the registry: it always comes live from the
 * lobby feed, so the two cannot drift apart.
 */

export type TableView = {
  slot: number;
  name: string;
  moduleTitle: string;
  modulePath: string;
  createdBy: string;
  players: string[];
  /** Present, but watching as observers rather than playing. */
  spectators: string[];
  /** Users with a live Player JVM for this module but not yet seated anywhere. */
  arriving: string[];
  maxSeats: number;
  spectatorsAllowed: boolean;
  locked: boolean;
};

export type ModuleView = {
  path: string;
  title: string;
  subtitle: string;
  description: string;
  motif: string;
  /** Short labels for the tile — whatever is known about this module. */
  facts: string[];
  /** True for operator-ingested modules; built-ins are false. */
  ingested: boolean;
  activeUsers: string[];
};

export type PortalState = {
  generatedAt: number;
  lobby: {
    updatedAt: number | null;
    reporting: boolean;
    playerCount: number;
  };
  sessions: {
    available: boolean;
    connected: boolean;
    error: string | null;
  };
  tables: TableView[];
  /** Players connected to the shared default lobby rather than a table. */
  hall: string[];
  modules: ModuleView[];
  capacity: { used: number; total: number };
  /** Live Player JVMs against the portal's own ceiling. */
  seats: { used: number; total: number };
  viewer: { isAdmin: boolean; defaultModule: string; spectateByDefault: boolean };
};

export async function buildPortalState(
  viewer: { isAdmin: boolean; defaultModule: string; spectateByDefault: boolean } = {
    isAdmin: false,
    defaultModule: "",
    spectateByDefault: false,
  },
): Promise<PortalState> {
  const lobby = lobbyStore.get();
  const admin = adminConsole.getState();
  const registry = await tableStore.list();

  const playersBySlot = new Map<number, string[]>();
  for (const room of lobby.rooms) {
    if (room.table !== null) playersBySlot.set(room.table, room.players);
  }

  const usersByPath = new Map<string, Set<string>>();
  for (const session of admin.sessions ?? []) {
    if (!session.user) continue;
    const set = usersByPath.get(session.applicationPath) ?? new Set<string>();
    set.add(session.user);
    usersByPath.set(session.applicationPath, set);
  }

  // Anyone already seated somewhere is not "arriving" anywhere.
  const seated = new Set<string>();
  for (const players of playersBySlot.values()) for (const p of players) seated.add(p);

  const nicknameFor = await tableStore.nicknames();
  const sorted = [...registry].sort((a, b) => a.slot - b.slot);
  const tables: TableView[] = sorted.map((table) => {
    const mod = findModuleByPath(table.modulePath);
    // A Player JVM on the right module whose owner is in no lobby yet is most
    // likely mid-launch for this table — but only say so when one table for
    // that module exists, otherwise it is a guess.
    const soleTableForModule =
      sorted.filter((t) => t.modulePath === table.modulePath).length === 1;
    const candidates = [...(usersByPath.get(table.modulePath) ?? [])].filter(
      (u) => !seated.has(u),
    );
    // The lobby feed reports names, not roles, so the registry is what tells a
    // watcher apart from a player.
    const present = playersBySlot.get(table.slot) ?? [];
    const watchingNicks = new Set(
      (table.spectators ?? []).map((u) => nicknameFor.get(u) ?? u),
    );
    return {
      slot: table.slot,
      name: table.name,
      moduleTitle: mod?.title ?? table.modulePath,
      modulePath: table.modulePath,
      createdBy: table.createdBy,
      players: present.filter((n) => !watchingNicks.has(n)),
      spectators: present.filter((n) => watchingNicks.has(n)),
      arriving: soleTableForModule ? candidates.sort((a, b) => a.localeCompare(b)) : [],
      maxSeats: table.maxSeats ?? env.defaultMaxSeats,
      spectatorsAllowed: table.spectatorsAllowed !== false,
      locked: table.locked === true,
    };
  });

  const modules: ModuleView[] = allModules().map((mod) => ({
    path: mod.path,
    title: mod.title,
    subtitle: mod.subtitle,
    description: mod.description,
    motif: mod.motif,
    facts: mod.facts,
    ingested: mod.ingested,
    activeUsers: [...(usersByPath.get(mod.path) ?? [])].sort((a, b) => a.localeCompare(b)),
  }));

  return {
    generatedAt: Date.now(),
    lobby: {
      updatedAt: lobby.updatedAt,
      reporting: lobby.updatedAt !== null,
      playerCount: lobby.playerCount,
    },
    sessions: {
      available: admin.sessions !== null,
      connected: admin.connected,
      error: admin.lastError,
    },
    tables,
    hall: lobbyStore.hall(),
    modules,
    capacity: { used: tables.length, total: env.maxTables },
    seats: { used: (admin.sessions ?? []).length, total: env.maxConcurrentSeats },
    viewer,
  };
}
