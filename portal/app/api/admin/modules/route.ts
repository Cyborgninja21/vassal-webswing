import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { adminConsole } from "@/lib/admin-console";
import { currentIdentity } from "@/lib/identity";
import { env } from "@/lib/env";
import { ingestModule, IngestError } from "@/lib/module-ingest";
import { moduleRegistry, quarantineRoot } from "@/lib/modules";
import { publishModule } from "@/lib/webswing-app";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Module administration.
 *
 * Operators only, re-checked here on every request rather than relied on in the
 * UI — publishing a module is choosing to run its code inside the container
 * (see the plan's §5.1), so this is the control that matters most.
 */

async function requireOperator(): Promise<Response | { username: string }> {
  const identity = await currentIdentity();
  if (!identity) return new Response("unauthorized", { status: 401 });
  if (!identity.isAdmin) return new Response("forbidden", { status: 403 });
  return { username: identity.username };
}

function withLiveSessions() {
  const sessions = adminConsole.getState().sessions ?? [];
  return moduleRegistry.snapshot().map((m) => ({
    ...m,
    liveSessions: sessions.filter((s) => s.applicationPath === `/${m.slug}`).length,
    codeTotal: m.codeEntries + m.extensions.reduce((n, e) => n + e.codeEntries, 0),
    bytesOnDisk: m.archiveBytes,
  }));
}

export async function GET(): Promise<Response> {
  const gate = await requireOperator();
  if (gate instanceof Response) return gate;

  return Response.json({
    modules: withLiveSessions(),
    engine: { vassalVersion: env.vassalEngineVersion },
    limits: {
      maxBytes: env.moduleMaxBytes,
      maxEntries: env.moduleMaxEntries,
    },
  });
}

/**
 * Ingest a module. Two request shapes, both streaming:
 *
 *   - `application/json` → `{ url, sha256?, slug?, title? }`
 *   - anything else      → the raw archive as the body, parameters in the query
 *
 * The upload form is deliberately *not* multipart: `formData()` would buffer a
 * 300 MB archive in a 512 MB container.
 */
export async function POST(req: Request): Promise<Response> {
  const gate = await requireOperator();
  if (gate instanceof Response) return gate;

  const url = new URL(req.url);
  const contentType = req.headers.get("content-type") ?? "";
  let staged: string | null = null;

  try {
    let input;
    if (contentType.includes("application/json")) {
      let body: Record<string, unknown>;
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        return Response.json({ error: "expected a JSON body" }, { status: 400 });
      }
      const src = typeof body.url === "string" ? body.url.trim() : "";
      if (!src) return Response.json({ error: "A source URL is required." }, { status: 400 });
      input = {
        username: gate.username,
        url: src,
        expectedSha256: typeof body.sha256 === "string" ? body.sha256 : undefined,
        slug: typeof body.slug === "string" ? body.slug : undefined,
        title: typeof body.title === "string" ? body.title : undefined,
      };
    } else {
      if (!req.body) return Response.json({ error: "No file in the request." }, { status: 400 });
      await fsp.mkdir(quarantineRoot(), { recursive: true });
      staged = path.join(quarantineRoot(), `upload-${randomUUID()}`);
      await pipeline(
        Readable.fromWeb(req.body as never),
        fs.createWriteStream(staged, { mode: 0o600 }),
      );
      input = {
        username: gate.username,
        upload: { path: staged, filename: url.searchParams.get("filename") },
        expectedSha256: url.searchParams.get("sha256") ?? undefined,
        slug: url.searchParams.get("slug") ?? undefined,
        title: url.searchParams.get("title") ?? undefined,
      };
    }

    const { manifest, warnings } = await ingestModule(input);
    staged = null; // ingest took ownership of the staged file

    const published = await publishModule(manifest);
    if (!published.ok) {
      // The store is populated but Webswing has not accepted the path. That is
      // a recoverable state, not a failed ingest — say so precisely rather than
      // pretending the module is playable.
      return Response.json(
        {
          manifest,
          warnings,
          published: false,
          error: `Stored, but Webswing did not publish it: ${published.error}`,
        },
        { status: 202 },
      );
    }

    console.log(
      `vassal_portal_module_ingested slug=${manifest.slug} bytes=${manifest.archiveBytes} ` +
        `extensions=${manifest.extensions.length} by=${manifest.ingestedBy}`,
    );
    return Response.json({ manifest, warnings, published: true }, { status: 201 });
  } catch (e) {
    if (e instanceof IngestError) {
      return Response.json({ error: e.message, detail: e.detail }, { status: e.status });
    }
    return Response.json({ error: (e as Error).message }, { status: 500 });
  } finally {
    if (staged) await fsp.rm(staged, { force: true }).catch(() => undefined);
  }
}
