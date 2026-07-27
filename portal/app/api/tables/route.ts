import { currentIdentity } from "@/lib/identity";
import { findModuleByPath } from "@/lib/catalog";
import { lobbyStore } from "@/lib/lobby-state";
import { sanitizeTableName, tableStore } from "@/lib/tables";
import { seatPlayer } from "@/lib/seating";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Create a table and seat its creator at it. */
export async function POST(req: Request): Promise<Response> {
  const identity = await currentIdentity();
  if (!identity) return new Response("unauthorized", { status: 401 });

  let body: { name?: unknown; modulePath?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "expected a JSON body" }, { status: 400 });
  }

  const name = sanitizeTableName(body.name);
  if (!name) {
    return Response.json(
      { error: "Table name must be 1–40 characters of ordinary text." },
      { status: 400 },
    );
  }

  const modulePath = typeof body.modulePath === "string" ? body.modulePath : "";
  if (!findModuleByPath(modulePath)) {
    return Response.json({ error: "Unknown game." }, { status: 400 });
  }

  const occupied = lobbyStore.occupiedSlots();
  await tableStore.reap(occupied);

  try {
    const table = await tableStore.create(
      { name, modulePath, createdBy: identity.username },
      occupied,
    );
    const seat = await seatPlayer(identity.username, table);
    return Response.json(seat, { status: 201 });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 409 });
  }
}
