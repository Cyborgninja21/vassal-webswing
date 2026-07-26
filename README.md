# vassal-webswing

Run stock [VASSAL](https://vassalengine.org) in a plain web browser — no Java install, no
VASSAL install, no module download — using
[Webswing Lite (manticore-projects fork)](https://github.com/manticore-projects/webswing)
as the delivery layer. One hosted container spawns one `VASSAL.launch.Player` JVM per
connected player and streams Java2D draw commands to an HTML5 canvas over WebSocket.

**Status: Phases 0–2 — SHIPPED 2026-07-26.** The platform is LIVE at its internal
homelab URL: Traefik + Authentik forward-auth feed the `X-Forwarded-User` realm
(`src/`), the production image (`docker/`) is built by CI to
`ghcr.io/cyborgninja21/vassal-webswing`, and the two-container stack (webswing +
lobby sidecar) runs under Komodo. Verified end-to-end: anonymous requests 302 to
the IdP; an authenticated user gets a per-identity Player JVM with a
skel-seeded home; reconnect lands back on the live JVM.

*Phase 0 (single-client compatibility):* VASSAL 3.7.24 + Webswing Lite 26.4.5 render and
play correctly in the browser — map scroll/zoom, piece drag-and-drop, right-click module
commands, keyboard, multi-window (card displays, chat), save/load through the browser file
bridge, drop/reconnect into the live session (`CONTINUE_FOR_USER`), concurrent users with
isolated per-user homes.

*Phase 1 (multiplayer):* two browser seats play one Here I Stand game through VASSAL's own
in-jar lobby server running as a `vassal-lobby` sidecar (`phase1/docker-compose.yaml`) —
piece moves, dice rolls, and chat all propagate both directions; a third session joins
mid-game and receives the full board via snapshot replay; a reconnecting player lands back
on their live seat with full history; `allowStealSession: false` blocks a concurrent
second login; and two different modules (Here I Stand + Twilight Struggle) run
simultaneously in separate JVMs. Nobody had published prior art for this pairing.

This repo will become the full Webswing Lite fork (Phase 2: `X-Forwarded-User`
Shiro realm, CI → ghcr image). For now it carries the validated Phase 0 + Phase 1
artifacts, which are the Phase 2 starting point.

## Layout

| Path | What |
|---|---|
| `phase0/Dockerfile` | Temurin 21 JRE noble + Webswing dist + VASSAL `lib/` + modules. **No X server / no Xvfb** — but the X *client* libraries are required (see findings). |
| `phase0/webswing.config` | Validated against the 26.4.5 config model (bytecode-verified key placement). One app entry per module. |
| `phase0/entrypoint.sh` | Foreground server launcher (the shipped `run.sh` daemonizes — not container-suited). |
| `phase0/vassal-java` | Per-session `jreExecutable` wrapper: seeds a fresh user's home from `skel/` exactly once, then execs the real `java`. |
| `phase0/skel/.VASSAL/prefs/V_Global` | Seeded prefs: welcome wizard off, private lobby (`vassal-lobby:5050`) in the `ServerAddressBook`. |
| `phase0/tools/cdp.py` | Headless-Chromium CDP driver used to exercise the compatibility + multiplayer checklists. |
| `phase1/docker-compose.yaml` | Two-container multiplayer topology: `webswing` + `vassal-lobby` sidecar on one network. |
| `phase1/webswing.config` | Phase 0 config + `swingSessionTimeout: 14400` (4h) and `timeoutIfInactive: false` — see Phase 1 findings. |
| `patches/AudioClip.java` | Toolkit fix: `AudioClip.getFormat()` returned `null`, violating the `DataLine` contract and crashing VASSAL at module init (NPE in `AudioSystem.getAudioInputStream`). Patched to track the open format and default to CD-PCM. Compiled against `webswing-app-toolkit-26.4.5.jar` and spliced into the war for Phase 0; proper home is this fork's source tree (Phase 2). |

## Phase 0 findings (the punch list, closed)

1. **X client libraries are required** even though no X server ever runs:
   `Toolkit.<clinit>` loads `libawt_xawt.so` (Webswing sets `java.awt.headless=false`),
   and the dynamic linker must resolve its `libX11/libXext/libXrender/libXtst/libXi`
   deps. The upstream reference Dockerfile's claim that these are unnecessary does not
   survive contact with a real Swing app.
2. **`modpatch-java.desktop.jar` must exist at `${webswing.rootDir}`** (or
   `-Dwebswing.jdkPatchJar=`) for the truly-headless patch discovery. The release zip
   does not place it there; the Dockerfile extracts it from the war.
3. **`swingConfig.fontConfig` is mandatory on Linux.** Webswing's `WebFontConfiguration`
   extends `sun.awt.FontConfiguration`, which needs a generated `fontconfig.properties`
   — without the map you get `Fontconfig head is null` and the child dies. Font files
   must live under `-Dwebswing.trustedFontDirs`.
4. **`AudioClip.getFormat()` null** → see `patches/AudioClip.java`.
5. **Config-model corrections** (verified from the war's class files):
   `maxClients` / `sessionMode` / `allowStealSession` are app-level (SecuredPathConfig),
   not inside `swingConfig`; the app launch is `launcherType: "Desktop"` +
   `launcherConfig: {mainClass, args}`; per-player isolation needs
   `-Duser.home=/data/users/${user}` in `vmArgs` (VASSAL keys `~/.VASSAL` off
   `user.home`, not the working dir).
6. **Ship VASSAL's whole `lib/` directory.** `Vengine.jar`'s manifest `Class-Path`
   references every sibling jar; the bare jar on a classpath does not run.
7. **Per-user home seeding** rides `jreExecutable` (per session-start), not the
   container entrypoint (runs once, before any user exists).
8. **Image pre-tiling is per-module.** Here I Stand 500th (3.5.0) never fires the
   VASSAL tiler; treat pre-tiling as a module-onboarding check, not a universal
   build step.

## Phase 1 findings (multiplayer)

1. **The seeded lobby pointer works end to end.** The skel `V_Global` gives each fresh
   user a `Private Server [vassal-lobby:5050]` entry in VASSAL's Server Controls
   (right-click the connect button → change server). VASSAL merges it cleanly into the
   default `ServerAddressBook`; select it, connect, and you're in the private lobby's
   Main Room — never `vassalengine.org`.
2. **Native VASSAL multiplayer needs zero Webswing awareness.** The lobby is just a JVM
   running `VASSAL.chat.node.Server -port 5050 -URL null` from the same `Vengine.jar`;
   the per-player Player JVMs talk to it over the plain docker network. Draw-command
   streaming (Webswing) and game-state sync (VASSAL) are fully orthogonal.
3. **Reconnect holds the seat AND the lobby membership.** Closing the browser and logging
   back in as the same Webswing user reconnects to the live Player JVM, which never left
   its game room — faction, chat history, and board state are all intact. The Player JVM
   count does not change across a browser drop.
4. **`allowStealSession: false` is the right anti-hijack default.** A concurrent second
   login as the same Webswing user is refused with "There is already a session in progress
   in another window" (Reconnect / Sign out only) — no silent takeover.
5. **Session timeout governs the abandoned-JVM reap.** `swingSessionTimeout` (seconds,
   default 300) is how long a disconnected Player JVM survives before Webswing reaps it.
   Each seated player is a ~700 MB JVM, so the default 5 min is too aggressive for
   board games. Set to **14400 s (4 h)** with `timeoutIfInactive: false` so a dinner
   break (or a whole evening's AFK) survives while genuinely abandoned games still free
   their memory. Verified: JVM survives a short disconnect and reaps after the timeout.
6. **The per-app JVM model composes across modules.** Here I Stand and Twilight Struggle
   ran simultaneously as separate Player JVMs from the one Webswing server — one app entry
   per module, no cross-talk.

## License

AGPL-3.0 (see `LICENSE`), matching the Webswing Lite lineage this project builds on
and will vendor in Phase 2.
