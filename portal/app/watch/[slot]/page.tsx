import Link from "next/link";
import { notFound } from "next/navigation";
import { currentIdentity } from "@/lib/identity";
import { findModuleByPath } from "@/lib/catalog";
import { tableStore } from "@/lib/tables";

export const dynamic = "force-dynamic";

/**
 * Spectator view.
 *
 * Two independent things keep a watcher from touching the game:
 *
 *  1. **VASSAL's `<observer>` side**, taken automatically by the patched
 *     PlayerRoster. This is the one that matters — it is what hides masked
 *     pieces and private hands, and it is enforced by VASSAL itself.
 *  2. **This page**, which frames the session `inert` with pointer events off,
 *     so a stray click cannot nudge a piece that happens to lack a Restricted
 *     Access trait.
 *
 * The second is a UX guard, not a security boundary — the full game state does
 * reach an observer client, and a determined viewer with dev tools could
 * re-enable input. That is documented and accepted for a trusted homelab; it is
 * why the observer side, not this page, is the real control.
 *
 * Framing works at all only because the portal and Webswing share one hostname:
 * Webswing sends `X-Frame-Options: SAMEORIGIN`.
 */
export default async function Watch({ params }: { params: Promise<{ slot: string }> }) {
  const identity = await currentIdentity();
  if (!identity) {
    return (
      <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-6">
        <h1 className="font-display text-3xl text-parchment-100">Not authenticated</h1>
      </main>
    );
  }

  const slot = Number.parseInt((await params).slot, 10);
  const table = await tableStore.get(slot);
  if (!table) notFound();

  const mod = findModuleByPath(table.modulePath);

  return (
    <main className="flex h-screen flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-brass-400/20 px-4 py-2">
        <p className="text-sm text-parchment-300">
          <span className="rounded bg-brass-600/70 px-2 py-0.5 text-xs uppercase tracking-wide text-parchment-100">
            Spectating
          </span>
          <span className="ml-3 font-display text-lg text-parchment-100">{table.name}</span>
          <span className="ml-2 text-xs text-brass-400">{mod?.title ?? table.modulePath}</span>
        </p>
        <p className="flex items-center gap-4 text-xs text-parchment-500">
          <span>You are watching — the board is read-only.</span>
          <Link href="/" className="text-brass-400 underline-offset-4 hover:underline">
            ← back to the portal
          </Link>
        </p>
      </header>

      {/* inert + pointer-events:none — nothing here reaches the game. */}
      <iframe
        src={table.modulePath}
        title={`${table.name} — spectating`}
        // @ts-expect-error — `inert` is valid HTML; React types lag behind.
        inert=""
        tabIndex={-1}
        className="pointer-events-none flex-1 border-0"
      />
    </main>
  );
}
