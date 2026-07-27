import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { env } from "@/lib/env";
import type { Motif } from "@/lib/catalog";

/**
 * The ingested-module registry.
 *
 * Each module is a directory on the shared store holding the `.vmod`, its
 * `<base>_ext/` tree if it has one, and a `module.json` manifest. The manifest
 * is the record of what a human approved: where it came from, what its bytes
 * hash to, what VASSAL says it is, and how much compiled code it ships.
 *
 * State lives on disk rather than in a database because the files have to be
 * there anyway — a second store could only disagree with them. The in-memory
 * copy is a cache, rebuilt from disk at boot and after every mutation, so the
 * synchronous catalog lookups the rest of the portal already does keep working.
 */

export type ExtensionRecord = {
  /** Filename as VASSAL will see it — extensionless names are normal. */
  name: string;
  size: number;
  sha256: string;
  version: string;
  vassalVersion: string;
  description: string;
  /** `.class`/`.jar` entries this extension carries. */
  codeEntries: number;
};

export type ModuleManifest = {
  /** URL path segment, store directory name, and Webswing app path (`/<slug>`). */
  slug: string;
  /** Operator-facing title. Defaults to VASSAL's own module name. */
  title: string;
  /** VASSAL's internal module name — what `Prefs.sanitize()` acts on. */
  vassalModuleName: string;
  version: string;
  vassalVersion: string;
  description: string;

  /** File name of the module inside the store directory. */
  moduleFile: string;
  /** Extension directory name, or null when the module ships none. */
  extDir: string | null;
  extensions: ExtensionRecord[];

  /** sha256 of the archive exactly as downloaded. The pin. */
  archiveSha256: string;
  archiveBytes: number;
  sourceUrl: string | null;
  sourceFilename: string | null;

  /** `.class`/`.jar` entries in the module archive itself. */
  codeEntries: number;

  ingestedBy: string;
  ingestedAt: number;
  enabled: boolean;

  /** Catalog presentation. Chosen at ingest, overridable by the operator. */
  motif: Motif;
  maxClients: number;
  heap: string;
};

const MANIFEST = "module.json";
/** Retired modules are renamed here, never deleted on a click. */
const REMOVED_DIR = ".removed";
/** Downloads land here first; promoted into place by a single rename. */
const QUARANTINE_DIR = ".quarantine";

export function moduleDir(slug: string): string {
  return path.join(env.modulesDir, slug);
}

export function quarantineRoot(): string {
  return path.join(env.modulesDir, QUARANTINE_DIR);
}

export function removedRoot(): string {
  return path.join(env.modulesDir, REMOVED_DIR);
}

/** Absolute path VASSAL is pointed at, inside the Webswing container. */
export function moduleFilePath(m: ModuleManifest): string {
  return path.posix.join(env.modulesDir, m.slug, m.moduleFile);
}

export async function sha256File(file: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest("hex");
}

class ModuleRegistry {
  private cache: ModuleManifest[] | null = null;
  /** Serialises read-modify-write; the portal is single-replica by design. */
  private queue: Promise<unknown> = Promise.resolve();

  /**
   * Synchronous view for the catalog. Returns an empty list until the first
   * `reload()` — `instrumentation.ts` does that before the first request, and
   * an empty catalog degrades to "built-in modules only" rather than an error.
   */
  snapshot(): ModuleManifest[] {
    return this.cache ?? [];
  }

  enabled(): ModuleManifest[] {
    return this.snapshot().filter((m) => m.enabled);
  }

  get(slug: string): ModuleManifest | null {
    return this.snapshot().find((m) => m.slug === slug) ?? null;
  }

