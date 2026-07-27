import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { env } from "@/lib/env";
import {
  formatProperties,
  parseProperties,
  sanitizePrefsName,
} from "@/lib/java-properties";
import { sanitizeUsername } from "@/lib/identity";

/**
 * Writes a player's VASSAL preferences so that launching a module drops them at
 * the right table, already named, without touching a single VASSAL dialog.
 *
 * Three preferences do the work, all verified against a live prefs directory:
 *
 *  - `V_Global` → `ServerAddressBook`: the list of known servers. Entries are
 *    `PropertiesEncoder` blobs (`key=value` pairs joined by `|`) joined by `,`.
 *  - `V_Global` → `ServerSelected`: **which** of them is current. This is the
 *    one that matters and the one VASSAL never writes until a human picks a
 *    server by hand — its absence is exactly why players had to go into Server
 *    Controls. Its value is `Properties.store()` text, so it is multi-line and
 *    gets `\n`-escaped when written into V_Global.
 *  - `V_Global` → `PortalRoom`: the room the patched launcher joins after
 *    connecting. Main Room cannot hold a game — VASSAL tears the game state
 *    down when you join the default room and only synchronises for named ones.
 *  - `<module>` → `RealName` / `SecretName`: the identity. `SecretName` is what
 *    VASSAL matches to hand a returning player their seat back, so the portal
 *    issues a stable random one per user (never a real credential — VASSAL
 *    stores it in clear and broadcasts it to the module).
 *
 * Connecting and joining the room are done by the engine patch this fork
 * carries (patches/Player.java): stock VASSAL 3.7.24 will not connect by itself
 * and always lands in Main Room. All the player does is pick a side.
 */

const PREFS_SUBDIR = path.join(".VASSAL", "prefs");
const GLOBAL_PREFS = "V_Global";

export type TableServer = {
  /** Slot number; also the cosmetic label VASSAL shows in its own server list. */
  slot: number;
  host: string;
  port: number;
};

export type SeedRequest = {
  username: string;
  nickname: string;
  secretName: string;
  /** VASSAL's internal module name — the prefs filename is derived from it. */
  vassalModuleName: string | null;
  server: TableServer | null;
  /**
   * Room to auto-join, read by the patched VASSAL launcher (patches/Player.java).
   * `null` clears it, so opening a module directly behaves like stock VASSAL
   * instead of silently resuming the last table.
   */
  room: string | null;
};

function userPrefsDir(username: string): string {
  const safe = sanitizeUsername(username);
  if (!safe) throw new Error(`refusing to write prefs for invalid username`);
  // sanitizeUsername already excludes "/", ".." and every path metacharacter,
  // but resolve-and-check keeps the guarantee local and obvious.
  const dir = path.resolve(env.usersDir, safe, PREFS_SUBDIR);
  const root = path.resolve(env.usersDir);
  if (dir !== path.join(root, safe, PREFS_SUBDIR)) {
    throw new Error("refusing to write prefs outside the users directory");
  }
  return dir;
}

async function readProps(file: string): Promise<Map<string, string>> {
  try {
    return parseProperties(await fs.readFile(file, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw e;
  }
}

/** Write via temp + rename so a torn write can never leave unreadable prefs. */
async function writeProps(file: string, props: Map<string, string>): Promise<void> {
  const tmp = `${file}.portal.tmp`;
  await fs.writeFile(tmp, formatProperties(props, "written by vassal-portal"), {
    encoding: "utf8",
    mode: 0o666,
  });
  await fs.rename(tmp, file);
}

/** One `PropertiesEncoder` entry: `key=value` pairs joined by `|`, keys sorted. */
function encodeServerEntry(props: Record<string, string>): string {
  return Object.keys(props)
    .sort()
    .map((k) => `${k}=${props[k]}`)
    .join("|");
}

/** The `Properties.store()` text that `ServerSelected` holds. */
function encodeServerSelected(props: Record<string, string>): string {
  return (
    Object.keys(props)
      .sort()
      .map((k) => `${k}=${props[k]}`)
      .join("\n") + "\n"
  );
}

export function tableServerProperties(server: TableServer): Record<string, string> {
  return {
    // Deliberately NOT the user's table name: this string is re-encoded through
    // two of VASSAL's own escaping layers, so it stays fixed and ASCII-safe.
    // Human-readable table names live in the portal only.
    description: `Table ${server.slot}`,
    nodeHost: server.host,
    nodePort: String(server.port),
    type: "private",
  };
}

/**
 * Merge our entry into the address book, replacing any previous entry for the
 * same host:port and preserving everything else the player has.
 */
function mergeAddressBook(existing: string | undefined, entry: string): string {
  const wanted = new Map(
    entry.split("|").map((kv) => {
      const i = kv.indexOf("=");
      return [kv.slice(0, i), kv.slice(i + 1)] as const;
    }),
  );
  const keep = (existing ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((candidate) => {
      const props = new Map(
        candidate.split("|").map((kv) => {
          const i = kv.indexOf("=");
          return [kv.slice(0, i), kv.slice(i + 1)] as const;
        }),
      );
      // Drop a stale entry for the same endpoint; keep official/p2p/other tables.
      return !(
        props.get("nodeHost") === wanted.get("nodeHost") &&
        props.get("nodePort") === wanted.get("nodePort")
      );
    });

  if (!keep.some((e) => e.includes("type=official"))) {
    keep.unshift(encodeServerEntry({ description: "VASSAL Server", type: "official" }));
  }
  keep.push(entry);
  return keep.join(",");
}

export async function seedPlayerPrefs(req: SeedRequest): Promise<void> {
  const dir = userPrefsDir(req.username);
  await fs.mkdir(dir, { recursive: true, mode: 0o777 });

  // --- global prefs: which servers exist, and which one is current ---
  const globalFile = path.join(dir, GLOBAL_PREFS);
  const global = await readProps(globalFile);

  // Defaults the skeleton would have provided. Only fill gaps — the launch
  // wrapper seeds the skeleton without clobbering, and the player may have
  // changed these themselves.
  if (!global.has("Locale")) global.set("Locale", "en");
  if (!global.has("welcomeWizard")) global.set("welcomeWizard", "false");

  if (req.server) {
    const props = tableServerProperties(req.server);
    const entry = encodeServerEntry(props);
    global.set("ServerAddressBook", mergeAddressBook(global.get("ServerAddressBook"), entry));
    global.set("ServerSelected", encodeServerSelected(props));
  }

  // Read once at launch by the patched Player: connect, then join this room.
  if (req.room) {
    global.set("PortalRoom", req.room);
  } else {
    global.delete("PortalRoom");
  }

  await writeProps(globalFile, global);

  // --- module prefs: the identity VASSAL uses to re-claim a seat ---
  if (req.vassalModuleName) {
    const moduleFile = path.join(dir, sanitizePrefsName(req.vassalModuleName));
    const modulePrefs = await readProps(moduleFile);
    modulePrefs.set("RealName", req.nickname);
    modulePrefs.set("SecretName", req.secretName);
    await writeProps(moduleFile, modulePrefs);
  }
}

/** True when the player already has a VASSAL home (so a launch will not re-seed). */
export async function hasPlayerHome(username: string): Promise<boolean> {
  try {
    await fs.access(userPrefsDir(username), constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
