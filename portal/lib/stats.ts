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
 *
 * A second line per busy app carries Webswing's **own** latency breakdown.
 * Measured 2026-07-28: the interface feels laggy at roughly 10 fps under a
 * drag, while the browser held a clean 60 fps, the network was 2.6 ms and the
 * server sat at 1 % CPU — so the cost is inside the pipeline, and the only way
 * to say *where* is to ask Webswing, which has been measuring it all along.
 */
const INTERVAL_MS = 60_000;

/**
 * The metrics worth a dashboard panel. `latency` is the total; the three
 * `latency*` components below it are what make the total actionable.
 * Everything Webswing reports is kept in the log line, but these are the ones
 * whose absence would be a bug.
 */
const LATENCY_METRICS = [
  "latency",
  "latencyServerRendering",
  "latencyNetworkTransfer",
  "latencyClientRendering",
  "latencyPing",
  "edtThreadBlockedForSeconds",
  "inboundSize",
  "outboundSize",
  "memoryUsed",
  "cpuUtilization",
] as const;

/** logfmt keys must be bare; Webswing's metric names already are. */
function fmt(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

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

      // One line per app that actually has something running. An app with no
      // sessions has no meaningful latency, and emitting zeroes for it would
      // drag every dashboard average toward nothing.
      for (const path of adminConsole.statPaths()) {
        const s = adminConsole.statsFor(path);
        if (!s || s.running < 1) continue;
        const fields = LATENCY_METRICS.filter((m) => m in s.metrics)
          .map((m) => `${m}=${fmt(s.metrics[m])}`)
          .join(" ");
        console.log(
          `vassal_webswing_perf app=${path} running=${s.running} ` +
            `connected=${s.connected} ${fields}`.trimEnd(),
        );
        // Webswing raises these itself (latency over 700 ms, EDT blocked over
        // 10 s, heap over 80 %) — it is a real signal and nothing was reading it.
        for (const w of s.warnings) {
          console.warn(`vassal_webswing_warning app=${path} warning="${w}"`);
        }
      }
    } catch {
      // Never let telemetry take the portal down.
    }
  };

  g.__vassalStatsTimer = setInterval(emit, INTERVAL_MS);
  void emit();
}
