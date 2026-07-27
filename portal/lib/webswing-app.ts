import path from "node:path";
import { adminConsole } from "@/lib/admin-console";
import { env } from "@/lib/env";
import { moduleRegistry, type ModuleManifest } from "@/lib/modules";

/**
 * Turning a manifest into a Webswing application.
 *
 * The shape below is the built-in module entries from `docker/webswing.config`,
 * parameterised. Keeping one template means an ingested module gets the same
 * per-player home, the same transfer directory, the same font mapping and the
 * same reconnect semantics as a curated one — there is no second-class module.
 *
 * `${user}` is Webswing's own substitution, resolved per session from the
 * authenticated username; it must survive into the JSON verbatim.
 */

const FONTS = "/usr/share/fonts/truetype/dejavu";

/** Quote a path for Webswing's Ant-style `translateCommandline` arg splitter. */
function quoteArg(p: string): string {
  return `"${p}"`;
}

export function appConfigFor(m: ModuleManifest): Record<string, unknown> {
  const modulePath = path.posix.join(env.modulesDir, m.slug, m.moduleFile);
  return {
    path: `/${m.slug}`,
    name: m.title,
    enabled: m.enabled,
    maxClients: m.maxClients,
    sessionMode: "CONTINUE_FOR_USER",
    allowStealSession: false,
    swingConfig: {
      launcherType: "Desktop",
      launcherConfig: {
        mainClass: "VASSAL.launch.Player",
        args: `--load ${quoteArg(modulePath)}`,
      },
      vmArgs:
        `-Xmx${m.heap} -Duser.home=/data/users/\${user} ` +
        `-Dwebswing.trustedFontDirs=/usr/share/fonts`,
      classPathEntries: ["/opt/vassal/lib/Vengine.jar"],
      jreExecutable: "/opt/vassal/bin/vassal-java",
      homeDir: "/data/users/${user}",
      directdraw: true,
      isolatedFs: true,
      transferDir: "/data/transfers/${user}",
      allowUpload: true,
      allowDownload: true,
      allowDelete: true,
      swingSessionTimeout: 14400,
      timeoutIfInactive: false,
      fontConfig: {
        dialog: `${FONTS}/DejaVuSans.ttf`,
        "dialog bold": `${FONTS}/DejaVuSans-Bold.ttf`,
        dialoginput: `${FONTS}/DejaVuSansMono.ttf`,
        sansserif: `${FONTS}/DejaVuSans.ttf`,
        serif: `${FONTS}/DejaVuSerif.ttf`,
        monospaced: `${FONTS}/DejaVuSansMono.ttf`,
      },
    },
  };
}

export type PublishResult = { ok: boolean; error: string | null };

export async function publishModule(
  m: ModuleManifest,
  opts: { create?: boolean } = {},
): Promise<PublishResult> {
  return adminConsole.publishApp(`/${m.slug}`, appConfigFor(m), opts);
}

export async function unpublishModule(m: ModuleManifest): Promise<PublishResult> {
  return adminConsole.unpublishApp(`/${m.slug}`, appConfigFor(m));
}

/**
 * Make Webswing's application list match the registry.
 *
 * Runs once at boot. The store is the durable record of what an operator
 * approved; Webswing's config is a projection of it that can drift — a config
 * file restored from an image default, or a module ingested while the Webswing
 * container happened to be down. Re-publishing every enabled module is
 * idempotent (`saveConfig` overwrites by path), so reconciling costs nothing
 * and removes a whole class of "the tile is there but the URL 404s".
 */
export async function reconcilePublishedModules(): Promise<void> {
  const modules = moduleRegistry.snapshot();
  for (const m of modules) {
    if (!m.enabled) continue;
    const result = await publishModule(m);
    if (!result.ok) {
      console.warn(`vassal_portal module publish failed slug=${m.slug} error=${result.error}`);
    }
  }
  if (modules.length) {
    console.log(
      `vassal_portal_modules total=${modules.length} enabled=${moduleRegistry.enabled().length}`,
    );
  }
}
