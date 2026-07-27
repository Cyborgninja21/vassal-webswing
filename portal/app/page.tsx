import Link from "next/link";
import { adminConsole } from "@/lib/admin-console";
import { currentIdentity } from "@/lib/identity";
import { buildPortalState } from "@/lib/portal-state";
import { tableStore } from "@/lib/tables";
import { LiveBoard } from "@/components/live-board";

export const dynamic = "force-dynamic";

export default async function Home() {
  const identity = await currentIdentity();

  // There is no login page: the only way in is through Traefik's forward-auth,
  // so an unauthenticated request means the proxy was bypassed.
  if (!identity) {
    return (
      <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-6">
        <h1 className="font-display text-3xl text-parchment-100">Not authenticated</h1>
        <p className="mt-3 text-parchment-300">
          Reach this portal through its public URL so single sign-on can identify you.
        </p>
      </main>
    );
  }

  adminConsole.start();
  const me = await tableStore.identity(identity.username);
  const initial = await buildPortalState({
    isAdmin: identity.isAdmin,
    defaultModule: me.defaultModule ?? "",
    spectateByDefault: me.spectateByDefault ?? false,
  });

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-brass-400/20 pb-6">
        <div>
          <h1 className="font-display text-4xl tracking-tight text-parchment-100">
            The Card Room
          </h1>
          <p className="mt-1 text-sm text-parchment-500">
            VASSAL modules, in your browser. Pick a game to take a seat.
          </p>
        </div>
        <div className="text-right text-xs text-parchment-500">
          <p>
            signed in as <span className="text-parchment-300">{identity.username}</span>
            {identity.isAdmin ? <span className="ml-2 text-brass-400">operator</span> : null}
          </p>
          <nav className="mt-1 flex justify-end gap-3">
            <Link href="/settings" className="text-brass-400 underline-offset-4 hover:underline">
              settings
            </Link>
            {identity.isAdmin ? (
              <Link href="/admin" className="text-brass-400 underline-offset-4 hover:underline">
                operator console
              </Link>
            ) : null}
          </nav>
        </div>
      </header>

      <LiveBoard initial={initial} username={identity.username} />

      <footer className="mt-16 border-t border-brass-400/10 pt-6 text-xs text-parchment-500">
        Saves and preferences follow your account — close the tab and come back to
        the same seat.
      </footer>
    </main>
  );
}
