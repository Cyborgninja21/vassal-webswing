import { adminConsole } from "@/lib/admin-console";
import { currentIdentity } from "@/lib/identity";
import { moduleRegistry } from "@/lib/modules";
import { publishModule, unpublishModule } from "@/lib/webswing-app";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string }> };

async function requireOperator(): Promise<Response | { username: string }> {
  const identity = await currentIdentity();
  if (!identity) return new Response("unauthorized", { status: 401 });
  if (!identity.isAdmin) return new Response("forbidden", { status: 403 });
  return { username: identity.username };
}

function liveSessions(slug: string): number {
  return (adminConsole.getState().sessions ?? []).filter(
    (s) => s.applicationPath === `/${slug}`,
  ).length;
}

/**
 * Change a module: enable/disable, retitle, retune capacity — or re-verify it
 * against its manifest.
 */
export async function PATCH(req: Request, ctx: Ctx): Promise<Response> {
  const gate = await requireOperator();
  if (gate instanceof Response) return gate;
  const { slug } = await ctx.params;

  const current = moduleRegistry.get(slug);
  if (!current) return Response.json({ error: "No such module." }, { status: 404 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "expected a JSON body" }, { status: 400 });
  }

  if (body.action === "verify") {
    const problems = await moduleRegistry.verify(slug);
    return Response.json({ ok: (problems ?? []).length === 0, problems: problems ?? [] });
  }

  const patch: Parameters<typeof moduleRegistry.update>[1] = {};
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
  if (typeof body.title === "string" && body.title.trim()) patch.title = body.title.trim();
  if (typeof body.maxClients === "number" && body.maxClients > 0 && body.maxClients <= 64) {
    patch.maxClients = Math.floor(body.maxClients);
  }
  if (typeof body.motif === "string" && ["shield", "globe", "trenches"].includes(body.motif)) {
    patch.motif = body.motif as typeof current.motif;
  }
  if (!Object.keys(patch).length) {
    return Response.json({ error: "Nothing to change." }, { status: 400 });
  }

  // Disabling does not evict anyone already playing — it stops new launches.
  const updated = await moduleRegistry.update(slug, patch);
  if (!updated) return Response.json({ error: "No such module." }, { status: 404 });

  const result = await publishModule(updated, { create: false });
  return Response.json({
    manifest: updated,
    published: result.ok,
    error: result.ok ? null : result.error,
    liveSessions: liveSessions(slug),
  });
}

/**
 * Retire a module.
 *
 * Refused while anyone is playing it — Webswing refuses too ("Stop the app
 * first"), and surfacing that as a sentence beats surfacing it as a failure.
 * The files are renamed aside rather than deleted: the store's snapshot backup
 * is not proven, and hundreds of megabytes should not vanish on a misclick.
 */
export async function DELETE(_req: Request, ctx: Ctx): Promise<Response> {
  const gate = await requireOperator();
  if (gate instanceof Response) return gate;
  const { slug } = await ctx.params;

  const current = moduleRegistry.get(slug);
  if (!current) return Response.json({ error: "No such module." }, { status: 404 });

  const live = liveSessions(slug);
  if (live > 0) {
    return Response.json(
      {
        error: `${live} ${live === 1 ? "person is" : "people are"} playing ${current.title} right now. Wait for them to finish, or end the sessions from the operator console.`,
      },
      { status: 409 },
    );
  }

  const unpublished = await unpublishModule(current);
  if (!unpublished.ok) {
    return Response.json(
      { error: `Webswing would not unpublish it: ${unpublished.error}` },
      { status: 502 },
    );
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const movedTo = await moduleRegistry.retire(slug, stamp);
  console.log(`vassal_portal_module_retired slug=${slug} by=${gate.username}`);
  return Response.json({ ok: true, movedTo });
}
