/**
 * Pure archive logic for module ingest — no filesystem, no network.
 *
 * Everything that decides *whether an archive is acceptable* lives here so it
 * can be tested against fixtures rather than against a 318 MB download.
 *
 * The shapes it has to recognise come from how VASSAL actually distributes
 * modules:
 *
 *   - a bare `.vmod`, which is a ZIP containing `moduledata`;
 *   - a wrapper ZIP holding one `.vmod` plus `<base>_ext/`, its extension
 *     directory. That directory name is not a convention we chose — VASSAL's
 *     `ExtensionsManager` derives it by stripping everything after the module
 *     path's last `.` and appending `_ext`, so the basename must match exactly
 *     or every extension is orphaned.
 *
 * Extension files inside `_ext/` routinely carry **no file extension** at all
 * (`Cards`, `Space Marines`). VASSAL accepts any non-hidden, non-directory file
 * whose metadata parses as an extension, so name-based filtering here would
 * throw away most of a real module.
 */

/** Paths a module may never claim: Webswing's own, and the portal's. */
export const RESERVED_PATHS = [
  // Webswing root-level endpoints.
  "rest",
  "async",
  "login",
  "logout",
  "css",
  "javascript",
  "images",
  "fonts",
  // Portal routes.
  "api",
  "admin",
  "settings",
  "watch",
  "lobby",
  "_next",
  "favicon.ico",
] as const;

export type ModuleData = {
  /** VASSAL's internal module name — the key `Prefs.sanitize()` acts on. */
  name: string;
  version: string;
  /** VASSAL release the module was last saved with. */
  vassalVersion: string;
  description: string;
};

export type ArchiveShape =
  | { kind: "module"; modulePath: null; extPrefix: null; stripPrefix: string }
  | { kind: "wrapper"; modulePath: string; extPrefix: string | null; stripPrefix: string };

export class ArchiveError extends Error {
  readonly detail: string[];
  constructor(message: string, detail: string[] = []) {
    super(message);
    this.name = "ArchiveError";
    this.detail = detail;
  }
}

/**
 * Reject an entry name before it is ever joined onto a path.
 *
 * Absolute paths, `..` traversal, backslash separators (which some Windows
 * archivers emit and POSIX treats as a literal filename character) and NUL are
 * all refused. Extraction re-checks the resolved path too — this is the cheap
 * first gate, not the only one.
 */
export function isSafeEntryName(name: string): boolean {
  if (!name || name.length > 1024) return false;
  if (name.includes("\0") || name.includes("\\")) return false;
  if (name.startsWith("/")) return false;
  if (/^[A-Za-z]:/.test(name)) return false;
  return !name.split("/").some((seg) => seg === ".." || seg === ".");
}

/**
 * Strip a single shared top-level directory, if every entry has one.
 *
 * GitHub release archives wrap their payload in `<repo>-<tag>/`; without this,
 * every such download would be rejected as "no .vmod at the top level".
 */
export function commonPrefix(names: string[]): string {
  const tops = new Set<string>();
  for (const n of names) {
    const i = n.indexOf("/");
    if (i <= 0) return "";
    tops.add(n.slice(0, i));
    if (tops.size > 1) return "";
  }
  return tops.size === 1 ? `${[...tops][0]}/` : "";
}

