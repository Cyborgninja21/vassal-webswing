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

/** The path-level half: what `SecuredPathConfig` owns. */
export function pathConfigFor(m: ModuleManifest): Record<string, unknown> {
  return {
    path: `/${m.slug}`,
    name: m.title,
    enabled: m.enabled,
    maxClients: m.maxClients,
    sessionMode: "CONTINUE_FOR_USER",
    allowStealSession: false,
  };
}

/**
 * The session-pool half: what actually launches VASSAL.
 *
 * This must NOT be folded into the path config. Webswing splits an
 * application's configuration across two providers, and the server-config
 * provider silently discards `swingConfig` — producing an app path that
 * resolves but answers "Access to this application is forbidden", because
 * there is no launcher behind it.
 *
 * `${user}` is Webswing's own substitution, resolved per session from the
 * authenticated username; it must survive into the JSON verbatim.
 */
export function swingConfigFor(m: ModuleManifest): Record<string, unknown> {
  return swingConfigForFile(path.posix.join(env.modulesDir, m.slug, m.moduleFile), m.heap);
}

function swingConfigForFile(moduleFilePath: string, heap: string): Record<string, unknown> {
  return {
    launcherType: "Desktop",
    launcherConfig: {
      mainClass: "VASSAL.launch.Player",
      args: `--load ${quoteArg(moduleFilePath)}`,
    },
    vmArgs:
      `-Xmx${heap} -Duser.home=/data/users/\${user} ` +
      `-Dwebswing.trustedFontDirs=/usr/share/fonts ` +
      // Webswing's paint loop is ack-gated — it builds a frame, marks the
      // client not-ready and refuses to build another until the browser acks
      // — and only wakes on this tick. At the 33 ms default that is up to
      // 33 ms of dead time per frame, which is pure latency for no gain.
      `-Dwebswing.drawDelayMs=10`,
    classPathEntries: ["/opt/vassal/lib/Vengine.jar"],
    jreExecutable: "/opt/vassal/bin/vassal-java",
    homeDir: "/data/users/${user}",
    // Off deliberately. Directdraw identifies every image an app draws by
    // xxhashing its pixels (Webswing hardcodes the slowest pure-Java hash) and
    // PNG-encodes cache misses — per image, per frame, on the EDT. VASSAL's
    // map paint is dozens of tile drawImages per repaint, and mid-drag thread
    // dumps show the EDT pinned exactly there: ~10 fps under drag, ~80 ms of
    // every 95 ms cycle in hash/encode. Buffer mode renders plain Java2D and
    // ships dirty-region PNG diffs instead, trading bandwidth for frame rate.
    directdraw: false,
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
  };
}

/**
 * The three curated modules baked into the image.
 *
 * `docker/webswing.config` only SEEDS the live config — the entrypoint copies
 * it exactly once, so on every existing deployment edits to it are dead
 * letters (proven when a vmArgs change shipped and never reached `/his`).
 * Reconciling the built-ins through the same admin channel as ingested
 * modules makes the portal the durable owner of their configuration too.
 */
const BUILTIN_APPS = [
  {
    path: "/his",
    name: "Here I Stand (500th)",
    icon: "/opt/webswing/icons/his.png",
    maxClients: 8,
    moduleFile: "/opt/vassal/modules/Here_I_Stand_500th_3.5.0.vmod",
  },
  {
    path: "/twilight-struggle",
    name: "Twilight Struggle (Deluxe)",
    icon: "/opt/webswing/icons/twilight-struggle.png",
    maxClients: 4,
    moduleFile: "/opt/vassal/modules/Twilight-Struggle-3.2.vmod",
  },
  {
    path: "/paths-of-glory",
    name: "Paths of Glory",
    icon: "/opt/webswing/icons/paths-of-glory.png",
    maxClients: 4,
    moduleFile: "/opt/vassal/modules/Paths_of_Glory_10.8.vmod",
  },
] as const;

export type PublishResult = { ok: boolean; error: string | null };

export async function publishModule(
  m: ModuleManifest,
  opts: { create?: boolean } = {},
): Promise<PublishResult> {
  return adminConsole.publishApp(`/${m.slug}`, pathConfigFor(m), swingConfigFor(m), opts);
}

export async function unpublishModule(m: ModuleManifest): Promise<PublishResult> {
  return adminConsole.unpublishApp(`/${m.slug}`, pathConfigFor(m), swingConfigFor(m));
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
  for (const app of BUILTIN_APPS) {
    const result = await adminConsole.publishApp(
      app.path,
      {
        path: app.path,
        name: app.name,
        icon: app.icon,
        enabled: true,
        maxClients: app.maxClients,
        sessionMode: "CONTINUE_FOR_USER",
        allowStealSession: false,
      },
      swingConfigForFile(app.moduleFile, "2g"),
      { create: false },
    );
    if (!result.ok) {
      console.warn(`vassal_portal builtin publish failed path=${app.path} error=${result.error}`);
    }
  }
  const modules = moduleRegistry.snapshot();
  for (const m of modules) {
    if (!m.enabled) continue;
    // `create: false` on reconcile. The app path normally already exists — the
    // config file survives a recreate — and asking Webswing to create it again
    // makes it log `ERROR ... Unable to Create App. Application already exits.`
    // on every single boot. saveConfig alone is enough to (re)write the entry,
    // so the only thing createApp bought here was a permanent false alarm in
    // the errors panel. Ingest still creates: that path is a genuinely new app.
    const result = await publishModule(m, { create: false });
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
