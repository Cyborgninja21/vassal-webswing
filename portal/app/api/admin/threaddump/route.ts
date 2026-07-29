import { adminConsole } from "@/lib/admin-console";
import { currentIdentity } from "@/lib/identity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Thread-dump a live Player JVM. Operators only.
 *
 * The JVMs run with reduced signal handling, so `kill -3` terminates a seat
 * instead of dumping it — this channel (Webswing's `requestThreadDump` /
 * `getThreadDump` admin messages) is the only safe way to see where a laggy
 * session is spending its time.
 *
 * POST asks the instance to produce a dump; it lands asynchronously and its
 * timestamp appears in the session's `threadDumps` within a poll or two.
 * GET without `timestamp` lists what's available; with `timestamp` it returns
 * that dump's text.
 */
export async function POST(req: Request): Promise<Response> {
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

  const sent = adminConsole.requestThreadDump(applicationPath, instanceId);
  if (!sent) {
    return Response.json(
      { error: "The admin-console channel is not connected." },
      { status: 503 },
    );
  }
  return Response.json({ ok: true });
}

export async function GET(req: Request): Promise<Response> {
  const identity = await currentIdentity();
  if (!identity) return new Response("unauthorized", { status: 401 });
  if (!identity.isAdmin) return new Response("forbidden", { status: 403 });

  const url = new URL(req.url);
  const applicationPath = url.searchParams.get("path") ?? "";
  const instanceId = url.searchParams.get("instanceId") ?? "";
  const timestamp = url.searchParams.get("timestamp");
  if (!applicationPath || !instanceId) {
    return Response.json({ error: "path and instanceId required" }, { status: 400 });
  }

  if (!timestamp) {
    const session = (adminConsole.getState().sessions ?? []).find(
      (s) => s.applicationPath === applicationPath && s.instanceId === instanceId,
    );
    if (!session) return Response.json({ error: "no such session" }, { status: 404 });
    return Response.json({ threadDumps: session.threadDumps });
  }

  const ts = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(ts) || ts <= 0) {
    return Response.json({ error: "timestamp must be the number the listing gave" }, { status: 400 });
  }
  const content = await adminConsole.fetchThreadDump(applicationPath, instanceId, ts);
  if (content === null) {
    return Response.json(
      { error: "Webswing did not return that dump — wrong timestamp, or the channel is down." },
      { status: 502 },
    );
  }
  return Response.json({ content });
}
