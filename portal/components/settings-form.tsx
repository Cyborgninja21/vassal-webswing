"use client";

import { useState } from "react";

type Settings = {
  nickname: string;
  defaultModule: string;
  spectateByDefault: boolean;
};

export function SettingsForm({
  initial,
  modules,
}: {
  initial: Settings;
  modules: { path: string; title: string }[];
}) {
  const [settings, setSettings] = useState(initial);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(patch: Partial<Settings>) {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Could not save.");
        return;
      }
      setSettings({
        nickname: data.nickname,
        defaultModule: data.defaultModule,
        spectateByDefault: data.spectateByDefault,
      });
      setStatus("Saved — takes effect the next time you take a seat.");
    } finally {
      setBusy(false);
    }
  }

  async function resetPrefs() {
    if (!confirm("Throw away your VASSAL preferences? Saved games are not touched.")) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const res = await fetch("/api/settings", { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) setError(data.error ?? "Could not reset.");
      else setStatus(`Cleared ${data.removed} preference file(s). Your next launch starts fresh.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-8 space-y-6">
      {error ? (
        <p role="alert" className="rounded border border-red-500/40 bg-red-950/40 px-4 py-2 text-sm text-red-200">
          {error}
        </p>
      ) : null}
      {status ? (
        <p className="rounded border border-emerald-500/30 bg-emerald-950/30 px-4 py-2 text-sm text-emerald-200">
          {status}
        </p>
      ) : null}

      <section className="plate rounded-lg p-4">
        <label htmlFor="nickname" className="block text-sm text-parchment-300">
          Display name
        </label>
        <p className="mt-1 text-xs text-parchment-500">
          What the other players see at the table.
        </p>
        <div className="mt-2 flex gap-2">
          <input
            id="nickname"
            value={settings.nickname}
            onChange={(e) => setSettings({ ...settings, nickname: e.target.value })}
            maxLength={24}
            className="grow rounded border border-brass-400/25 bg-felt-800 px-3 py-1.5 text-sm text-parchment-100 focus:border-brass-400/60 focus:outline-none"
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => save({ nickname: settings.nickname })}
            className="rounded bg-brass-600/80 px-4 py-1.5 text-sm text-parchment-100 hover:bg-brass-600 disabled:opacity-40"
          >
            Save
          </button>
        </div>
      </section>

      <section className="plate rounded-lg p-4">
        <label htmlFor="defaultModule" className="block text-sm text-parchment-300">
          Default game
        </label>
        <p className="mt-1 text-xs text-parchment-500">Pre-selected when you open a table.</p>
        <select
          id="defaultModule"
          value={settings.defaultModule}
          disabled={busy}
          onChange={(e) => save({ defaultModule: e.target.value })}
          className="mt-2 rounded border border-brass-400/25 bg-felt-800 px-3 py-1.5 text-sm text-parchment-100 focus:border-brass-400/60 focus:outline-none"
        >
          <option value="">No preference</option>
          {modules.map((m) => (
            <option key={m.path} value={m.path}>
              {m.title}
            </option>
          ))}
        </select>
      </section>

      <section className="plate rounded-lg p-4">
        <label className="flex items-start gap-3 text-sm text-parchment-300">
          <input
            type="checkbox"
            checked={settings.spectateByDefault}
            disabled={busy}
            onChange={(e) => save({ spectateByDefault: e.target.checked })}
            className="mt-1"
          />
          <span>
            Watch by default
            <span className="mt-1 block text-xs text-parchment-500">
              Highlights <strong>Watch</strong> instead of <strong>Take a seat</strong> on the
              table list. You can still do either.
            </span>
          </span>
        </label>
      </section>

      <section className="plate rounded-lg p-4">
        <h2 className="text-sm text-parchment-300">Reset your VASSAL preferences</h2>
        <p className="mt-1 text-xs text-parchment-500">
          If VASSAL starts behaving oddly — wrong server, stuck dialog — throw the
          preference files away. The next launch rebuilds them from scratch, and the
          portal re-applies your name and table when you next sit down.{" "}
          <strong>Saved games are not touched.</strong>
        </p>
        <button
          type="button"
          disabled={busy}
          onClick={resetPrefs}
          className="mt-3 rounded border border-red-500/40 px-3 py-1.5 text-sm text-red-200 hover:bg-red-950/40 disabled:opacity-40"
        >
          Reset preferences
        </button>
      </section>
    </div>
  );
}
