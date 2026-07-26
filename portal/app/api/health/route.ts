export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Liveness only — deliberately unauthenticated so the container healthcheck can
 * reach it without forging identity headers. It reports nothing about users.
 */
export async function GET(): Promise<Response> {
  return Response.json({ ok: true, service: "vassal-portal" });
}
