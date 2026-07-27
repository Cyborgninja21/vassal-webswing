import { currentIdentity } from "@/lib/identity";
import { tableStore } from "@/lib/tables";
import { seatPlayer } from "@/lib/seating";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Seat the caller at an existing table. */
export async function POST(
  _req: Request,
  ctx: { params: Promise<{ slot: string }> },
): Promise<Response> {
  const identity = await currentIdentity();
  if (!identity) return new Response("unauthorized", { status: 401 });

  const slot = Number.parseInt((await ctx.params).slot, 10);
  if (!Number.isFinite(slot)) {
    return Response.json({ error: "bad table" }, { status: 400 });
  }

  const table = await tableStore.get(slot);
  if (!table) return Response.json({ error: "That table is gone." }, { status: 404 });

  try {
    return Response.json(await seatPlayer(identity.username, table));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
