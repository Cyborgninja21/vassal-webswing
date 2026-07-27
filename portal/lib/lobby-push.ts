import { timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";
import { HALL_SLOT, lobbyStore, parseStatus } from "@/lib/lobby-state";

/**
 * Shared handling for VASSAL's StatusReporter push.
 *
 * Two behaviours of the reporter are load-bearing:
 *
 *  - **It requires HTTP 201.** Anything else is treated as a failure and the
 *    reporter doubles its retry interval, all the way out to two hours. A
 *    well-meaning 200 would silently freeze the table list.
 *  - It cannot send headers, so the shared secret has to live in the URL path.
 *    The token is compared in constant time and is the only thing standing
 *    between this endpoint and anything else on the stack network.
 */

function tokenMatches(candidate: string): boolean {
  const expected = Buffer.from(env.lobbyPushToken, "utf8");
  const given = Buffer.from(candidate, "utf8");
  if (expected.length !== given.length) return false;
  return timingSafeEqual(expected, given);
}

/** `t3` → 3. The shared hall (no table segment) is slot 0. */
function parseSlot(segment: string | null): number | null {
  if (segment === null) return HALL_SLOT;
  const m = /^t(\d{1,2})$/.exec(segment);
  if (!m) return null;
  const slot = Number.parseInt(m[1], 10);
  return slot >= 1 && slot <= env.tableSlots ? slot : null;
}

export async function lobbyPushResponse(
  req: Request,
  token: string,
  tableSegment: string | null,
): Promise<Response> {
  if (!tokenMatches(token)) return new Response("not found", { status: 404 });

  const slot = parseSlot(tableSegment);
  if (slot === null) return new Response("not found", { status: 404 });

  let status = "";
  try {
    const form = await req.formData();
    status = String(form.get("STATUS") ?? "");
  } catch {
    // Apache HttpClient sends standard form encoding, but never let a malformed
    // body turn into a two-hour reporter back-off.
    status = "";
  }

  lobbyStore.update(slot, parseStatus(status));

  // 201, exactly — see above.
  return new Response(null, { status: 201 });
}
