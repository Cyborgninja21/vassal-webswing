import fs from "node:fs/promises";
import path from "node:path";
import { currentIdentity } from "@/lib/identity";
import { findModuleByPath } from "@/lib/catalog";
import { env } from "@/lib/env";
import { tableStore } from "@/lib/tables";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NICKNAME_RE = /^[\p{L}\p{N} '’\-_.]{1,24}$/u;

export async function GET(): Promise<Response> {
  const identity = await currentIdentity();
  if (!identity) return new Response("unauthorized", { status: 401 });
  const me = await tableStore.identity(identity.username);
  return Response.json({
    nickname: me.nickname,
    defaultModule: me.defaultModule ?? "",
    spectateByDefault: me.spectateByDefault ?? false,
  });
}

export async function PATCH(req: Request): Promise<Response> {
  const identity = await currentIdentity();
  if (!identity) return new Response("unauthorized", { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "expected a JSON body" }, { status: 400 });
  }

  const patch: Parameters<typeof tableStore.updateIdentity>[1] = {};

  if (typeof body.nickname === "string") {
    const nickname = body.nickname.trim();
    if (!NICKNAME_RE.test(nickname)) {
      return Response.json(
        { error: "Nickname must be 1–24 ordinary characters." },
        { status: 400 },
      );
    }
    patch.nickname = nickname;
  }
  if (typeof body.defaultModule === "string") {
    if (body.defaultModule && !findModuleByPath(body.defaultModule)) {
      return Response.json({ error: "Unknown game." }, { status: 400 });
    }
    patch.defaultModule = body.defaultModule;
  }
  if (typeof body.spectateByDefault === "boolean") {
    patch.spectateByDefault = body.spectateByDefault;
  }

  const updated = await tableStore.updateIdentity(identity.username, patch);
  return Response.json({
    nickname: updated.nickname,
    defaultModule: updated.defaultModule ?? "",
    spectateByDefault: updated.spectateByDefault ?? false,
    // The nickname reaches VASSAL as RealName at the next seating, because
    // preferences are read once at JVM start.
    appliesOn: "next seat",
  });
}

/**
 * Escape hatch: throw away this player's VASSAL preferences.
 *
 * The launch wrapper re-seeds the skeleton on the next start, and the portal
 * rewrites server + identity when they next take a seat — so this is the fix
 * for "VASSAL is behaving oddly" without an operator touching the NAS.
 * Deliberately does NOT touch saved games.
 */
export async function DELETE(): Promise<Response> {
  const identity = await currentIdentity();
  if (!identity) return new Response("unauthorized", { status: 401 });

  const prefs = path.join(env.usersDir, identity.username, ".VASSAL", "prefs");
  let removed = 0;
  try {
    for (const entry of await fs.readdir(prefs)) {
      await fs.rm(path.join(prefs, entry), { force: true });
      removed += 1;
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      return Response.json({ error: (e as Error).message }, { status: 500 });
    }
  }
  return Response.json({ ok: true, removed });
}
