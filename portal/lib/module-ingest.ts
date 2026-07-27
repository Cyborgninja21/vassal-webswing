import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { env } from "@/lib/env";
import { BUILTIN_CATALOG } from "@/lib/catalog";
import {
  ArchiveError,
  classifyArchive,
  compareVersions,
  moduleBaseName,
  parseModuleData,
  safeBaseName,
  slugError,
  slugify,
  type ModuleData,
} from "@/lib/module-archive";
import { downloadTo, FetchRefused } from "@/lib/module-fetch";
import {
  moduleDir,
  moduleRegistry,
  motifFor,
  quarantineRoot,
  sha256File,
  type ExtensionRecord,
  type ModuleManifest,
} from "@/lib/modules";
import { extractAll, isZip, listEntries, readEntry } from "@/lib/zip";

/**
 * The ingest pipeline: fetch → digest → identify → validate → unpack → manifest.
 *
 * Every stage can abort the whole ingest, and nothing lands in the store until
 * the last one succeeds — the work happens in a quarantine directory on the
 * same filesystem and is promoted by a single `rename()`, so a failure halfway
 * leaves the store exactly as it was.
 *
 * The archive is treated as hostile throughout. That is not paranoia about the
 * *operator*: a VASSAL module legitimately contains compiled Java, which the
 * engine loads through its own classloader, so an ingested module is code we
 * have chosen to run. Validation cannot change that (see the plan's §5.1) —
 * what it can do is make sure the thing published is the thing approved, and
 * that unpacking it cannot write outside the store.
 */

export type IngestInput = {
  username: string;
  /** Exactly one of these two. */
  url?: string;
  upload?: { path: string; filename: string | null };
  /** Optional pin supplied by the operator; a mismatch aborts. */
  expectedSha256?: string;
  slug?: string;
  title?: string;
};

export type IngestResult = {
  manifest: ModuleManifest;
  warnings: string[];
};

export class IngestError extends Error {
  readonly detail: string[];
  readonly status: number;
  constructor(message: string, detail: string[] = [], status = 400) {
    super(message);
    this.name = "IngestError";
    this.detail = detail;
    this.status = status;
  }
}

const HIDDEN = /^\./;

async function countCodeEntries(zipFile: string): Promise<number> {
  const entries = await listEntries(zipFile);
  return entries.filter((e) => !e.isDirectory && /\.(class|jar)$/i.test(e.name)).length;
}

/** Read and parse a VASSAL metadata entry, or null when it is not one. */
async function readVassalData(zipFile: string, entry: string): Promise<ModuleData | null> {
  const buf = await readEntry(zipFile, entry);
  if (!buf) return null;
  return parseModuleData(buf.toString("utf8"));
}

