import { CATALOG, findModuleByLobbyId } from "@/lib/catalog";
import { lobbyStore } from "@/lib/lobby-state";
import { adminConsole } from "@/lib/admin-console";

/**
 * The single shape the UI renders, composed from the two live sources:
 *
 *  - the VASSAL lobby's `-URL` push — who is in which room of which module;
 *  - Webswing's admin console — who has a Player JVM running, which catches
 *    people who have launched a module but not yet reached the lobby.
 *
 * Either source may be unavailable; the view degrades rather than failing.
 */

export type TableView = {
  id: string;
  room: string;
  moduleTitle: string;
  modulePath: string | null;
  players: string[];
  isMainRoom: boolean;
};

export type ModuleView = {
  path: string;
  title: string;
  subtitle: string;
  era: string;
  players: string;
  playTime: string;
  designer: string;
  publisher: string;
  description: string;
  motif: string;
  /** Distinct usernames with a live Webswing session on this module. */
  activeUsers: string[];
};

export type PortalState = {
  generatedAt: number;
  lobby: {
    updatedAt: number | null;
    /** The lobby has reported at least once — i.e. the feed is wired up. */
    reporting: boolean;
    playerCount: number;
  };
  sessions: {
    available: boolean;
    connected: boolean;
    error: string | null;
  };
  tables: TableView[];
  hall: string[];
  modules: ModuleView[];
};

export function buildPortalState(): PortalState {
  const lobby = lobbyStore.get();
  const admin = adminConsole.getState();

  const tables: TableView[] = [];
  let hall: string[] = [];

  for (const table of lobby.tables) {
    if (table.isMainRoom) {
      hall = [...new Set([...hall, ...table.players])].sort((a, b) => a.localeCompare(b));
      continue;
    }
    const mod = findModuleByLobbyId(table.module);
    tables.push({
      id: table.id,
      room: table.room,
      moduleTitle: mod?.title ?? table.module,
      modulePath: mod?.path ?? null,
      players: table.players,
      isMainRoom: false,
    });
  }

  const usersByPath = new Map<string, Set<string>>();
  for (const session of admin.sessions ?? []) {
    if (!session.user) continue;
    const set = usersByPath.get(session.applicationPath) ?? new Set<string>();
    set.add(session.user);
    usersByPath.set(session.applicationPath, set);
  }

  const modules: ModuleView[] = CATALOG.map((mod) => ({
    path: mod.path,
    title: mod.title,
    subtitle: mod.subtitle,
    era: mod.era,
    players: mod.players,
    playTime: mod.playTime,
    designer: mod.designer,
    publisher: mod.publisher,
    description: mod.description,
    motif: mod.motif,
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
    hall,
    modules,
  };
}
