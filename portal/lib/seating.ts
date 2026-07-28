import { adminConsole } from "@/lib/admin-console";
import { findModuleByPath } from "@/lib/catalog";
import { lobbyStore } from "@/lib/lobby-state";
import { seedPlayerPrefs, type TableServer } from "@/lib/vassal-prefs";
import { env } from "@/lib/env";
import { roomNameFor, tableStore, type Table } from "@/lib/tables";

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

/**
 * Refuse a seat the portal knows it cannot honour, *before* Webswing's
 * `maxClients` does. VASSAL's own room lock is cosmetic — its password is a
 * value the server already broadcasts — so these are the real gate, and they
 * are checked here, server-side, on every seating request rather than in the UI.
 */
export async function checkSeatingAllowed(
  username: string,
  table: Table,
  spectator: boolean,
): Promise<string | null> {
  const identity = await tableStore.identity(username);
  const present = lobbyStore.playersAt(table.slot);
  const alreadyHere = present.includes(identity.nickname);

  // Someone already at the table is always allowed back — that is a reconnect.
  if (alreadyHere) return null;

  if (spectator && table.spectatorsAllowed === false) {
    return "The host has turned off spectators for this table.";
  }
  if (!spectator && table.locked) {
    return "That table is locked. Ask the host to unlock it.";
  }
  if (!spectator) {
    const watching = new Set(
      (table.spectators ?? []).map((u) => u),
    );
    const seatsTaken = present.length - watching.size;
    const cap = table.maxSeats ?? env.defaultMaxSeats;
    if (seatsTaken >= cap) {
      return `That table is full (${cap} seat${cap === 1 ? "" : "s"}).`;
    }
  }

  // Whole-stack ceiling: every seat is a ~600 MB JVM.
  const live = (adminConsole.getState().sessions ?? []).length;
  if (live >= env.maxConcurrentSeats && !adminConsole.sessionsFor(username).length) {
    return `The server is at capacity (${env.maxConcurrentSeats} live games). Try again shortly.`;
  }

  return openGamesRefusal(username, table.modulePath);
}

/**
 * The per-person ceiling on *different* games open at once.
 *
 * Removing the eight-table cap made this the constraint that binds. A Player
 * JVM is ~500 MB and outlives the browser tab, so one person clicking through
 * the catalogue can hold most of the stack without meaning to.
 *
 * Counted per module rather than per table: Webswing's `CONTINUE_FOR_USER`
 * hands the same user their existing session back for a module they already
 * have open, so a second table of the same game costs nothing extra.
 *
 * Separate from {@link checkSeatingAllowed} because opening a table, joining
 * one and launching a module on its own all start a JVM, and only the middle
 * one has a table to check.
 */
export function openGamesRefusal(username: string, modulePath: string): string | null {
  const mine = new Set(adminConsole.sessionsFor(username).map((s) => s.applicationPath));
  if (!mine.has(modulePath) && mine.size >= env.maxSeatsPerUser) {
    return `You already have ${mine.size} game${mine.size === 1 ? "" : "s"} open, which is the limit. Close one first — the table list has a Leave button.`;
  }
  return null;
}

export async function seatPlayer(
  username: string,
  table: Table,
  opts: { spectator?: boolean; nickname?: string } = {},
): Promise<SeatResult> {
  const { spectator = false, nickname } = opts;
  const mod = findModuleByPath(table.modulePath);
  if (!mod) throw new Error(`unknown module ${table.modulePath}`);

  const identity = await tableStore.identity(username, nickname);

  // One lobby for everybody; the table is the room inside it.
  const server: TableServer = { host: env.lobbyHost, port: env.lobbyPort };

  await seedPlayerPrefs({
    username,
    nickname: identity.nickname,
    secretName: identity.secretName,
    vassalModuleName: mod.vassalModuleName,
    server,
    room: roomNameFor(table),
    spectator,
  });

  await tableStore.setSpectator(table.slot, username, spectator);

  // Already at this table? Leave the session alone — that is a reconnect, and
  // killing it would throw away their board position for no reason.
  // A spectator switching in (or a player switching to watching) must always
  // get a fresh JVM: the side is decided once, at startup.
  const alreadySeated =
    !spectator && lobbyStore.playersAt(table.slot).includes(identity.nickname);

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
