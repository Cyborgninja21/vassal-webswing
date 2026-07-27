import { moduleRegistry, type ModuleManifest } from "@/lib/modules";

/**
 * The module catalog.
 *
 * Webswing's own `/rest/apps` carries only name/url/icon, and it is gated
 * behind the browser's token exchange rather than the forward-auth header — so
 * the portal cannot use it as a metadata source. Everything richer therefore
 * lives here.
 *
 * Two kinds of module exist and they are deliberately different:
 *
 *  - **Built-in** modules are baked into the container image, pinned by sha256
 *    at build time, and described by hand below. They are the fallback that
 *    proves the platform works with the module store empty.
 *  - **Ingested** modules come from `module.json` manifests on the shared store
 *    (see lib/modules.ts). Their metadata is whatever VASSAL itself declares —
 *    we do not invent an era or a designer for a module nobody has curated.
 *
 * `path` must equal the Webswing app path exactly: it is both the launch URL
 * and the key the admin console filters sessions by.
 */

export type Motif = "shield" | "globe" | "trenches";

export type ModuleMeta = {
  /** Webswing app path, e.g. "/his". Also the launch URL. */
  path: string;
  /**
   * VASSAL's *internal* module name — not the title, not the .vmod filename.
   * The per-module prefs file is `Prefs.sanitize(vassalModuleName)`, so this
   * must match exactly or identity seeding writes to a file VASSAL never reads
   * (silently, with no error). For built-ins it is hand-recorded; for ingested
   * modules it is read straight out of the archive's `moduledata`, which is why
   * that failure mode cannot recur there.
   */
  vassalModuleName: string;
  title: string;
  subtitle: string;
  description: string;
  motif: Motif;
  /** Short labels shown on the tile. Whatever is actually known — never blanks. */
  facts: string[];
  /** True for store-backed modules an operator ingested. */
  ingested: boolean;
  /**
   * Module ids as they appear in the lobby feed. VASSAL reports the module's own
   * name, which need not match `title` — extra spellings can be added here
   * without touching the matcher.
   */
  lobbyModuleIds: string[];
};

export const BUILTIN_CATALOG: ModuleMeta[] = [
  {
    path: "/his",
    vassalModuleName: "Here I Stand (500th Anniversary Edition)",
    title: "Here I Stand",
    subtitle: "500th Anniversary Edition",
    description:
      "The Reformation in Europe: six powers contend at once over religion, dynasty, exploration and war. Each power wins differently, so the table is a negotiation as much as a battlefield.",
    motif: "shield",
    facts: ["2 – 6 players", "1517 – 1555", "3 – 6 hours", "Ed Beach · GMT Games"],
    ingested: false,
    lobbyModuleIds: ["Here I Stand", "Here I Stand 500th Anniversary Edition"],
  },
  {
    path: "/twilight-struggle",
    vassalModuleName: "Twilight Struggle 3.1",
    title: "Twilight Struggle",
    subtitle: "Deluxe Edition",
    description:
      "The whole Cold War as a card-driven duel. Every card helps someone; the game is deciding whose turn it is to be helped, and where you can afford to lose ground.",
    motif: "globe",
    facts: ["2 players", "1945 – 1989", "2 – 3 hours", "Gupta & Matthews · GMT Games"],
    ingested: false,
    lobbyModuleIds: ["Twilight Struggle", "Twilight Struggle Deluxe"],
  },
  {
    path: "/paths-of-glory",
    vassalModuleName: "Paths of Glory",
    title: "Paths of Glory",
    subtitle: "The First World War",
    description:
      "The Great War from the Marne to the armistice. Mobilisation, attrition and the slow grind of replacements — a long game that rewards husbanding what you cannot replace.",
    motif: "trenches",
    facts: ["2 players", "1914 – 1918", "4 – 8 hours", "Ted Raicer · GMT Games"],
    ingested: false,
    lobbyModuleIds: ["Paths of Glory"],
  },
];

export function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** Present an ingested module using only what VASSAL actually declares. */
export function metaOf(m: ModuleManifest): ModuleMeta {
  const facts: string[] = [];
  if (m.version) facts.push(`version ${m.version}`);
  if (m.extensions.length) {
    facts.push(`${m.extensions.length} extension${m.extensions.length === 1 ? "" : "s"}`);
  }
  if (m.vassalVersion) facts.push(`saved with VASSAL ${m.vassalVersion}`);
  facts.push(formatBytes(m.archiveBytes));

  return {
    path: `/${m.slug}`,
    vassalModuleName: m.vassalModuleName,
    title: m.title,
    subtitle: m.vassalModuleName === m.title ? "" : m.vassalModuleName,
    description: m.description || "Added to this platform by an operator.",
    motif: m.motif,
    facts,
    ingested: true,
    lobbyModuleIds: [m.vassalModuleName, m.title],
  };
}

/**
 * Everything a player may open right now: the built-ins plus every *enabled*
 * ingested module. Synchronous on purpose — the registry keeps an in-memory
 * snapshot refreshed at boot and after each mutation, so every existing call
 * site stays a plain lookup.
 */
export function allModules(): ModuleMeta[] {
  return [...BUILTIN_CATALOG, ...moduleRegistry.enabled().map(metaOf)];
}

const normalise = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/**
 * Map a lobby-reported module id onto a catalog entry. Unmatched ids are not an
 * error — the table list still shows the table, labelled with the raw id — so a
 * module added to Webswing but not yet described here degrades gracefully.
 */
export function findModuleByLobbyId(lobbyModuleId: string): ModuleMeta | null {
  const target = normalise(lobbyModuleId);
  if (!target) return null;
  const catalog = allModules();
  for (const mod of catalog) {
    const names = [mod.title, `${mod.title} ${mod.subtitle}`, ...mod.lobbyModuleIds];
    if (names.some((n) => normalise(n) === target)) return mod;
  }
  // Fall back to a prefix match: modules often append their version to the id.
  return catalog.find((mod) => target.startsWith(normalise(mod.title))) ?? null;
}

export function findModuleByPath(path: string): ModuleMeta | null {
  return allModules().find((m) => m.path === path) ?? null;
}
