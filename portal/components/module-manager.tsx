"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Extension = { name: string; size: number; version: string; codeEntries: number };

type Module = {
  slug: string;
  title: string;
  vassalModuleName: string;
  version: string;
  vassalVersion: string;
  description: string;
  moduleFile: string;
  extDir: string | null;
  extensions: Extension[];
  archiveSha256: string;
  archiveBytes: number;
  sourceUrl: string | null;
  ingestedBy: string;
  ingestedAt: number;
  enabled: boolean;
  maxClients: number;
  liveSessions: number;
  codeTotal: number;
};

type Listing = {
  modules: Module[];
  engine: { vassalVersion: string };
  limits: { maxBytes: number; maxEntries: number };
};

function bytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

export function ModuleManager() {
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<string[]>([]);
  const [notice, setNotice] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [sha, setSha] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/modules");
      if (!res.ok) {
        setError(`Could not read the module list (${res.status})`);
        return;
      }
      setListing(await res.json());
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function reportFailure(data: { error?: string; detail?: string[] }, fallback: string) {
    setError(data.error ?? fallback);
    setDetail(Array.isArray(data.detail) ? data.detail : []);
    setNotice([]);
  }

  async function finish(res: Response) {
    const data = await res.json().catch(() => ({}));
    if (!res.ok && res.status !== 202) {
      reportFailure(data, `Ingest failed (${res.status})`);
      return;
    }
    setError(data.error ?? null);
    setDetail([]);
    setNotice(data.warnings ?? []);
    setUrl("");
    setSha("");
    if (fileInput.current) fileInput.current.value = "";
    await load();
  }

  async function ingestUrl() {
    if (!url.trim()) return;
    setBusy("ingest");
    setError(null);
    setDetail([]);
    setNotice([]);
    try {
      await finish(
        await fetch("/api/admin/modules", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: url.trim(), sha256: sha.trim() || undefined }),
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function ingestFile(file: File) {
    setBusy("ingest");
    setError(null);
    setDetail([]);
    setNotice([]);
    try {
      const qs = new URLSearchParams({ filename: file.name });
      if (sha.trim()) qs.set("sha256", sha.trim());
      // Sent as a raw stream, not multipart: a 300 MB archive through
      // `formData()` would be buffered whole in a 512 MB container.
      await finish(
        await fetch(`/api/admin/modules?${qs}`, {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: file,
          duplex: "half",
        } as RequestInit & { duplex: "half" }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function patch(slug: string, body: Record<string, unknown>) {
    setBusy(slug);
    setError(null);
    setDetail([]);
    try {
      const res = await fetch(`/api/admin/modules/${slug}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        reportFailure(data, `Could not update ${slug}`);
      } else if (body.action === "verify") {
        setNotice(
          data.ok
            ? [`${slug}: every file matches the manifest.`]
            : [`${slug}: ${data.problems.length} problem(s)`, ...data.problems],
        );
      } else if (data.published === false) {
        setError(`Saved, but Webswing did not accept it: ${data.error}`);
      }
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function remove(mod: Module) {
    if (
      !confirm(
        `Retire ${mod.title}? Its files move to .removed/ (nothing is deleted) and the URL stops working.`,
      )
    ) {
      return;
    }
    setBusy(mod.slug);
    setError(null);
    try {
      const res = await fetch(`/api/admin/modules/${mod.slug}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) reportFailure(data, `Could not retire ${mod.slug}`);
      else setNotice([`${mod.title} retired. Files kept at ${data.movedTo}.`]);
      await load();
    } finally {
      setBusy(null);
    }
  }

  if (!listing) {
    return <p className="mt-8 text-sm text-parchment-500">{error ?? "Loading…"}</p>;
  }

  return (
    <div className="mt-8 space-y-6">
      {error ? (
        <div
          role="alert"
          className="rounded border border-red-500/40 bg-red-950/40 px-4 py-3 text-sm text-red-200"
        >
          <p>{error}</p>
          {detail.length ? (
            <ul className="mt-2 space-y-0.5 font-mono text-xs text-red-300/80">
              {detail.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {notice.length ? (
        <ul className="rounded border border-brass-400/30 bg-brass-400/5 px-4 py-3 text-sm text-parchment-300">
          {notice.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}

      <section className="plate rounded-xl p-5">
        <h2 className="font-display text-xl text-parchment-100">Add a module</h2>
        <p className="mt-1 text-sm text-parchment-500">
          A VASSAL <code>.vmod</code>, or a ZIP holding one plus its{" "}
          <code>_ext</code> directory. Up to {bytes(listing.limits.maxBytes)}. The engine runs
          VASSAL {listing.engine.vassalVersion}.
        </p>
        <p className="mt-2 text-xs text-amber-300/80">
          A VASSAL module can contain compiled Java, which the engine loads and runs inside the
          container. Add modules only from sources you trust.
        </p>

        <div className="mt-4 space-y-3">
          <label className="block text-sm">
            <span className="text-parchment-400">Source URL (https)</span>
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.org/releases/module-9.2.zip"
              className="mt-1 w-full rounded border border-brass-400/25 bg-black/30 px-3 py-2 text-parchment-200 outline-none focus:border-brass-400/60"
            />
          </label>
          <label className="block text-sm">
            <span className="text-parchment-400">Expected sha256 (optional)</span>
            <input
              type="text"
              value={sha}
              onChange={(e) => setSha(e.target.value)}
              placeholder="abc123…  — a mismatch aborts the ingest"
              className="mt-1 w-full rounded border border-brass-400/25 bg-black/30 px-3 py-2 font-mono text-xs text-parchment-200 outline-none focus:border-brass-400/60"
            />
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={ingestUrl}
              disabled={busy === "ingest" || !url.trim()}
              className="rounded bg-brass-400/90 px-4 py-2 text-sm font-medium text-black disabled:opacity-50"
            >
              {busy === "ingest" ? "Working…" : "Fetch and publish"}
            </button>
            <span className="text-xs text-parchment-500">or</span>
            <input
              ref={fileInput}
              type="file"
              accept=".zip,.vmod,application/zip,application/octet-stream"
              disabled={busy === "ingest"}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void ingestFile(f);
              }}
              className="text-xs text-parchment-400 file:mr-3 file:rounded file:border-0 file:bg-brass-400/20 file:px-3 file:py-1.5 file:text-parchment-200"
            />
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="font-display text-xl text-parchment-100">
          Published modules ({listing.modules.length})
        </h2>
        {listing.modules.length === 0 ? (
          <p className="text-sm text-parchment-500">
            None yet. The three built-in games are baked into the image and are not listed here.
          </p>
        ) : null}

        {listing.modules.map((mod) => (
          <article key={mod.slug} className="plate rounded-xl p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="font-display text-lg text-parchment-100">
                  {mod.title}{" "}
                  <span className="font-sans text-xs text-parchment-500">/{mod.slug}</span>
                </h3>
                <p className="text-xs text-parchment-500">
                  {mod.vassalModuleName}
                  {mod.version ? ` · version ${mod.version}` : ""}
                  {mod.vassalVersion ? ` · saved with VASSAL ${mod.vassalVersion}` : ""}
                </p>
              </div>
              <span
                className={`rounded px-2 py-0.5 text-xs ${
                  mod.enabled
                    ? "bg-emerald-500/15 text-emerald-300"
                    : "bg-parchment-500/15 text-parchment-400"
                }`}
              >
                {mod.enabled ? "published" : "disabled"}
              </span>
            </div>

            <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-parchment-500">
              <li>{bytes(mod.archiveBytes)}</li>
              <li>
                {mod.extensions.length} extension{mod.extensions.length === 1 ? "" : "s"}
              </li>
              <li className={mod.codeTotal ? "text-amber-300/90" : undefined}>
                {mod.codeTotal} compiled Java entr{mod.codeTotal === 1 ? "y" : "ies"}
              </li>
              <li>
                {mod.liveSessions} live seat{mod.liveSessions === 1 ? "" : "s"}
              </li>
              <li>by {mod.ingestedBy}</li>
            </ul>

            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => patch(mod.slug, { enabled: !mod.enabled })}
                disabled={busy === mod.slug}
                className="rounded border border-brass-400/40 px-3 py-1.5 text-xs text-parchment-200 disabled:opacity-50"
              >
                {mod.enabled ? "Disable" : "Enable"}
              </button>
              <button
                type="button"
                onClick={() => patch(mod.slug, { action: "verify" })}
                disabled={busy === mod.slug}
                className="rounded border border-brass-400/40 px-3 py-1.5 text-xs text-parchment-200 disabled:opacity-50"
              >
                Re-verify
              </button>
              <button
                type="button"
                onClick={() => setOpen(open === mod.slug ? null : mod.slug)}
                className="rounded border border-brass-400/20 px-3 py-1.5 text-xs text-parchment-400"
              >
                {open === mod.slug ? "Hide details" : "Details"}
              </button>
              <button
                type="button"
                onClick={() => remove(mod)}
                disabled={busy === mod.slug || mod.liveSessions > 0}
                title={mod.liveSessions > 0 ? "Someone is playing this right now" : undefined}
                className="rounded border border-red-500/40 px-3 py-1.5 text-xs text-red-300 disabled:opacity-40"
              >
                Retire
              </button>
            </div>

            {open === mod.slug ? (
              <dl className="mt-4 space-y-2 border-t border-brass-400/15 pt-4 text-xs">
                <div>
                  <dt className="text-parchment-500">Archive sha256</dt>
                  <dd className="break-all font-mono text-parchment-300">{mod.archiveSha256}</dd>
                </div>
                <div>
                  <dt className="text-parchment-500">Source</dt>
                  <dd className="break-all text-parchment-300">
                    {mod.sourceUrl ?? "uploaded from a file"}
                  </dd>
                </div>
                <div>
                  <dt className="text-parchment-500">On disk</dt>
                  <dd className="font-mono text-parchment-300">
                    {mod.moduleFile}
                    {mod.extDir ? ` + ${mod.extDir}/` : ""}
                  </dd>
                </div>
                {mod.extensions.length ? (
                  <div>
                    <dt className="text-parchment-500">Extensions</dt>
                    <dd className="mt-1 grid gap-x-4 text-parchment-400 sm:grid-cols-2">
                      {mod.extensions.map((e) => (
                        <span key={e.name} className="truncate">
                          {e.name}
                          {e.codeEntries ? (
                            <span className="text-amber-300/80"> · {e.codeEntries} class</span>
                          ) : null}
                        </span>
                      ))}
                    </dd>
                  </div>
                ) : null}
              </dl>
            ) : null}
          </article>
        ))}
      </section>
    </div>
  );
}
