import { adminConsole } from "@/lib/admin-console";
import { currentIdentity } from "@/lib/identity";
import { buildPortalState } from "@/lib/portal-state";
import { viewerOf } from "@/lib/viewer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One-shot snapshot of the same payload /api/stream pushes. */
export async function GET(): Promise<Response> {
  const identity = await currentIdentity();
  if (!identity) return new Response("unauthorized", { status: 401 });

  adminConsole.start();
  return Response.json(await buildPortalState(await viewerOf(identity)), {
    headers: { "cache-control": "no-store" },
  });
}
