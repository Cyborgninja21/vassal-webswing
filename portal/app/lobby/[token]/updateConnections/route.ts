import { lobbyPushResponse } from "@/lib/lobby-push";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The lobby's status push. One process, one URL: the payload names the module
 * and room of every connected player, and tables are rooms.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await ctx.params;
  return lobbyPushResponse(req, token);
}
