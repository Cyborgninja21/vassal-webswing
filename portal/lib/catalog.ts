/**
 * The module catalog.
 *
 * Webswing's own `/rest/apps` carries only name/url/icon, and it is gated behind
 * the browser's token exchange rather than the forward-auth header — so the
 * portal cannot use it as a metadata source. Everything richer (era, player
 * count, designer, blurb) therefore lives here, and this list is the portal's
 * source of truth for which modules exist.
 *
 * Adding a module: add its entry in the vassal-webswing repo (module download +
 * `webswing.config` app entry + icon), then add a matching entry here. `path`
 * must equal the Webswing app path exactly — it is both the launch URL and the
 * key the admin console filters sessions by.
 */

export type Motif = "shield" | "globe" | "trenches";

export type ModuleMeta = {
  /** Webswing app path, e.g. "/his". Also the launch URL. */
  path: string;
  /**
   * VASSAL's *internal* module name — not the title, not the .vmod filename.
   * The per-module prefs file is `Prefs.sanitize(vassalModuleName)`, so this
   * must match exactly or identity seeding writes to a file VASSAL never reads
   * (silently, with no error). Verified against the live prefs directory; note
   * that it can carry a version ("Twilight Struggle 3.1"), so re-check it when
   * upgrading a module.
   */
  vassalModuleName: string;
  title: string;
  subtitle: string;
  era: string;
  players: string;
  playTime: string;
  designer: string;
  publisher: string;
  description: string;
  motif: Motif;
  /**
   * Module ids as they appear in the lobby feed. VASSAL reports the module's own
   * name, which need not match `title` — extra spellings can be added here
   * without touching the matcher.
   */
  lobbyModuleIds: string[];
};

export const CATALOG: ModuleMeta[] = [
  {
    path: "/his",
    vassalModuleName: "Here I Stand (500th Anniversary Edition)",
    title: "Here I Stand",
    subtitle: "500th Anniversary Edition",
    era: "1517 – 1555",
    players: "2 – 6",
    playTime: "3 – 6 hours",
    designer: "Ed Beach",
    publisher: "GMT Games",
    description:
      "The Reformation in Europe: six powers contend at once over religion, dynasty, exploration and war. Each power wins differently, so the table is a negotiation as much as a battlefield.",
    motif: "shield",
    lobbyModuleIds: ["Here I Stand", "Here I Stand 500th Anniversary Edition"],
  },
  {
    path: "/twilight-struggle",
    vassalModuleName: "Twilight Struggle 3.1",
    title: "Twilight Struggle",
    subtitle: "Deluxe Edition",
    era: "1945 – 1989",
    players: "2",
    playTime: "2 – 3 hours",
    designer: "Ananda Gupta & Jason Matthews",
    publisher: "GMT Games",
    description:
      "The whole Cold War as a card-driven duel. Every card helps someone; the game is deciding whose turn it is to be helped, and where you can afford to lose ground.",
    motif: "globe",
    lobbyModuleIds: ["Twilight Struggle", "Twilight Struggle Deluxe"],
  },
  {
    path: "/paths-of-glory",
    vassalModuleName: "Paths of Glory",
    title: "Paths of Glory",
    subtitle: "The First World War",
    era: "1914 – 1918",
    players: "2",
    playTime: "4 – 8 hours",
    designer: "Ted Raicer",
    publisher: "GMT Games",
    description:
      "The Great War from the Marne to the armistice. Mobilisation, attrition and the slow grind of replacements — a long game that rewards husbanding what you cannot replace.",
    motif: "trenches",
    lobbyModuleIds: ["Paths of Glory"],
  },
];

const normalise = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/**
 * Map a lobby-reported module id onto a catalog entry. Unmatched ids are not an
 * error — the table list still shows the table, labelled with the raw id — so a
 * module added to Webswing but not yet described here degrades gracefully.
 */
export function findModuleByLobbyId(lobbyModuleId: string): ModuleMeta | null {
  const target = normalise(lobbyModuleId);
  if (!target) return null;
  for (const mod of CATALOG) {
    const names = [mod.title, `${mod.title} ${mod.subtitle}`, ...mod.lobbyModuleIds];
    if (names.some((n) => normalise(n) === target)) return mod;
  }
  // Fall back to a prefix match: modules often append their version to the id.
  return CATALOG.find((mod) => target.startsWith(normalise(mod.title))) ?? null;
}

export function findModuleByPath(path: string): ModuleMeta | null {
  return CATALOG.find((m) => m.path === path) ?? null;
}
