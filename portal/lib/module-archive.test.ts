import { describe, expect, it } from "vitest";
import {
  ArchiveError,
  classifyArchive,
  commonPrefix,
  compareVersions,
  isSafeEntryName,
  moduleBaseName,
  parseModuleData,
  safeBaseName,
  slugError,
  slugify,
} from "@/lib/module-archive";

/**
 * Fixtures are the real shapes, taken from actual VASSAL distributions:
 * `V40K_9_2.ZIP` (a wrapper: one module plus 58 extensionless extensions) and
 * the `.vmod` files the module library serves directly.
 */

describe("isSafeEntryName", () => {
  it("accepts ordinary names, including ones with no file extension", () => {
    expect(isSafeEntryName("vassal40k9.vmod")).toBe(true);
    expect(isSafeEntryName("vassal40k9_ext/Space Marines")).toBe(true);
    expect(isSafeEntryName("a/b/c.png")).toBe(true);
  });

  it("refuses traversal, absolute and Windows paths", () => {
    expect(isSafeEntryName("../etc/passwd")).toBe(false);
    expect(isSafeEntryName("a/../../b")).toBe(false);
    expect(isSafeEntryName("/etc/passwd")).toBe(false);
    expect(isSafeEntryName("C:/windows/system32")).toBe(false);
    expect(isSafeEntryName("a\\b")).toBe(false);
    expect(isSafeEntryName("a\0b")).toBe(false);
    expect(isSafeEntryName("")).toBe(false);
  });
});

describe("commonPrefix", () => {
  it("strips a single wrapping directory, as GitHub release zips have", () => {
    expect(commonPrefix(["mod-1.0/a.vmod", "mod-1.0/a_ext/x"])).toBe("mod-1.0/");
  });

  it("keeps the root when entries are already top-level or mixed", () => {
    expect(commonPrefix(["a.vmod", "a_ext/x"])).toBe("");
    expect(commonPrefix(["one/a.vmod", "two/b"])).toBe("");
  });
});

describe("moduleBaseName", () => {
  it("splits on the LAST dot, matching ExtensionsManager", () => {
    expect(moduleBaseName("vassal40k9.vmod")).toBe("vassal40k9");
    expect(moduleBaseName("Twilight-Struggle-3.2.vmod")).toBe("Twilight-Struggle-3.2");
    expect(moduleBaseName("dir/Here_I_Stand_500th_3.5.0.vmod")).toBe("Here_I_Stand_500th_3.5.0");
  });
});

describe("safeBaseName", () => {
  it("removes quoting hazards and collapses whitespace", () => {
    expect(safeBaseName('My "Module"')).toBe("My-Module");
    expect(safeBaseName("a'b`c$d")).toBe("abcd");
    expect(safeBaseName("  spaced   out  ")).toBe("spaced-out");
  });

  it("never returns an empty name", () => {
    expect(safeBaseName('"""')).toBe("module");
  });

  it("leaves already-safe names untouched, so the _ext pairing is stable", () => {
    expect(safeBaseName("vassal40k9")).toBe("vassal40k9");
    expect(safeBaseName("Paths_of_Glory_10.8")).toBe("Paths_of_Glory_10.8");
  });
});

