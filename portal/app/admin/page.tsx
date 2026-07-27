import Link from "next/link";
import { currentIdentity } from "@/lib/identity";
import { OperatorConsole } from "@/components/operator-console";

export const dynamic = "force-dynamic";

/**
 * Operator controls. Everything here rides the one admin-console WebSocket the
 * portal already holds — Webswing has no session REST API.
 */
export default async function Admin() {
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
        <Link href="/" className="text-xs text-brass-400 underline-offset-4 hover:underline">
          ← back to the portal
        </Link>
        <h1 className="mt-2 font-display text-3xl text-parchment-100">Operator console</h1>
        <p className="mt-1 text-sm text-parchment-500">
          Live Player JVMs and capacity headroom, straight from Webswing.
        </p>
      </header>
      <OperatorConsole />
    </main>
  );
}
