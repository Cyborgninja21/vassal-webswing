"use client";

import { useEffect, useRef, useState } from "react";
import type { PortalState, TableView } from "@/lib/portal-state";
import { ModuleArt } from "@/components/module-art";

/**
 * Everything live on the landing page.
 *
 * Server-rendered with a snapshot so the first paint is already correct, then
 * kept current by the SSE stream — there is no polling anywhere in this file.
 */
export function LiveBoard({ initial, username }: { initial: PortalState; username: string }) {
  const [state, setState] = useState<PortalState>(initial);
  const [streamUp, setStreamUp] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const source = new EventSource("/api/stream");
    sourceRef.current = source;

    source.addEventListener("state", (event) => {
      try {
        setState(JSON.parse((event as MessageEvent).data) as PortalState);
        setStreamUp(true);
      } catch {
        // Ignore a malformed frame; the next push replaces the whole state.
      }
    });
    source.onopen = () => setStreamUp(true);
    // EventSource reconnects on its own; just reflect the gap in the UI.
    source.onerror = () => setStreamUp(false);

    return () => {
      source.close();
      sourceRef.current = null;
    };
  }, []);

  /** Seat the player, then hand the browser to Webswing. */
  async function post(url: string, body?: unknown, key = url) {
    setBusy(key);
    setError(null);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? `Request failed (${res.status})`);
        return;
      }
      if (data.launchUrl) window.location.href = data.launchUrl;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function configureTable(t: TableView, patch: Record<string, unknown>) {
    setBusy(`cfg-${t.slot}`);
    setError(null);
    try {
      const res = await fetch(`/api/tables/${t.slot}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? `Could not update the table (${res.status})`);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function closeTable(t: TableView) {
    setBusy(`close-${t.slot}`);
    setError(null);
    try {
      const res = await fetch(`/api/tables/${t.slot}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? `Could not close the table (${res.status})`);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      {error ? (
        <p
          role="alert"
          className="mt-6 rounded-lg border border-red-500/40 bg-red-950/40 px-4 py-3 text-sm text-red-200"
        >
          {error}
        </p>
      ) : null}

      <TablesPanel
        state={state}
        streamUp={streamUp}
        busy={busy}
        username={username}
        onJoin={(t) => post(`/api/tables/${t.slot}/join`, undefined, `join-${t.slot}`)}
        onWatch={(t) => post(`/api/tables/${t.slot}/watch`, undefined, `watch-${t.slot}`)}
        onConfigure={configureTable}
        onClose={closeTable}
      />

      <NewTable
        state={state}
        busy={busy === "create"}
        onCreate={(name, modulePath) => post("/api/tables", { name, modulePath }, "create")}
      />

      <CatalogGrid
        state={state}
        busy={busy}
        onOpen={(path) => post("/api/play", { modulePath: path }, `play-${path}`)}
      />
    </>
  );
}

function Dot({ ok }: { ok: boolean }) {
  return (
    <span
      aria-hidden
      className={`inline-block h-1.5 w-1.5 rounded-full ${ok ? "bg-emerald-400" : "bg-parchment-500/50"}`}
    />
  );
}

function Chip({ children, muted }: { children: React.ReactNode; muted?: boolean }) {
  return (
    <li
      className={`rounded px-2 py-0.5 text-xs ${
        muted
          ? "border border-dashed border-parchment-500/40 text-parchment-500"
          : "bg-felt-600/70 text-parchment-300"
      }`}
    >
      {children}
    </li>
  );
}