/** Basename of a `.vmod` with the extension removed, VASSAL-style (last dot). */
export function moduleBaseName(vmodName: string): string {
  const base = vmodName.slice(vmodName.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * Normalise a module basename for storage.
 *
 * The stored name ends up inside Webswing's `args` string, which is split with
 * Ant's `translateCommandline` — quotes in a filename would unbalance it. The
 * module file and its `_ext` directory are always renamed **together**, because
 * VASSAL derives one from the other; renaming only the module orphans every
 * extension.
 */
export function safeBaseName(base: string): string {
  const cleaned = base
    // Control characters, quotes and shell-ish metacharacters.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f"'`$\\|;&<>()]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return cleaned || "module";
}

/**
 * Decide what an archive is. Throws `ArchiveError` with the offending listing
 * rather than guessing — a wrong guess here silently publishes a broken game.
 */
export function classifyArchive(entryNames: string[]): ArchiveShape {
  const unsafe = entryNames.filter((n) => !isSafeEntryName(n));
  if (unsafe.length) {
    throw new ArchiveError("The archive contains unsafe entry paths.", unsafe.slice(0, 10));
  }

  // A `.vmod` IS a zip whose root holds `moduledata`.
  if (entryNames.includes("moduledata")) {
    return { kind: "module", modulePath: null, extPrefix: null, stripPrefix: "" };
  }

  const stripPrefix = commonPrefix(entryNames);
  const rel = (n: string) => (stripPrefix && n.startsWith(stripPrefix) ? n.slice(stripPrefix.length) : n);
  const inner = entryNames.map(rel).filter(Boolean);

  const vmods = inner.filter((n) => !n.includes("/") && /\.vmod$/i.test(n));
  if (vmods.length === 0) {
    throw new ArchiveError(
      "No VASSAL module found. Expected either a .vmod file, or a ZIP containing one.",
      inner.filter((n) => !n.includes("/")).slice(0, 20),
    );
  }
  if (vmods.length > 1) {
    throw new ArchiveError(
      "The archive holds more than one module. Ingest them one at a time.",
      vmods,
    );
  }

  const modulePath = vmods[0];
  const base = moduleBaseName(modulePath);
  const expectedExt = `${base}_ext/`;

  // Any *other* `_ext` directory means the archive was assembled around a
  // differently-named module; VASSAL would silently load none of it.
  const extDirs = new Set<string>();
  for (const n of inner) {
    const i = n.indexOf("/");
    if (i > 0 && n.slice(0, i).endsWith("_ext")) extDirs.add(`${n.slice(0, i)}/`);
  }
  const stray = [...extDirs].filter((d) => d !== expectedExt);
  if (stray.length) {
    throw new ArchiveError(
      `Extension directory does not match the module. VASSAL loads ${expectedExt} for ${modulePath}.`,
      stray,
    );
  }

  return {
    kind: "wrapper",
    modulePath,
    extPrefix: extDirs.has(expectedExt) ? expectedExt : null,
    stripPrefix,
  };
}

/** Read the fields VASSAL writes into a `moduledata` / `extensiondata` entry. */
export function parseModuleData(xml: string): ModuleData | null {
  const tag = (name: string): string => {
    const m = new RegExp(`<${name}\\s*>([\\s\\S]*?)</${name}>`).exec(xml);
    if (m) return decodeXmlText(m[1]).trim();
    // Self-closing (`<description/>`) is valid and means empty.
    return new RegExp(`<${name}\\s*/>`).test(xml) ? "" : "";
  };
  const name = tag("name");
  const version = tag("version");
  const vassalVersion = tag("VassalVersion");
  // Both forms always carry a version and the VASSAL release they were saved
  // with; neither means this is not VASSAL metadata. (`<name>` is a module-only
  // field, but which file we read — `moduledata` vs `extensiondata` — is what
  // actually tells the two apart.)
  if (!version && !vassalVersion) return null;
  return { name, version, vassalVersion, description: tag("description") };
}

function decodeXmlText(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");
}

/** Numeric-segment compare; returns >0 when `a` is newer than `b`. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) =>
    v
      .split(/[.\-+]/)
      .map((p) => Number.parseInt(p, 10))
      .map((n) => (Number.isFinite(n) ? n : 0));
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Turn a module's own name into a URL path segment. The result is both the
 * Webswing app path and the store directory, so it has to be boring.
 */
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
}

export function slugError(slug: string): string | null {
  if (!slug) return "A module needs a name to derive its URL from.";
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(slug)) {
    return "Module URLs may use lowercase letters, digits and hyphens only.";
  }
  if ((RESERVED_PATHS as readonly string[]).includes(slug)) {
    return `"${slug}" is reserved by the platform. Give the module a different URL.`;
  }
  return null;
}