describe("classifyArchive", () => {
  it("recognises a bare .vmod by its moduledata entry", () => {
    const shape = classifyArchive(["moduledata", "buildFile.xml", "images/a.png"]);
    expect(shape.kind).toBe("module");
  });

  it("recognises the module + extension-directory wrapper", () => {
    const shape = classifyArchive([
      "vassal40k9.vmod",
      "vassal40k9_ext/",
      "vassal40k9_ext/Cards",
      "vassal40k9_ext/Space Marines",
    ]);
    expect(shape).toMatchObject({
      kind: "wrapper",
      modulePath: "vassal40k9.vmod",
      extPrefix: "vassal40k9_ext/",
      stripPrefix: "",
    });
  });

  it("sees through a single wrapping directory", () => {
    const shape = classifyArchive(["rel-9.2/vassal40k9.vmod", "rel-9.2/vassal40k9_ext/Cards"]);
    expect(shape).toMatchObject({
      kind: "wrapper",
      modulePath: "vassal40k9.vmod",
      extPrefix: "vassal40k9_ext/",
      stripPrefix: "rel-9.2/",
    });
  });

  it("accepts a wrapper with no extensions at all", () => {
    const shape = classifyArchive(["Some_Module.vmod", "readme.txt"]);
    expect(shape).toMatchObject({ kind: "wrapper", extPrefix: null });
  });

  it("refuses an archive with no module", () => {
    expect(() => classifyArchive(["readme.txt", "art/box.png"])).toThrow(ArchiveError);
  });

  it("refuses two modules rather than guessing which one is wanted", () => {
    expect(() => classifyArchive(["a.vmod", "b.vmod"])).toThrow(/more than one module/);
  });

  it("refuses an extension directory whose basename does not match the module", () => {
    // VASSAL would load none of it, silently — the whole reason to fail here.
    expect(() => classifyArchive(["a.vmod", "b_ext/Cards"])).toThrow(/does not match/);
  });

  it("refuses unsafe entry names outright", () => {
    expect(() => classifyArchive(["../evil.vmod"])).toThrow(/unsafe entry paths/);
  });
});

describe("parseModuleData", () => {
  const V40K = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<data version="1">
  <version>9.2</version>
  <VassalVersion>3.6.5</VassalVersion>
  <dateSaved>1646875982771</dateSaved>
  <description>Coldfix number 2 version. Updates and general talk on Reddit (https://www.reddit.com/r/Vassal40k/)</description>
  <name>Vassal 40k</name>
</data>`;

  it("reads the fields ingest keys on", () => {
    expect(parseModuleData(V40K)).toEqual({
      name: "Vassal 40k",
      version: "9.2",
      vassalVersion: "3.6.5",
      description:
        "Coldfix number 2 version. Updates and general talk on Reddit (https://www.reddit.com/r/Vassal40k/)",
    });
  });

  it("handles a self-closing empty description, as extensions ship", () => {
    const ext = `<data version="1"><version>0.1</version><VassalVersion>3.4.1</VassalVersion><description/><universal>true</universal></data>`;
    expect(parseModuleData(ext)).toMatchObject({ version: "0.1", description: "" });
  });

  it("decodes XML entities", () => {
    const xml = `<data><version>1</version><name>Tom &amp; Jerry &lt;3</name></data>`;
    expect(parseModuleData(xml)?.name).toBe("Tom & Jerry <3");
  });

  it("returns null for something that is not VASSAL metadata", () => {
    expect(parseModuleData("<html><body>404</body></html>")).toBeNull();
  });
});

describe("compareVersions", () => {
  it("orders VASSAL releases numerically, not lexically", () => {
    expect(compareVersions("3.6.5", "3.7.24")).toBeLessThan(0);
    // 3.7.9 vs 3.7.24 is the case a string compare gets wrong.
    expect(compareVersions("3.7.9", "3.7.24")).toBeLessThan(0);
    expect(compareVersions("3.8.0", "3.7.24")).toBeGreaterThan(0);
    expect(compareVersions("3.7.24", "3.7.24")).toBe(0);
  });

  it("tolerates suffixes and missing segments", () => {
    expect(compareVersions("3.7", "3.7.0")).toBe(0);
    expect(compareVersions("3.7.24-SNAPSHOT", "3.7.24")).toBe(0);
  });
});

describe("slugify / slugError", () => {
  it("derives a URL segment from VASSAL's own module name", () => {
    expect(slugify("Vassal 40k")).toBe("vassal-40k");
    expect(slugify("Here I Stand (500th Anniversary Edition)")).toBe(
      "here-i-stand-500th-anniversary-edition",
    );
    expect(slugify("Café Résistance")).toBe("cafe-resistance");
  });

  it("rejects reserved platform paths", () => {
    expect(slugError("api")).toMatch(/reserved/);
    expect(slugError("async")).toMatch(/reserved/);
    expect(slugError("watch")).toMatch(/reserved/);
  });

  it("rejects malformed slugs and accepts good ones", () => {
    expect(slugError("")).toBeTruthy();
    expect(slugError("Has Capitals")).toBeTruthy();
    expect(slugError("-leading")).toBeTruthy();
    expect(slugError("vassal-40k")).toBeNull();
  });
});