export async function ingestModule(input: IngestInput): Promise<IngestResult> {
  const warnings: string[] = [];
  await fsp.mkdir(quarantineRoot(), { recursive: true });
  const work = path.join(quarantineRoot(), randomUUID());
  await fsp.mkdir(work, { recursive: true });

  try {
    // ── a. fetch ────────────────────────────────────────────────────────────
    const archive = path.join(work, "archive.bin");
    let archiveSha: string;
    let archiveBytes: number;
    let sourceUrl: string | null = null;
    let sourceFilename: string | null = null;

    if (input.url) {
      try {
        const dl = await downloadTo(input.url, archive);
        archiveSha = dl.sha256;
        archiveBytes = dl.bytes;
        sourceUrl = dl.finalUrl;
        sourceFilename = dl.filename;
      } catch (e) {
        if (e instanceof FetchRefused) throw new IngestError(e.message);
        throw new IngestError(`Download failed: ${(e as Error).message}`);
      }
    } else if (input.upload) {
      await fsp.rename(input.upload.path, archive);
      const stat = await fsp.stat(archive);
      archiveBytes = stat.size;
      if (archiveBytes > env.moduleMaxBytes) {
        throw new IngestError(
          `Upload exceeds the ${Math.round(env.moduleMaxBytes / 1024 / 1024)} MB limit.`,
        );
      }
      archiveSha = await sha256File(archive);
      sourceFilename = input.upload.filename;
    } else {
      throw new IngestError("Provide either a URL or a file.");
    }

    // ── b. digest ───────────────────────────────────────────────────────────
    if (input.expectedSha256) {
      const want = input.expectedSha256.trim().toLowerCase();
      if (want !== archiveSha) {
        throw new IngestError("Checksum mismatch — refusing to ingest.", [
          `expected ${want}`,
          `actual   ${archiveSha}`,
        ]);
      }
    }

    // ── c. identify ─────────────────────────────────────────────────────────
    if (!(await isZip(archive))) {
      throw new IngestError(
        "That file is not a ZIP archive. VASSAL modules (.vmod) and their wrappers both are.",
      );
    }
    const entries = await listEntries(archive);
    if (entries.length > env.moduleMaxEntries) {
      throw new IngestError(`Archive has more than ${env.moduleMaxEntries} entries.`);
    }
    let shape;
    try {
      shape = classifyArchive(entries.map((e) => e.name));
    } catch (e) {
      if (e instanceof ArchiveError) throw new IngestError(e.message, e.detail);
      throw e;
    }

    // ── e. unpack (into staging, still inside quarantine) ───────────────────
    const staged = path.join(work, "staged");
    await fsp.mkdir(staged, { recursive: true });

    let moduleFile: string;
    let extDir: string | null = null;

    if (shape.kind === "module") {
      // The download *is* the module. Name it after the source when we can:
      // the basename decides where VASSAL would look for extensions, and a
      // bare module has none, but a recognisable filename helps an operator
      // reading the store later.
      const hint = sourceFilename ?? "";
      moduleFile = /\.vmod$/i.test(hint) ? `${safeBaseName(moduleBaseName(hint))}.vmod` : "module.vmod";
      await fsp.copyFile(archive, path.join(staged, moduleFile));
    } else {
      const raw = path.join(work, "raw");
      await fsp.mkdir(raw, { recursive: true });
      await extractAll(archive, raw, {
        maxBytes: env.moduleMaxUnpackedBytes,
        maxEntries: env.moduleMaxEntries,
      });
      const contentRoot = path.join(raw, shape.stripPrefix);

      // Normalise the basename, renaming the module and its extension
      // directory **together** — VASSAL derives one from the other, so a
      // one-sided rename would leave every extension orphaned.
      const rawBase = moduleBaseName(shape.modulePath);
      const base = safeBaseName(rawBase);
      moduleFile = `${base}.vmod`;
      await fsp.rename(path.join(contentRoot, shape.modulePath), path.join(staged, moduleFile));
      if (base !== rawBase) {
        warnings.push(`Stored the module as ${moduleFile} (the original name needed escaping).`);
      }

      if (shape.extPrefix) {
        extDir = `${base}_ext`;
        await fsp.rename(
          path.join(contentRoot, shape.extPrefix.replace(/\/$/, "")),
          path.join(staged, extDir),
        );
      }

      const ignored = (await fsp.readdir(contentRoot)).filter((n) => !HIDDEN.test(n));
      if (ignored.length) {
        warnings.push(
          `Ignored ${ignored.length} extra file${ignored.length === 1 ? "" : "s"} in the archive: ` +
            ignored.slice(0, 6).join(", ") +
            (ignored.length > 6 ? ", …" : ""),
        );
      }
    }

    // ── d. validate ─────────────────────────────────────────────────────────
    const stagedModule = path.join(staged, moduleFile);
    const data = await readVassalData(stagedModule, "moduledata");
    if (!data) {
      throw new IngestError(
        `${moduleFile} has no readable VASSAL module metadata — it is not a module.`,
      );
    }
    if (!data.name) {
      throw new IngestError(`${moduleFile} declares no module name; VASSAL could not key it.`);
    }
    if (
      data.vassalVersion &&
      compareVersions(data.vassalVersion, env.vassalEngineVersion) > 0
    ) {
      throw new IngestError(
        `This module was saved with VASSAL ${data.vassalVersion}; the platform runs ` +
          `${env.vassalEngineVersion} and cannot open it.`,
      );
    }

    const codeEntries = await countCodeEntries(stagedModule);
    const extensions: ExtensionRecord[] = [];

    if (extDir) {
      const dirents = await fsp.readdir(path.join(staged, extDir), { withFileTypes: true });
      const rejected: string[] = [];
      for (const d of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
        // VASSAL's own filter: skip hidden files and subdirectories (`inactive/`
        // is a directory and is deliberately not loaded).
        if (!d.isFile() || HIDDEN.test(d.name)) continue;
        const file = path.join(staged, extDir, d.name);
        const meta = (await isZip(file)) ? await readVassalData(file, "extensiondata") : null;
        if (!meta) {
          rejected.push(d.name);
          continue;
        }
        const stat = await fsp.stat(file);
        extensions.push({
          name: d.name,
          size: stat.size,
          sha256: await sha256File(file),
          version: meta.version,
          vassalVersion: meta.vassalVersion,
          description: meta.description,
          codeEntries: await countCodeEntries(file),
        });
      }
      if (rejected.length) {
        // Loud, not silent: VASSAL skips an unreadable extension without a
        // word, and the operator would be left hunting a missing army list.
        throw new IngestError(
          `${rejected.length} file${rejected.length === 1 ? "" : "s"} in ${extDir} ` +
            "are not VASSAL extensions. VASSAL would ignore them silently, so ingest stops here.",
          rejected.slice(0, 12),
        );
      }
      const subdirs = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
      if (subdirs.length) {
        warnings.push(
          `${extDir} contains ${subdirs.join(", ")} — VASSAL does not load subdirectories.`,
        );
      }
    }

    // ── f. identity + collision ─────────────────────────────────────────────
    const title = (input.title ?? "").trim() || data.name;
    const slug = (input.slug ?? "").trim().toLowerCase() || slugify(data.name);
    const slugProblem = slugError(slug);
    if (slugProblem) throw new IngestError(slugProblem);

    if (BUILTIN_CATALOG.some((m) => m.path === `/${slug}`)) {
      throw new IngestError(`/${slug} is already served by a built-in module.`);
    }
    if (moduleRegistry.get(slug)) {
      throw new IngestError(
        `A module is already published at /${slug}. Remove it first, or choose another URL.`,
        [],
        409,
      );
    }

    // Sanity: the extension directory VASSAL will look for must be the one we
    // just staged. Getting this wrong loads the module with zero extensions.
    if (extDir && `${moduleBaseName(moduleFile)}_ext` !== extDir) {
      throw new IngestError(
        `Internal layout check failed: VASSAL would look for ${moduleBaseName(moduleFile)}_ext, not ${extDir}.`,
      );
    }

    const codeTotal = codeEntries + extensions.reduce((n, e) => n + e.codeEntries, 0);
    if (codeTotal > 0) {
      warnings.push(
        `This module ships ${codeTotal} compiled Java entr${codeTotal === 1 ? "y" : "ies"}, ` +
          "which VASSAL loads and runs in the container. Publish it only from a source you trust.",
      );
    }

    const manifest: ModuleManifest = {
      slug,
      title,
      vassalModuleName: data.name,
      version: data.version,
      vassalVersion: data.vassalVersion,
      description: data.description,
      moduleFile,
      extDir,
      extensions,
      archiveSha256: archiveSha,
      archiveBytes,
      sourceUrl,
      sourceFilename,
      codeEntries,
      ingestedBy: input.username,
      ingestedAt: Date.now(),
      enabled: true,
      motif: motifFor(slug),
      maxClients: env.moduleDefaultMaxClients,
      heap: env.moduleDefaultHeap,
    };

    await fsp.writeFile(
      path.join(staged, "module.json"),
      JSON.stringify(manifest, null, 2),
      "utf8",
    );

    // ── g. promote ──────────────────────────────────────────────────────────
    await fsp.rename(staged, moduleDir(slug));
    await moduleRegistry.reload();

    return { manifest, warnings };
  } finally {
    await fsp.rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}
