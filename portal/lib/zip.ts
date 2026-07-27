import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";

/**
 * Promisified ZIP reading, scoped to exactly what module ingest needs.
 *
 * Everything here treats the archive as hostile input: entry names are checked
 * before they are ever joined onto a path, sizes are checked before anything is
 * inflated, and `lazyEntries` keeps the caller in control so a 20 000-entry
 * archive cannot be walked into memory by accident.
 *
 * A VASSAL module is itself a ZIP, so nested reads happen — but only against
 * files already written to disk, never against a stream inside another stream.
 */

export type ZipEntry = {
  /** Raw name as stored in the archive. Never trust it as a path. */
  name: string;
  uncompressedSize: number;
  compressedSize: number;
  isDirectory: boolean;
  /** Unix mode from the external attributes, when the archive carries one. */
  unixMode: number;
};

function open(file: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: false }, (err, zip) => {
      if (err || !zip) reject(err ?? new Error("not a zip archive"));
      else resolve(zip);
    });
  });
}

/** True when the archive can be opened and its central directory parsed. */
export async function isZip(file: string): Promise<boolean> {
  try {
    const zip = await open(file);
    zip.close();
    return true;
  } catch {
    return false;
  }
}

export async function listEntries(file: string): Promise<ZipEntry[]> {
  const zip = await open(file);
  const entries: ZipEntry[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      zip.on("entry", (e: yauzl.Entry) => {
        entries.push({
          name: e.fileName,
          uncompressedSize: e.uncompressedSize,
          compressedSize: e.compressedSize,
          isDirectory: /\/$/.test(e.fileName),
          unixMode: (e.externalFileAttributes >>> 16) & 0xffff,
        });
        zip.readEntry();
      });
      zip.on("end", resolve);
      zip.on("error", reject);
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
  return entries;
}

/**
 * Read one entry fully into memory. Only for small metadata entries
 * (`moduledata`, `extensiondata`) — `limit` is the contract that keeps it so.
 */
export async function readEntry(
  file: string,
  wanted: string,
  limit = 1024 * 1024,
): Promise<Buffer | null> {
  const zip = await open(file);
  try {
    return await new Promise<Buffer | null>((resolve, reject) => {
      let settled = false;
      const done = (v: Buffer | null) => {
        if (!settled) {
          settled = true;
          resolve(v);
        }
      };
      zip.on("entry", (e: yauzl.Entry) => {
        if (e.fileName !== wanted) {
          zip.readEntry();
          return;
        }
        if (e.uncompressedSize > limit) {
          done(null);
          return;
        }
        zip.openReadStream(e, (err, stream) => {
          if (err || !stream) {
            reject(err ?? new Error(`cannot read ${wanted}`));
            return;
          }
          const chunks: Buffer[] = [];
          stream.on("data", (c: Buffer) => chunks.push(c));
          stream.on("end", () => done(Buffer.concat(chunks)));
          stream.on("error", reject);
        });
      });
      zip.on("end", () => done(null));
      zip.on("error", reject);
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
}

/**
 * Extract every entry into `destDir`, preserving relative layout.
 *
 * `safeName` must have already vetted each name (see module-archive.ts) — this
 * re-checks anyway, because the cost of being wrong is a write outside the
 * quarantine directory.
 */
export async function extractAll(
  file: string,
  destDir: string,
  opts: { maxBytes: number; maxEntries: number },
): Promise<number> {
  const zip = await open(file);
  const root = path.resolve(destDir);
  let written = 0;
  let count = 0;

  try {
    await new Promise<void>((resolve, reject) => {
      const fail = (msg: string) => reject(new Error(msg));

      zip.on("entry", (e: yauzl.Entry) => {
        void (async () => {
          try {
            count += 1;
            if (count > opts.maxEntries) {
              fail(`archive has more than ${opts.maxEntries} entries`);
              return;
            }

            const target = path.resolve(root, e.fileName);
            if (target !== root && !target.startsWith(root + path.sep)) {
              fail(`entry escapes the destination: ${e.fileName}`);
              return;
            }

            if (/\/$/.test(e.fileName)) {
              await fsp.mkdir(target, { recursive: true });
              zip.readEntry();
              return;
            }

            // Symlinks would let a later entry write through them.
            const mode = (e.externalFileAttributes >>> 16) & 0xf000;
            if (mode === 0xa000) {
              fail(`archive contains a symlink: ${e.fileName}`);
              return;
            }

            written += e.uncompressedSize;
            if (written > opts.maxBytes) {
              fail(`archive inflates to more than ${opts.maxBytes} bytes`);
              return;
            }

            await fsp.mkdir(path.dirname(target), { recursive: true });
            const stream = await new Promise<NodeJS.ReadableStream>((res, rej) =>
              zip.openReadStream(e, (err, s) =>
                err || !s ? rej(err ?? new Error("read failed")) : res(s),
              ),
            );
            await pipeline(stream, fs.createWriteStream(target, { mode: 0o644 }));
            zip.readEntry();
          } catch (err) {
            reject(err);
          }
        })();
      });

      zip.on("end", resolve);
      zip.on("error", reject);
      zip.readEntry();
    });
  } finally {
    zip.close();
  }

  return written;
}
