import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

/** Real-archive check. Skipped unless V40K_ZIP points at the sample. */
const ARCHIVE = process.env.V40K_ZIP ?? "";
const run = ARCHIVE ? describe : describe.skip;

run("ingest of a real 318 MB module", () => {
  let store: string;
  let result: Awaited<ReturnType<typeof import("@/lib/module-ingest").ingestModule>>;

  beforeAll(async () => {
    store = await fsp.mkdtemp(path.join(os.tmpdir(), "vassal-store-"));
    process.env.VASSAL_MODULES_DIR = store;
    const { ingestModule } = await import("@/lib/module-ingest");
    const copy = path.join(store, "upload.bin");
    await fsp.mkdir(path.dirname(copy), { recursive: true });
    await fsp.copyFile(ARCHIVE, copy);
    result = await ingestModule({
      username: "test",
      upload: { path: copy, filename: "V40K_9_2.ZIP" },
    });
  }, 900_000);

  it("reads identity straight out of moduledata", () => {
    expect(result.manifest.vassalModuleName).toBe("Vassal 40k");
    expect(result.manifest.version).toBe("9.2");
    expect(result.manifest.vassalVersion).toBe("3.6.5");
    expect(result.manifest.slug).toBe("vassal-40k");
  });

  it("lands the module and all 57 extensions with names intact", async () => {
    const dir = path.join(store, "vassal-40k");
    expect(result.manifest.moduleFile).toBe("vassal40k9.vmod");
    expect(result.manifest.extDir).toBe("vassal40k9_ext");
    expect(result.manifest.extensions).toHaveLength(57);
    const names = result.manifest.extensions.map((e) => e.name);
    expect(names).toContain("Space Marines");
    expect(names).toContain("Cards");
    expect(names).toContain("AOS-Skaven");
    const onDisk = await fsp.readdir(path.join(dir, "vassal40k9_ext"));
    expect(onDisk.sort()).toEqual(names.sort());
  });

  it("counts the compiled Java it ships", () => {
    const total =
      result.manifest.codeEntries +
      result.manifest.extensions.reduce((n, e) => n + e.codeEntries, 0);
    expect(result.manifest.codeEntries).toBe(1);
    expect(total).toBe(129);
    expect(result.warnings.join(" ")).toMatch(/compiled Java/);
  });

  it("re-verifies clean, and detects a corrupted byte", async () => {
    const { moduleRegistry } = await import("@/lib/modules");
    await moduleRegistry.reload();
    expect(await moduleRegistry.verify("vassal-40k")).toEqual([]);

    const victim = path.join(store, "vassal-40k", "vassal40k9_ext", "AOS-Skaven");
    const buf = await fsp.readFile(victim);
    buf[buf.length - 1] ^= 0xff;
    await fsp.writeFile(victim, buf);
    expect(await moduleRegistry.verify("vassal-40k")).toEqual(["checksum changed: AOS-Skaven"]);
  });
});
