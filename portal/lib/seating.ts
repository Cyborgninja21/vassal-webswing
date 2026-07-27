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
 * All that remains manual is VASSAL's side picker, which is an unconditional
 * modal with no bypass. Connecting and joining the room are handled by the
 * engine patch in patches/Player.java, driven by the `PortalRoom` preference
 * written above.
 */

export type SeatResult = {
  launchUrl: string;
  table: Table;
  nickname: string;
  /** True when a stale Player JVM had to be ended so the new prefs take effect. */
  restarted: boolean;
  alreadySeated: boolean;
  spectator: boolean;
};

export async function seatPlayer(
  username: string,
  table: Table,
  opts: { spectator?: boolean; nickname?: string } = {},
): Promise<SeatResult> {
  const { spectator = false, nickname } = opts;
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
    room: table.name,
    spectator,
  });

  await tableStore.setSpectator(table.slot, username, spectator);

  // Already at this table? Leave the session alone — that is a reconnect, and
  // killing it would throw away their board position for no reason.
  const here = lobbyStore.get().slots.find((s) => s.slot === table.slot);
  // A spectator switching in (or a player switching to watching) must always
  // get a fresh JVM: the side is decided once, at startup.
  const alreadySeated =
    !spectator && Boolean(here?.players.includes(identity.nickname));

  let restarted = false;
  if (!alreadySeated) {
    for (const session of adminConsole.sessionsFor(username, table.modulePath)) {
      if (adminConsole.shutdownSession(session.applicationPath, session.instanceId)) {
        restarted = true;
      }
    }
  }

  return {
    // Spectators go through the portal's watch page, which frames the canvas
    // inert so a stray click cannot reach the board.
    launchUrl: spectator ? `/watch/${table.slot}` : table.modulePath,
    table,
    nickname: identity.nickname,
    restarted,
    alreadySeated,
    spectator,
  };
}
