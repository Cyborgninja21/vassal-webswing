/**
 * Next runs this once per server process, before the first request. Opening the
 * Webswing admin-console connection here means the session view is warm on the
 * first page load instead of on the first SSE subscriber.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { adminConsole } = await import("@/lib/admin-console");
  adminConsole.start();
  const { startStatsLogger } = await import("@/lib/stats");
  startStatsLogger();
}
