import { adminConsole } from "@/lib/admin-console";
import { currentIdentity } from "@/lib/identity";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Every live Player JVM, with capacity headroom. Operators only. */
export async function GET(): Promise<Response> {
  const identity = await currentIdentity();
  if (!identity) return new Response("unauthorized", { status: 401 });
  if (!identity.isAdmin) return new Response("forbidden", { status: 403 });

  const state = adminConsole.getState();
  const sessions = state.sessions ?? [];
  return Response.json({
    connected: state.connected,
    error: state.lastError,
    updatedAt: state.updatedAt,
    capacity: { used: sessions.length, total: env.maxConcurrentSeats },
    sessions,
  });
}

/** Kill a stuck seat. */
export async function DELETE(req: Request): Promise<Response> {
  const identity = await currentIdentity();
  if (!identity) return new Response("unauthorized", { status: 401 });
  if (!identity.isAdmin) return new Response("forbidden", { status: 403 });

  let body: { instanceId?: unknown; applicationPath?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "expected a JSON body" }, { status: 400 });
  }
  const instanceId = typeof body.instanceId === "string" ? body.instanceId : "";
  const applicationPath =
    typeof body.applicationPath === "string" ? body.applicationPath : "";
  if (!instanceId || !applicationPath) {
    return Response.json({ error: "instanceId and applicationPath required" }, { status: 400 });
  }

  const sent = adminConsole.shutdownSession(applicationPath, instanceId);
  if (!sent) {
    return Response.json(
      { error: "The admin-console channel is not connected." },
      { status: 503 },
    );
  }
  return Response.json({ ok: true });
}
