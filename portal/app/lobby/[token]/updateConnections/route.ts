import { lobbyPushResponse } from "@/lib/lobby-push";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The shared default lobby (port 5050) — players who launched without a table. */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await ctx.params;
  return lobbyPushResponse(req, token, null);
}
