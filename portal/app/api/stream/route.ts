import { adminConsole } from "@/lib/admin-console";
import { currentIdentity } from "@/lib/identity";
import { lobbyStore } from "@/lib/lobby-state";
import { buildPortalState } from "@/lib/portal-state";
import { viewerOf } from "@/lib/viewer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 15_000;

/**
 * Server-Sent Events feed of the whole portal state.
 *
 * The browser never polls: the lobby pushes to us on change (~2 s), the admin
 * console polls Webswing server-side, and both funnel into this stream. The
 * 15 s heartbeat plus `X-Accel-Buffering: no` is what keeps the connection alive
 * through the proxy chain.
 */
export async function GET(req: Request): Promise<Response> {
  const identity = await currentIdentity();
  if (!identity) return new Response("unauthorized", { status: 401 });

  adminConsole.start();

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;

      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          closed = true;
        }
      };

      // Serialise builds so a slow one cannot deliver state out of order.
      let building: Promise<void> = Promise.resolve();
      const push = () => {
        building = building
          .then(async () => {
            if (!closed) send("state", await buildPortalState(await viewerOf(identity)));
          })
          .catch(() => undefined);
      };

      push();

      const unsubscribeLobby = lobbyStore.subscribe(push);
      const unsubscribeAdmin = adminConsole.subscribe(push);
      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          closed = true;
        }
      }, HEARTBEAT_MS);

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribeLobby();
        unsubscribeAdmin();
        try {
          controller.close();
        } catch {
          // already closed by the runtime
        }
      };

      req.signal.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Stops intermediate proxies buffering the stream into uselessness.
      "x-accel-buffering": "no",
    },
  });
}