function TablesPanel({
  state,
  streamUp,
  busy,
  username,
  onJoin,
  onWatch,
  onConfigure,
  onClose,
}: {
  state: PortalState;
  streamUp: boolean;
  busy: string | null;
  username: string;
  onJoin: (t: TableView) => void;
  onWatch: (t: TableView) => void;
  onConfigure: (t: TableView, patch: Record<string, unknown>) => void;
  onClose: (t: TableView) => void;
}) {
  const { tables, hall } = state;

  return (
    <section aria-labelledby="tables-heading" className="mt-10">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="tables-heading" className="font-display text-2xl text-parchment-100">
          At the tables
        </h2>
        <p className="flex items-center gap-2 text-xs text-parchment-500">
          <Dot ok={streamUp} />
          <span>{streamUp ? "live" : "reconnecting…"}</span>
          <span aria-hidden>·</span>
          <span>
            {state.capacity.used} of {state.capacity.total} tables ·{" "}
            {state.seats.used} of {state.seats.total} seats in use
          </span>
        </p>
      </div>

      {tables.length === 0 ? (
        <p className="plate mt-4 rounded-lg p-6 text-sm text-parchment-500">
          No tables are open. Start one below — everyone else will see it here
          within a couple of seconds and can join with one click.
        </p>
      ) : (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {tables.map((table) => (
            <article key={table.slot} className="plate rounded-lg p-4">
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="font-display text-lg text-parchment-100">{table.name}</h3>
                <span className="text-xs uppercase tracking-wide text-brass-400">
                  {table.moduleTitle}
                </span>
              </div>

              <ul className="mt-3 flex flex-wrap items-center gap-1.5">
                {table.players.map((player) => (
                  <Chip key={player}>{player}</Chip>
                ))}
                {table.spectators.map((player) => (
                  <Chip key={`watch-${player}`} muted>
                    {player} · watching
                  </Chip>
                ))}
                {table.arriving.map((player) => (
                  <Chip key={`arriving-${player}`} muted>
                    {player} · joining
                  </Chip>
                ))}
                {table.players.length === 0 &&
                table.spectators.length === 0 &&
                table.arriving.length === 0 ? (
                  <span className="text-xs text-parchment-500">empty — take a seat</span>
                ) : null}
              </ul>

              <p className="mt-2 text-xs text-parchment-500">
                {table.players.length} of {table.maxSeats} seats
                {table.locked ? " · locked" : ""}
                {table.spectatorsAllowed ? "" : " · no spectators"}
              </p>

              <div className="mt-4 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => onJoin(table)}
                  disabled={busy === `join-${table.slot}` || table.locked}
                  className={`rounded px-3 py-1.5 text-sm disabled:opacity-40 ${
                    state.viewer.spectateByDefault
                      ? "border border-brass-400/30 text-parchment-300 hover:border-brass-400/60"
                      : "bg-brass-600/80 text-parchment-100 hover:bg-brass-600"
                  }`}
                >
                  {busy === `join-${table.slot}` ? "Seating you…" : "Take a seat"}
                </button>
                <button
                  type="button"
                  onClick={() => onWatch(table)}
                  disabled={busy === `watch-${table.slot}`}
                  className="rounded border border-brass-400/30 px-3 py-1.5 text-sm text-parchment-300 hover:border-brass-400/60 hover:text-parchment-100 disabled:opacity-50"
                >
                  {busy === `watch-${table.slot}` ? "Opening…" : "Watch"}
                </button>
                {table.createdBy === username || state.viewer.isAdmin ? (
                  <>
                    <button
                      type="button"
                      onClick={() => onConfigure(table, { locked: !table.locked })}
                      disabled={busy === `cfg-${table.slot}`}
                      className="text-xs text-parchment-500 underline-offset-4 hover:text-parchment-300 hover:underline disabled:opacity-50"
                    >
                      {table.locked ? "unlock" : "lock"}
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        onConfigure(table, { spectatorsAllowed: !table.spectatorsAllowed })
                      }
                      disabled={busy === `cfg-${table.slot}`}
                      className="text-xs text-parchment-500 underline-offset-4 hover:text-parchment-300 hover:underline disabled:opacity-50"
                    >
                      {table.spectatorsAllowed ? "no spectators" : "allow spectators"}
                    </button>
                  </>
                ) : null}
                {table.createdBy === username || state.viewer.isAdmin ? (
                  <button
                    type="button"
                    onClick={() => onClose(table)}
                    disabled={busy === `close-${table.slot}`}
                    className="text-xs text-parchment-500 underline-offset-4 hover:text-parchment-300 hover:underline disabled:opacity-50"
                  >
                    close table
                  </button>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      )}

      {hall.length > 0 ? (
        <p className="mt-3 text-xs text-parchment-500">
          Also connected, not at a table: {hall.join(", ")}
        </p>
      ) : null}
    </section>
  );
}

function NewTable({
  state,
  busy,
  onCreate,
}: {
  state: PortalState;
  busy: boolean;
  onCreate: (name: string, modulePath: string) => void;
}) {
  const [name, setName] = useState("");
  const [modulePath, setModulePath] = useState(
    state.viewer.defaultModule || state.modules[0]?.path || "",
  );
  const full = state.capacity.used >= state.capacity.total;

  return (
    <section aria-labelledby="new-table-heading" className="mt-8">
      <h2 id="new-table-heading" className="sr-only">
        Open a new table
      </h2>
      <form
        className="plate flex flex-wrap items-end gap-3 rounded-lg p-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) onCreate(name.trim(), modulePath);
        }}
      >
        <div className="grow">
          <label htmlFor="table-name" className="block text-xs text-parchment-500">
            Table name
          </label>
          <input
            id="table-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={40}
            placeholder="Tuesday night Reformation"
            className="mt-1 w-full rounded border border-brass-400/25 bg-felt-800 px-3 py-1.5 text-sm text-parchment-100 placeholder:text-parchment-500/60 focus:border-brass-400/60 focus:outline-none"
          />
        </div>
        <div>
          <label htmlFor="table-module" className="block text-xs text-parchment-500">
            Game
          </label>
          <select
            id="table-module"
            value={modulePath}
            onChange={(e) => setModulePath(e.target.value)}
            className="mt-1 rounded border border-brass-400/25 bg-felt-800 px-3 py-1.5 text-sm text-parchment-100 focus:border-brass-400/60 focus:outline-none"
          >
            {state.modules.map((m) => (
              <option key={m.path} value={m.path}>
                {m.title}
              </option>
            ))}
          </select>
        </div>
        <button
          type="submit"
          disabled={busy || full || !name.trim()}
          className="rounded bg-brass-600/80 px-4 py-1.5 text-sm text-parchment-100 hover:bg-brass-600 disabled:opacity-40"
        >
          {busy ? "Opening…" : full ? "All tables in use" : "Open a table"}
        </button>
      </form>
      <p className="mt-2 text-xs text-parchment-500">
        Opening or joining a table puts you straight into the game room, already
        named and connected — the only thing left to do in VASSAL is choose your
        side. <strong>Watch</strong> joins as an observer instead: private hands
        stay hidden and the board is read-only.
      </p>
    </section>
  );
}

function CatalogGrid({
  state,
  busy,
  onOpen,
}: {
  state: PortalState;
  busy: string | null;
  onOpen: (modulePath: string) => void;
}) {
  return (
    <section aria-labelledby="games-heading" className="mt-12">
      <h2 id="games-heading" className="font-display text-2xl text-parchment-100">
        Games
      </h2>
      <div className="mt-4 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {state.modules.map((mod) => (
          <button
            key={mod.path}
            type="button"
            onClick={() => onOpen(mod.path)}
            disabled={busy === `play-${mod.path}`}
            className="plate plate-hover group flex flex-col overflow-hidden rounded-xl text-left shadow-plate disabled:opacity-60"
          >
            <ModuleArt motif={mod.motif} className="aspect-square w-full" />
            <div className="flex flex-1 flex-col p-4">
              <h3 className="font-display text-xl leading-tight text-parchment-100">
                {mod.title}
              </h3>
              <p className="text-xs text-brass-400">{mod.subtitle}</p>
              <p className="mt-3 flex-1 text-sm leading-relaxed text-parchment-300/90">
                {mod.description}
              </p>
              <ul className="mt-4 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-parchment-500">
                {mod.facts.map((fact) => (
                  <li key={fact} className="truncate">
                    {fact}
                  </li>
                ))}
              </ul>
              <p className="mt-4 flex items-center gap-2 text-xs">
                <Dot ok={mod.activeUsers.length > 0} />
                <span className={mod.activeUsers.length ? "text-parchment-300" : "text-parchment-500"}>
                  {mod.activeUsers.length
                    ? `${mod.activeUsers.join(", ")} playing now`
                    : state.sessions.available
                      ? "no one playing"
                      : "session view unavailable"}
                </span>
              </p>
              <p className="mt-1 text-xs text-parchment-500">
                {busy === `play-${mod.path}` ? "Opening…" : "Open on its own (no table)"}
              </p>
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}
