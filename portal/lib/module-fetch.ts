import dns from "node:dns/promises";
import fs from "node:fs";
import crypto from "node:crypto";
import net from "node:net";
import { Readable } from "node:stream";
import { env } from "@/lib/env";

/**
 * Guarded fetcher for operator-supplied module URLs.
 *
 * The portal runs on the stack network: it can reach every table lobby (whose
 * protocol has no authentication), the Webswing admin channel, and whatever
 * else the host routes to. An unguarded "download this URL for me" endpoint is
 * therefore an SSRF pivot, so every hop is resolved and checked before a
 * connection is made — including redirect targets, which is why redirects are
 * followed by hand instead of by `fetch`.
 */

const MAX_REDIRECTS = 5;

export class FetchRefused extends Error {}

/** RFC1918 / loopback / link-local / CGNAT / ULA — anything not on the internet. */
export function isPrivateAddress(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast + reserved
    return false;
  }
  if (v === 6) {
    const ip6 = ip.toLowerCase().split("%")[0];
    if (ip6 === "::" || ip6 === "::1") return true;
    if (ip6.startsWith("fe8") || ip6.startsWith("fe9") || ip6.startsWith("fea") || ip6.startsWith("feb")) {
      return true; // link-local
    }
    if (/^f[cd]/.test(ip6)) return true; // unique-local
    if (ip6.startsWith("ff")) return true; // multicast
    // IPv4-mapped (::ffff:10.0.0.1) must be judged as its IPv4 form.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip6);
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }
  return true;
}

async function assertPublic(url: URL): Promise<void> {
  if (url.protocol !== "https:") {
    throw new FetchRefused("Only https:// sources are accepted.");
  }
  if (env.moduleAllowPrivateFetch) return;

  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = net.isIP(host)
    ? [host]
    : (await dns.lookup(host, { all: true })).map((a) => a.address);

  if (!addresses.length) {
    throw new FetchRefused(`Could not resolve ${url.hostname}.`);
  }
  const priv = addresses.filter(isPrivateAddress);
  if (priv.length) {
    throw new FetchRefused(
      `${url.hostname} resolves to a private address (${priv[0]}). ` +
        "The portal will not fetch from inside the network.",
    );
  }
}

export type Downloaded = {
  sha256: string;
  bytes: number;
  finalUrl: string;
  filename: string | null;
};

/** Filename hint, from Content-Disposition or the URL path. */
function filenameOf(res: Response, url: URL): string | null {
  const cd = res.headers.get("content-disposition") ?? "";
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
  const raw = m ? decodeURIComponent(m[1]) : url.pathname.split("/").pop() ?? "";
  const name = raw.trim().replace(/[/\\]/g, "");
  return name || null;
}

/**
 * Stream a URL to `dest`, hashing as it goes and stopping the moment the byte
 * budget is exceeded. The cap is enforced on bytes actually written — a lying
 * or absent `Content-Length` cannot get around it.
 */
export async function downloadTo(url: string, dest: string): Promise<Downloaded> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new FetchRefused("That is not a valid URL.");
  }

  let res: Response | null = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertPublic(target);
    const r = await fetch(target, { redirect: "manual", headers: { accept: "*/*" } });
    if (r.status >= 300 && r.status < 400) {
      const location = r.headers.get("location");
      if (!location) throw new FetchRefused(`Redirect from ${target.host} carried no location.`);
      target = new URL(location, target);
      continue;
    }
    res = r;
    break;
  }
  if (!res) throw new FetchRefused("Too many redirects.");
  if (!res.ok || !res.body) {
    throw new FetchRefused(`Source returned HTTP ${res.status}.`);
  }

  const hash = crypto.createHash("sha256");
  const out = fs.createWriteStream(dest);
  let bytes = 0;

  try {
    for await (const chunk of Readable.fromWeb(res.body as never)) {
      const buf = chunk as Buffer;
      bytes += buf.length;
      if (bytes > env.moduleMaxBytes) {
        throw new FetchRefused(
          `Download exceeds the ${Math.round(env.moduleMaxBytes / 1024 / 1024)} MB limit.`,
        );
      }
      hash.update(buf);
      if (!out.write(buf)) {
        await new Promise<void>((r) => out.once("drain", () => r()));
      }
    }
    await new Promise<void>((resolve, reject) => {
      out.end((err?: Error) => (err ? reject(err) : resolve()));
    });
  } catch (e) {
    out.destroy();
    throw e;
  }

  return {
    sha256: hash.digest("hex"),
    bytes,
    finalUrl: target.toString(),
    filename: filenameOf(res, target),
  };
}
