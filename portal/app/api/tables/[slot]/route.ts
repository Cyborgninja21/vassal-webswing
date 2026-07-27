import { currentIdentity } from "@/lib/identity";
import { sanitizeTableName, tableStore } from "@/lib/tables";
import { env } from "@/lib/env";

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

/**
 * Per-table settings. The host (or an operator) owns them, and they are the
 * real access gate — VASSAL's own room lock is cosmetic, since its password is
 * a value the server already broadcasts to the module.
 */
export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ slot: string }> },
): Promise<Response> {
  const identity = await currentIdentity();
  if (!identity) return new Response("unauthorized", { status: 401 });

  const slot = Number.parseInt((await ctx.params).slot, 10);
  const table = await tableStore.get(slot);
  if (!table) return Response.json({ error: "That table is gone." }, { status: 404 });
  if (table.createdBy !== identity.username && !identity.isAdmin) {
    return Response.json(
      { error: "Only the player who opened this table can change it." },
      { status: 403 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "expected a JSON body" }, { status: 400 });
  }

  const patch: Parameters<typeof tableStore.configure>[1] = {};
  if (typeof body.name === "string") {
    const name = sanitizeTableName(body.name);
    if (!name) {
      return Response.json(
        { error: "Table name must be 1–40 characters of ordinary text." },
        { status: 400 },
      );
    }
    patch.name = name;
  }
  if (body.maxSeats !== undefined) {
    const seats = Number(body.maxSeats);
    if (!Number.isInteger(seats) || seats < 1 || seats > env.maxConcurrentSeats) {
      return Response.json(
        { error: `Seats must be between 1 and ${env.maxConcurrentSeats}.` },
        { status: 400 },
      );
    }
    patch.maxSeats = seats;
  }
  if (typeof body.spectatorsAllowed === "boolean") {
    patch.spectatorsAllowed = body.spectatorsAllowed;
  }
  if (typeof body.locked === "boolean") patch.locked = body.locked;

  const updated = await tableStore.configure(slot, patch);
  // Renaming the table renames the VASSAL room, which only takes effect for
  // players seated after the change — say so rather than pretend otherwise.
  return Response.json({
    table: updated,
    note: patch.name ? "Players already seated stay in the old room." : undefined,
  });
}
