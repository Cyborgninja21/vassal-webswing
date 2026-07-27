import Link from "next/link";
import { currentIdentity } from "@/lib/identity";
import { ModuleManager } from "@/components/module-manager";

export const dynamic = "force-dynamic";

/**
 * Module administration.
 *
 * Operators only — and not merely because the UI is hidden: every route behind
 * it re-checks the group server-side. Publishing a module means running its
 * code in the container, so this is the one control the whole design leans on.
 */
export default async function AdminModules() {
  const identity = await currentIdentity();
  if (!identity?.isAdmin) {
    return (
      <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-6">
        <h1 className="font-display text-3xl text-parchment-100">Operators only</h1>
        <p className="mt-3 text-sm text-parchment-500">
          This page needs an operator group.{" "}
          <Link href="/" className="text-brass-400 underline-offset-4 hover:underline">
            Back to the portal
          </Link>
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <header className="border-b border-brass-400/20 pb-5">
        <Link href="/admin" className="text-xs text-brass-400 underline-offset-4 hover:underline">
          ← operator console
        </Link>
        <h1 className="mt-2 font-display text-3xl text-parchment-100">Modules</h1>
        <p className="mt-1 text-sm text-parchment-500">
          Add a game from a ZIP. It is validated, hashed and published without a restart or a
          redeploy.
        </p>
      </header>
      <ModuleManager />
    </main>
  );
}