  /** Rebuild the cache by scanning the store. Safe to call at any time. */
  async reload(): Promise<ModuleManifest[]> {
    const found: ModuleManifest[] = [];
    let dirents: import("node:fs").Dirent[];
    try {
      dirents = await fsp.readdir(env.modulesDir, { withFileTypes: true });
    } catch {
      // No store mounted yet: built-in modules still work.
      this.cache = [];
      return this.cache;
    }

    for (const d of dirents) {
      if (!d.isDirectory() || d.name.startsWith(".")) continue;
      try {
        const raw = await fsp.readFile(path.join(env.modulesDir, d.name, MANIFEST), "utf8");
        const m = JSON.parse(raw) as ModuleManifest;
        // The directory name is authoritative: it is what the URL resolves to.
        if (m && typeof m === "object" && m.moduleFile) found.push({ ...m, slug: d.name });
      } catch {
        // A directory without a readable manifest is not a module. Ignore it
        // rather than failing the whole registry over one bad entry.
      }
    }

    found.sort((a, b) => a.title.localeCompare(b.title));
    this.cache = found;
    return found;
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Write a manifest into an already-populated module directory. */
  async save(manifest: ModuleManifest): Promise<ModuleManifest> {
    return this.run(async () => {
      const dir = moduleDir(manifest.slug);
      const tmp = path.join(dir, `${MANIFEST}.tmp`);
      await fsp.writeFile(tmp, JSON.stringify(manifest, null, 2), "utf8");
      await fsp.rename(tmp, path.join(dir, MANIFEST));
      await this.reload();
      return manifest;
    });
  }

  async update(
    slug: string,
    patch: Partial<Pick<ModuleManifest, "title" | "enabled" | "motif" | "maxClients" | "heap">>,
  ): Promise<ModuleManifest | null> {
    const current = this.get(slug);
    if (!current) return null;
    return this.save({ ...current, ...patch });
  }

  /**
   * Retire a module: rename its directory aside so the operation is reversible
   * and instant. Deleting hundreds of megabytes on a click is not something to
   * offer when the store's snapshot backup is not proven.
   */
  async retire(slug: string, stamp: string): Promise<string | null> {
    return this.run(async () => {
      const dir = moduleDir(slug);
      try {
        await fsp.access(dir);
      } catch {
        return null;
      }
      await fsp.mkdir(removedRoot(), { recursive: true });
      const dest = path.join(removedRoot(), `${slug}-${stamp}`);
      await fsp.rename(dir, dest);
      await this.reload();
      return dest;
    });
  }

  /**
   * Re-hash every file against the manifest. Returns the list of differences —
   * empty means the store still holds exactly what was approved.
   */
  async verify(slug: string): Promise<string[] | null> {
    const m = this.get(slug);
    if (!m) return null;
    const problems: string[] = [];
    const dir = moduleDir(slug);

    try {
      await fsp.access(path.join(dir, m.moduleFile));
    } catch {
      problems.push(`missing module file ${m.moduleFile}`);
    }

    for (const ext of m.extensions) {
      const file = path.join(dir, m.extDir ?? "", ext.name);
      try {
        const digest = await sha256File(file);
        if (digest !== ext.sha256) problems.push(`checksum changed: ${ext.name}`);
      } catch {
        problems.push(`missing extension ${ext.name}`);
      }
    }

    if (m.extDir) {
      const known = new Set(m.extensions.map((e) => e.name));
      try {
        for (const d of await fsp.readdir(path.join(dir, m.extDir), { withFileTypes: true })) {
          if (d.isFile() && !known.has(d.name)) problems.push(`unexpected extension ${d.name}`);
        }
      } catch {
        problems.push(`missing extension directory ${m.extDir}`);
      }
    }

    return problems;
  }
}

const globalForModules = globalThis as unknown as { __vassalModuleRegistry?: ModuleRegistry };
export const moduleRegistry: ModuleRegistry = (globalForModules.__vassalModuleRegistry ??=
  new ModuleRegistry());

/** Deterministic tile motif, so a module always looks the same to everyone. */
export function motifFor(slug: string): Motif {
  const motifs: Motif[] = ["shield", "globe", "trenches"];
  let h = 0;
  for (const ch of slug) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return motifs[h % motifs.length];
}
