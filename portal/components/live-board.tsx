"use client";

import { useEffect, useRef, useState } from "react";
import type { PortalState } from "@/lib/portal-state";
import { ModuleArt } from "@/components/module-art";

/**
 * Everything live on the landing page.
 *
 * Server-rendered with a snapshot so the first paint is already correct, then
 * kept current by the SSE stream — there is no polling anywhere in this file.
 */
export function LiveBoard({ initial }: { initial: PortalState }) {
  const [state, setState] = useState<PortalState>(initial);
  const [streamUp, setStreamUp] = useState(false);
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

  return (
    <>
      <TablesPanel state={state} streamUp={streamUp} />
      <CatalogGrid state={state} />
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

function TablesPanel({ state, streamUp }: { state: PortalState; streamUp: boolean }) {
  const { tables, hall } = state;
  const nothingHappening = tables.length === 0 && hall.length === 0;

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
            {state.lobby.reporting
              ? `lobby reporting${state.lobby.playerCount ? ` · ${state.lobby.playerCount} online` : ""}`
              : "lobby has not reported yet"}
          </span>
        </p>
      </div>

      {nothingHappening ? (
        <p className="plate mt-4 rounded-lg p-6 text-sm text-parchment-500">
          No one is at a table right now. Open a game below — the first person in
          creates the table, and everyone else sees it here within a couple of
          seconds.
        </p>
      ) : (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {tables.map((table) => (
            <article key={table.id} className="plate rounded-lg p-4">
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="font-display text-lg text-parchment-100">{table.room}</h3>
                <span className="text-xs uppercase tracking-wide text-brass-400">
                  {table.moduleTitle}
                </span>
              </div>
              <ul className="mt-3 flex flex-wrap gap-1.5">
                {table.players.map((player) => (
                  <li
                    key={player}
                    className="rounded bg-felt-600/70 px-2 py-0.5 text-xs text-parchment-300"
                  >
                    {player}
                  </li>
                ))}
              </ul>
              {table.modulePath ? (
                <a
                  href={table.modulePath}
                  className="mt-4 inline-block text-sm text-brass-400 underline-offset-4 hover:underline"
                >
                  Open {table.moduleTitle} →
                </a>
              ) : null}
            </article>
          ))}

          {hall.length > 0 ? (
            <article className="plate rounded-lg p-4">
              <h3 className="font-display text-lg text-parchment-100">In the hall</h3>
              <p className="mt-1 text-xs text-parchment-500">
                Connected to the lobby, not yet at a table.
              </p>
              <ul className="mt-3 flex flex-wrap gap-1.5">
                {hall.map((player) => (
                  <li
                    key={player}
                    className="rounded bg-felt-600/70 px-2 py-0.5 text-xs text-parchment-300"
                  >
                    {player}
                  </li>
                ))}
              </ul>
            </article>
          ) : null}
        </div>
      )}
    </section>
  );
}

function CatalogGrid({ state }: { state: PortalState }) {
  return (
    <section aria-labelledby="games-heading" className="mt-12">
      <h2 id="games-heading" className="font-display text-2xl text-parchment-100">
        Games
      </h2>
      <div className="mt-4 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {state.modules.map((mod) => (
          <a
            key={mod.path}
            href={mod.path}
            className="plate plate-hover group flex flex-col overflow-hidden rounded-xl shadow-plate"
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
              <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-parchment-500">
                <div className="contents">
                  <dt className="sr-only">Players</dt>
                  <dd>{mod.players} players</dd>
                  <dt className="sr-only">Era</dt>
                  <dd>{mod.era}</dd>
                </div>
                <div className="contents">
                  <dt className="sr-only">Play time</dt>
                  <dd>{mod.playTime}</dd>
                  <dt className="sr-only">Designer</dt>
                  <dd className="truncate">{mod.designer}</dd>
                </div>
              </dl>
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
            </div>
          </a>
        ))}
      </div>
    </section>
  );
}
