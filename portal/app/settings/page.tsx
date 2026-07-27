import Link from "next/link";
import { currentIdentity } from "@/lib/identity";
import { CATALOG } from "@/lib/catalog";
import { tableStore } from "@/lib/tables";
import { SettingsForm } from "@/components/settings-form";

export const dynamic = "force-dynamic";

export default async function Settings() {
  const identity = await currentIdentity();
  if (!identity) {
    return (
      <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-6">
        <h1 className="font-display text-3xl text-parchment-100">Not authenticated</h1>
      </main>
    );
  }
  const me = await tableStore.identity(identity.username);

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <header className="border-b border-brass-400/20 pb-5">
        <Link href="/" className="text-xs text-brass-400 underline-offset-4 hover:underline">
          ← back to the portal
        </Link>
        <h1 className="mt-2 font-display text-3xl text-parchment-100">Your settings</h1>
        <p className="mt-1 text-sm text-parchment-500">
          Signed in as {identity.username}.
        </p>
      </header>

      <SettingsForm
        initial={{
          nickname: me.nickname,
          defaultModule: me.defaultModule ?? "",
          spectateByDefault: me.spectateByDefault ?? false,
        }}
        modules={CATALOG.map((m) => ({ path: m.path, title: m.title }))}
      />
    </main>
  );
}
