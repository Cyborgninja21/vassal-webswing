import { adminConsole } from "@/lib/admin-console";
import { lobbyStore } from "@/lib/lobby-state";
import { moduleRegistry } from "@/lib/modules";
import { tableStore } from "@/lib/tables";

/**
 * Periodic one-line snapshot of platform occupancy, for the Grafana dashboard.
 *
 * Logged rather than exposed as a scrape target on purpose: the container's
 * stdout already reaches Loki through the fleet pipeline, so this needs no new
 * scrape config, no new port and no new firewall consideration. Dashboard only
 * — nobody is paged for a board game (ADR-059).
 */
const INTERVAL_MS = 60_000;

export function startStatsLogger(): void {
  const g = globalThis as unknown as { __vassalStatsTimer?: NodeJS.Timeout };
  if (g.__vassalStatsTimer) return;

  const emit = async () => {
    try {
      const tables = await tableStore.list();
      const lobby = lobbyStore.get();
      const spectators = new Set<string>();
      for (const t of tables) for (const s of t.spectators ?? []) spectators.add(s);
      const seats = (adminConsole.getState().sessions ?? []).length;

      // Keyed key=value so Loki's logfmt parser picks it up without a regex.
      console.log(
        `vassal_portal_stats tables=${tables.length} seats=${seats} ` +
          `present=${lobby.playerCount} spectators=${spectators.size} ` +
          `modules=${moduleRegistry.enabled().length} ` +
          `modulebytes=${moduleRegistry.bytesOnDisk()}`,
      );
    } catch {
      // Never let telemetry take the portal down.
    }
  };

  g.__vassalStatsTimer = setInterval(emit, INTERVAL_MS);
  void emit();
}
