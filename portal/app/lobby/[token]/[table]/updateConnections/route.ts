import { lobbyPushResponse } from "@/lib/lobby-push";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Per-table status push. Each table's lobby is started with
 * `-URL http://vassal-portal:3000/lobby/<token>/t<slot>/`, so the slot arrives
 * in the path and attribution needs nothing from the payload.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ token: string; table: string }> },
): Promise<Response> {
  const { token, table } = await ctx.params;
  return lobbyPushResponse(req, token, table);
}
