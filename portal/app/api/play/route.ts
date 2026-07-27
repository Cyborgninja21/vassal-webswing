import { currentIdentity } from "@/lib/identity";
import { findModuleByPath } from "@/lib/catalog";
import { tableStore } from "@/lib/tables";
import { seedPlayerPrefs } from "@/lib/vassal-prefs";
import { adminConsole } from "@/lib/admin-console";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Open a module without joining a table — solo play, or just looking around.
 *
 * This clears `PortalRoom`, so the patched launcher does not connect and the
 * session behaves like stock VASSAL. Without it, opening a game from the
 * catalogue would silently drop the player back into whatever table they last
 * sat at.
 */
export async function POST(req: Request): Promise<Response> {
  const identity = await currentIdentity();
  if (!identity) return new Response("unauthorized", { status: 401 });

  let body: { modulePath?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "expected a JSON body" }, { status: 400 });
  }

  const modulePath = typeof body.modulePath === "string" ? body.modulePath : "";
  const mod = findModuleByPath(modulePath);
  if (!mod) return Response.json({ error: "Unknown game." }, { status: 400 });

  const id = await tableStore.identity(identity.username);
  await seedPlayerPrefs({
    username: identity.username,
    nickname: id.nickname,
    secretName: id.secretName,
    vassalModuleName: mod.vassalModuleName,
    server: null,
    room: null,
    spectator: false,
  });

  // Prefs are read once at JVM start, so a session still pointed at a table has
  // to end for "open on its own" to mean anything.
  for (const session of adminConsole.sessionsFor(identity.username, modulePath)) {
    adminConsole.shutdownSession(session.applicationPath, session.instanceId);
  }

  return Response.json({ launchUrl: modulePath });
}
