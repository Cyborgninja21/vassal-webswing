import { describe, expect, it } from "vitest";
import {
  formatProperties,
  parseProperties,
  sanitizePrefsName,
} from "@/lib/java-properties";

// Samples lifted verbatim from a live per-player prefs directory
// (/data/users/<user>/.VASSAL/prefs) so the encoding is pinned to reality
// rather than to my reading of the Java source.
const LIVE_V_GLOBAL = `#Sun Jul 26 15:20:47 EDT 2026
Locale=en
ServerAddressBook=description\\=VASSAL Server|type\\=official,description\\=Private Server|nodeHost\\=vassal-lobby|nodePort\\=5050|type\\=private
welcomeWizard=false
`;

describe("parseProperties", () => {
  it("unescapes the escaped = that VASSAL writes inside values", () => {
    const props = parseProperties(LIVE_V_GLOBAL);
    expect(props.get("Locale")).toBe("en");
    expect(props.get("welcomeWizard")).toBe("false");
    expect(props.get("ServerAddressBook")).toBe(
      "description=VASSAL Server|type=official,description=Private Server|nodeHost=vassal-lobby|nodePort=5050|type=private",
    );
  });

  it("ignores comments and blank lines", () => {
    expect([...parseProperties("#c\n\n! bang\na=1\n").keys()]).toEqual(["a"]);
  });

  it("handles line continuations", () => {
    expect(parseProperties("a=one\\\n  two\n").get("a")).toBe("onetwo");
  });

  it("accepts colon and bare-space separators", () => {
    const props = parseProperties("a:1\nb 2\nc = 3\n");
    expect([props.get("a"), props.get("b"), props.get("c")]).toEqual(["1", "2", "3"]);
  });
});

describe("formatProperties", () => {
  it("round-trips a live file byte-for-byte on the value side", () => {
    const parsed = parseProperties(LIVE_V_GLOBAL);
    const out = formatProperties(parsed);
    expect(out).toContain(
      "ServerAddressBook=description\\=VASSAL Server|type\\=official,description\\=Private Server|nodeHost\\=vassal-lobby|nodePort\\=5050|type\\=private",
    );
    // and re-parses to the same map
    expect(parseProperties(out)).toEqual(parsed);
  });

  it("escapes the characters Properties.store escapes in values", () => {
    const out = formatProperties(new Map([["k", "a=b:c#d!e\\f\ng"]]));
    expect(out.trim()).toBe("k=a\\=b\\:c\\#d\\!e\\\\f\\ng");
  });

  it("escapes a leading space in a value but not interior spaces", () => {
    expect(formatProperties(new Map([["k", " lead mid"]])).trim()).toBe("k=\\ lead mid");
  });
});

describe("sanitizePrefsName", () => {
  it("reproduces the real on-disk module prefs filenames", () => {
    expect(sanitizePrefsName("Here I Stand (500th Anniversary Edition)")).toBe(
      "Here_20_I_20_Stand_20__28_500th_20_Anniversary_20_Edition_29_",
    );
    expect(sanitizePrefsName("Paths of Glory")).toBe("Paths_20_of_20_Glory");
  });
});
