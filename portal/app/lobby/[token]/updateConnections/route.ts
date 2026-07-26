import { timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";
import { lobbyStore, parseStatus } from "@/lib/lobby-state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Receives the VASSAL lobby's status push.
 *
 * `VASSAL.chat.node.Server -URL http://vassal-portal:3000/lobby/<token>/` makes
 * its StatusReporter POST here, form-encoded, with the whole roster in `STATUS`.
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

export async function POST(
  req: Request,
  ctx: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await ctx.params;
  if (!tokenMatches(token)) {
    return new Response("not found", { status: 404 });
  }

  let status = "";
  try {
    const form = await req.formData();
    status = String(form.get("STATUS") ?? "");
  } catch {
    // Apache HttpClient's UrlEncodedFormEntity is standard form encoding, but
    // never let a malformed body turn into a reporter back-off.
    status = "";
  }

  lobbyStore.update(parseStatus(status));

  // 201, exactly — see above.
  return new Response(null, { status: 201 });
}
