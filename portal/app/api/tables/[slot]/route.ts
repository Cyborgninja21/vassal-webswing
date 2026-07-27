import { currentIdentity } from "@/lib/identity";
import { tableStore } from "@/lib/tables";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Close a table. Its creator or an operator may retire it; the slot is reused. */
export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ slot: string }> },
): Promise<Response> {
  const identity = await currentIdentity();
  if (!identity) return new Response("unauthorized", { status: 401 });

  const slot = Number.parseInt((await ctx.params).slot, 10);
  const table = await tableStore.get(slot);
  if (!table) return Response.json({ error: "That table is gone." }, { status: 404 });

  if (table.createdBy !== identity.username && !identity.isAdmin) {
    return Response.json(
      { error: "Only the player who opened this table can close it." },
      { status: 403 },
    );
  }

  await tableStore.close(slot);
  return Response.json({ ok: true });
}
