/**
 * Next runs this once per server process, before the first request. Opening the
 * Webswing admin-console connection here means the session view is warm on the
 * first page load instead of on the first SSE subscriber.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // The module registry loads first: it is the synchronous snapshot every
  // catalog lookup reads, so an empty one would briefly hide ingested modules.
  const { moduleRegistry } = await import("@/lib/modules");
  await moduleRegistry.reload();

  const { adminConsole } = await import("@/lib/admin-console");
  adminConsole.start();

  // Re-publish ingested modules once the admin channel has had a moment to come
  // up. Webswing's config can drift from the store — restored from the image
  // default, or a module ingested while the Webswing container was down — and
  // `saveConfig` overwrites by path, so reconciling is idempotent and removes a
  // whole class of "the tile is there but the URL 404s".
  const { reconcilePublishedModules } = await import("@/lib/webswing-app");
  setTimeout(() => void reconcilePublishedModules(), 5_000);

  const { startStatsLogger } = await import("@/lib/stats");
  startStatsLogger();
}
