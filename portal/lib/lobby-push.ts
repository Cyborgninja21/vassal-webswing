import { timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";
import { lobbyStore, parseStatus } from "@/lib/lobby-state";

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
 *
 * There is one lobby and therefore one push URL. It used to be nine — a shared
 * hall plus `/t1/`…`/t8/`, one per table container — with the table number
 * taken from the path. Tables are rooms now, so attribution comes from the
 * payload instead (see lib/lobby-state.ts).
 */

function tokenMatches(candidate: string): boolean {
  const expected = Buffer.from(env.lobbyPushToken, "utf8");
  const given = Buffer.from(candidate, "utf8");
  if (expected.length !== given.length) return false;
  return timingSafeEqual(expected, given);
}

export async function lobbyPushResponse(req: Request, token: string): Promise<Response> {
  if (!tokenMatches(token)) return new Response("not found", { status: 404 });

  let status = "";
  try {
    const form = await req.formData();
    status = String(form.get("STATUS") ?? "");
  } catch {
    // Apache HttpClient sends standard form encoding, but never let a malformed
    // body turn into a two-hour reporter back-off.
    status = "";
  }

  lobbyStore.update(parseStatus(status));

  // 201, exactly — see above.
  return new Response(null, { status: 201 });
}
