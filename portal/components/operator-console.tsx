"use client";

import { useCallback, useEffect, useState } from "react";

type Session = {
  instanceId: string;
  user: string;
  application: string;
  applicationPath: string;
  status: string;
  connected: boolean;
  startedAt: number | null;
  disconnectedSince: number | null;
};

type AdminState = {
  connected: boolean;
  error: string | null;
  updatedAt: number | null;
  capacity: { used: number; total: number };
  sessions: Session[];
};

function age(ts: number | null): string {
  if (!ts) return "—";
  const mins = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

export function OperatorConsole() {
  const [state, setState] = useState<AdminState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/sessions");
      if (!res.ok) {
        setError(`Could not read sessions (${res.status})`);
        return;
      }
      setState(await res.json());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
    // The admin console itself polls Webswing every 5 s; match it loosely.
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [load]);

  async function kill(session: Session) {
    if (!confirm(`End ${session.user}'s session on ${session.applicationPath}?`)) return;
    setBusy(session.instanceId);
    try {
      const res = await fetch("/api/admin/sessions", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          instanceId: session.instanceId,
          applicationPath: session.applicationPath,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? `Could not end the session (${res.status})`);
      } else {
        await load();
      }
    } finally {
      setBusy(null);
    }
  }

  if (!state) {
    return <p className="mt-8 text-sm text-parchment-500">{error ?? "Loading…"}</p>;
  }

  return (
    <div className="mt-8 space-y-5">
      {error ? (
        <p role="alert" className="rounded border border-red-500/40 bg-red-950/40 px-4 py-2 text-sm text-red-200">
          {error}
        </p>
      ) : null}

      <p className="text-sm text-parchment-500">
        Admin channel:{" "}
        <span className={state.connected ? "text-emerald-300" : "text-red-300"}>
          {state.connected ? "connected" : "disconnected"}
        </span>
        {state.error ? ` — ${state.error}` : ""} · {state.capacity.used} of{" "}
        {state.capacity.total} seats in use
      </p>

      {state.sessions.length === 0 ? (
        <p className="plate rounded-lg p-6 text-sm text-parchment-500">
          No live sessions.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-parchment-500">
              <tr>
                <th className="py-2">Player</th>
                <th>Game</th>
                <th>State</th>
                <th>Running</th>
                <th />
              </tr>
            </thead>
            <tbody className="text-parchment-300">
              {state.sessions.map((s) => (
                <tr key={s.instanceId} className="border-t border-brass-400/10">
                  <td className="py-2">{s.user || "—"}</td>
                  <td>{s.applicationPath}</td>
                  <td>
                    {s.connected ? (
                      <span className="text-emerald-300">connected</span>
                    ) : (
                      <span className="text-parchment-500">
                        away {age(s.disconnectedSince)}
                      </span>
                    )}
                  </td>
                  <td>{age(s.startedAt)}</td>
                  <td className="py-2 text-right">
                    <button
                      type="button"
                      onClick={() => kill(s)}
                      disabled={busy === s.instanceId}
                      className="rounded border border-red-500/40 px-2 py-1 text-xs text-red-200 hover:bg-red-950/40 disabled:opacity-40"
                    >
                      {busy === s.instanceId ? "ending…" : "end session"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-parchment-500">
        Ending a session kills that Player JVM. Unsaved moves are lost, so use it on a
        stuck seat — the player can sit back down immediately afterwards.
      </p>
    </div>
  );
}
