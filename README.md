# vassal-webswing

Run stock [VASSAL](https://vassalengine.org) in a plain web browser — no Java install, no
VASSAL install, no module download — using
[Webswing Lite (manticore-projects fork)](https://github.com/manticore-projects/webswing)
as the delivery layer. One hosted container spawns one `VASSAL.launch.Player` JVM per
connected player and streams Java2D draw commands to an HTML5 canvas over WebSocket.

**Status: Phase 0 (bring-up & compatibility shakeout) — PASSED 2026-07-26.**
VASSAL 3.7.24 + Webswing Lite 26.4.5 render and play correctly in the browser:
map scroll/zoom, piece drag-and-drop, right-click module commands, keyboard,
multi-window (card displays, chat), save/load through the browser file bridge,
drop/reconnect into the live session (`CONTINUE_FOR_USER`), and concurrent users
with isolated per-user homes. Nobody had published prior art for this pairing.

This repo will become the full Webswing Lite fork (Phase 2: `X-Forwarded-User`
Shiro realm, CI → ghcr image). For now it carries the validated Phase 0
artifacts, which are the Phase 2 starting point.

## Layout

| Path | What |
|---|---|
| `phase0/Dockerfile` | Temurin 21 JRE noble + Webswing dist + VASSAL `lib/` + modules. **No X server / no Xvfb** — but the X *client* libraries are required (see findings). |
| `phase0/webswing.config` | Validated against the 26.4.5 config model (bytecode-verified key placement). One app entry per module. |
| `phase0/entrypoint.sh` | Foreground server launcher (the shipped `run.sh` daemonizes — not container-suited). |
| `phase0/vassal-java` | Per-session `jreExecutable` wrapper: seeds a fresh user's home from `skel/` exactly once, then execs the real `java`. |
| `phase0/skel/.VASSAL/prefs/V_Global` | Seeded prefs: welcome wizard off, private lobby (`vassal-lobby:5050`) in the `ServerAddressBook`. |
| `phase0/tools/cdp.py` | Headless-Chromium CDP driver used to exercise the compatibility checklist. |
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

## License

AGPL-3.0 (see `LICENSE`), matching the Webswing Lite lineage this project builds on
and will vendor in Phase 2.
