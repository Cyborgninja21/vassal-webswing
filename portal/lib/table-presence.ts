import { findModuleByLobbyId } from "@/lib/catalog";
import { lobbyStore } from "@/lib/lobby-state";
import type { Table } from "@/lib/tables";

/**
 * Who is actually at a table, according to the lobby.
 *
 * The table number in the room name is enough to *find* a room, but not enough
 * to trust it. VASSAL namespaces rooms per module (`moduleName/roomName`), so
 * two modules can each hold a room whose name ends in the same `(#n)` — and
 * merging them would show one table's players sitting at another's.
 *
 * Found live on 2026-07-28: one player opened two tables before launching
 * either, so both JVMs read the same `PortalRoom` pref and joined identically
 * named rooms in two different modules. The portal showed them as one table.
 *
 * So the number narrows and the module decides. A room whose module id matches
 * nothing in the catalog is accepted rather than dropped — that is a module
 * present in Webswing but not yet described, which should degrade to a visible
 * table rather than an invisible one.
 */
export function playersAtTable(table: Pick<Table, "slot" | "modulePath">): string[] {
  for (const room of lobbyStore.get().rooms) {
    if (room.table !== table.slot) continue;
    const mod = findModuleByLobbyId(room.module);
    if (mod && mod.path !== table.modulePath) continue;
    return room.players;
  }
  return [];
}
