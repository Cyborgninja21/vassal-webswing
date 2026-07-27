import { adminConsole } from "@/lib/admin-console";
import { findModuleByPath } from "@/lib/catalog";
import { lobbyStore } from "@/lib/lobby-state";
import { seedPlayerPrefs, type TableServer } from "@/lib/vassal-prefs";
import { slotHost, slotPort, tableStore, type Table } from "@/lib/tables";

/**
 * Seat a player at a table.
 *
 * The whole point of Phase 5: a player clicks one button in the portal instead
 * of opening VASSAL's Server Controls, adding a private server by host and
 * port, selecting it, and typing a name and password.
 *
 * Order matters. VASSAL reads its preferences **once, at JVM start**, so:
 *
 *   1. write the prefs, then
 *   2. end any live Player JVM for that module that is pointed somewhere else —
 *      otherwise Webswing's `CONTINUE_FOR_USER` reconnect would hand the player
 *      back the old JVM, still aimed at the previous table, and the seeding
 *      would appear to do nothing, then
 *   3. hand the browser the launch URL.
 *
 * What remains manual, and cannot be automated without forking VASSAL: the
 * player presses **Connect** in Server Controls once, then picks a side. Stock
 * 3.7.24 has no auto-connect — `setDefaultRoomName()` is dead code and the only
 * `setConnected(true)` that fires by itself is behind the welcome wizard's
 * "Play Online" radio, which is itself a click.
 */

export type SeatResult = {
  launchUrl: string;
  table: Table;
  nickname: string;
  /** True when a stale Player JVM had to be ended so the new prefs take effect. */
  restarted: boolean;
  alreadySeated: boolean;
};

export async function seatPlayer(
  username: string,
  table: Table,
  nickname?: string,
): Promise<SeatResult> {
  const mod = findModuleByPath(table.modulePath);
  if (!mod) throw new Error(`unknown module ${table.modulePath}`);

  const identity = await tableStore.identity(username, nickname);

  const server: TableServer = {
    slot: table.slot,
    host: slotHost(table.slot),
    port: slotPort(table.slot),
  };

  await seedPlayerPrefs({
    username,
    nickname: identity.nickname,
    secretName: identity.secretName,
    vassalModuleName: mod.vassalModuleName,
    server,
  });

  // Already at this table? Leave the session alone — that is a reconnect, and
  // killing it would throw away their board position for no reason.
  const here = lobbyStore.get().slots.find((s) => s.slot === table.slot);
  const alreadySeated = Boolean(here?.players.includes(identity.nickname));

  let restarted = false;
  if (!alreadySeated) {
    for (const session of adminConsole.sessionsFor(username, table.modulePath)) {
      if (adminConsole.shutdownSession(session.applicationPath, session.instanceId)) {
        restarted = true;
      }
    }
  }

  return {
    launchUrl: table.modulePath,
    table,
    nickname: identity.nickname,
    restarted,
    alreadySeated,
  };
}
