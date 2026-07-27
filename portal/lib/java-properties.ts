/**
 * Java `.properties` read/write, faithful enough to round-trip VASSAL prefs.
 *
 * VASSAL stores every preference file with `java.util.Properties.store()`, so
 * writing them from Node means reproducing `saveConvert()` exactly: `=`, `:`,
 * `#` and `!` are escaped **in values as well as keys**, which is why the live
 * files contain things like
 *
 *     ServerAddressBook=description\=VASSAL Server|type\=official,...
 *
 * Getting this wrong does not throw — VASSAL simply reads a mangled value and
 * silently ignores the setting, so the tests in java-properties.test.ts pin the
 * exact byte output against samples taken from a real prefs file.
 */

/** Mirrors java.util.Properties#saveConvert(theString, escapeSpace, escapeUnicode=false). */
export function escape(value: string, escapeLeadingSpace: boolean): string {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    switch (ch) {
      case "\\":
        out += "\\\\";
        break;
      case "\t":
        out += "\\t";
        break;
      case "\n":
        out += "\\n";
        break;
      case "\r":
        out += "\\r";
        break;
      case "\f":
        out += "\\f";
        break;
      case " ":
        // Only a leading space needs escaping in a value; a key escapes them all.
        out += i === 0 || escapeLeadingSpace ? "\\ " : " ";
        break;
      case "=":
      case ":":
      case "#":
      case "!":
        out += `\\${ch}`;
        break;
      default:
        out += ch;
    }
  }
  return out;
}

function unescape(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    i += 1;
    const next = value[i];
    if (next === undefined) break;
    switch (next) {
      case "t": out += "\t"; break;
      case "n": out += "\n"; break;
      case "r": out += "\r"; break;
      case "f": out += "\f"; break;
      case "u": {
        const hex = value.slice(i + 1, i + 5);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else {
          out += "u";
        }
        break;
      }
      default: out += next;
    }
  }
  return out;
}

/**
 * Parse a properties file. Comments, blank lines and line continuations are
 * handled; ordering is not preserved (we always rewrite the whole file).
 */
export function parseProperties(text: string): Map<string, string> {
  const result = new Map<string, string>();

  // Join continuation lines (a line ending in an odd number of backslashes).
  const logical: string[] = [];
  let pending = "";
  for (const raw of text.split(/\r\n|\n|\r/)) {
    const line = pending ? pending + raw.replace(/^\s+/, "") : raw;
    const trailing = line.match(/\\*$/)?.[0].length ?? 0;
    if (trailing % 2 === 1) {
      pending = line.slice(0, -1);
      continue;
    }
    pending = "";
    logical.push(line);
  }
  if (pending) logical.push(pending);

  for (const line of logical) {
    const trimmed = line.replace(/^[ \t\f]+/, "");
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) continue;

    // The separator is the first unescaped =, : or whitespace run.
    let key = "";
    let i = 0;
    for (; i < trimmed.length; i += 1) {
      const ch = trimmed[i];
      if (ch === "\\") {
        key += ch + (trimmed[i + 1] ?? "");
        i += 1;
        continue;
      }
      if (ch === "=" || ch === ":" || ch === " " || ch === "\t" || ch === "\f") break;
      key += ch;
    }
    // Skip the separator and any padding around it.
    while (i < trimmed.length && /[ \t\f]/.test(trimmed[i])) i += 1;
    if (i < trimmed.length && (trimmed[i] === "=" || trimmed[i] === ":")) i += 1;
    while (i < trimmed.length && /[ \t\f]/.test(trimmed[i])) i += 1;

    result.set(unescape(key), unescape(trimmed.slice(i)));
  }

  return result;
}

/**
 * Serialise as `Properties.store()` would, minus the timestamp comment (VASSAL
 * writes one; it is decorative and its absence changes nothing on read).
 * Keys are sorted so a rewrite produces a stable diff.
 */
export function formatProperties(props: Map<string, string>, comment?: string): string {
  const lines: string[] = [];
  if (comment) lines.push(`#${comment}`);
  for (const key of [...props.keys()].sort()) {
    lines.push(`${escape(key, true)}=${escape(props.get(key) ?? "", false)}`);
  }
  return lines.join("\n") + "\n";
}

/**
 * VASSAL's `Prefs.sanitize()`: alphanumerics pass through, every other code
 * point becomes `_<UPPERCASE HEX>_`. This is what turns the module name
 * "Here I Stand (500th Anniversary Edition)" into the prefs filename
 * "Here_20_I_20_Stand_20__28_500th_20_Anniversary_20_Edition_29_".
 */
export function sanitizePrefsName(name: string): string {
  let out = "";
  for (const ch of name) {
    const cp = ch.codePointAt(0) ?? 0;
    const alnum =
      (cp >= 0x30 && cp <= 0x39) || (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a);
    out += alnum ? ch : `_${cp.toString(16).toUpperCase()}_`;
  }
  return out;
}
