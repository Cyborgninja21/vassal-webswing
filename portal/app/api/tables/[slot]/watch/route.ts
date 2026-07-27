import { currentIdentity } from "@/lib/identity";
import { tableStore } from "@/lib/tables";
import { seatPlayer } from "@/lib/seating";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Watch a table: same seating path, but as VASSAL's `<observer>` side. */
export async function POST(
  _req: Request,
  ctx: { params: Promise<{ slot: string }> },
): Promise<Response> {
  const identity = await currentIdentity();
  if (!identity) return new Response("unauthorized", { status: 401 });

  const slot = Number.parseInt((await ctx.params).slot, 10);
  const table = await tableStore.get(slot);
  if (!table) return Response.json({ error: "That table is gone." }, { status: 404 });

  try {
    return Response.json(await seatPlayer(identity.username, table, { spectator: true }));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
