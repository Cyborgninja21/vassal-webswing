# vassal-portal

The front end for a self-hosted VASSAL-in-the-browser platform: a game catalog
and a live table browser, served on the same hostname as the Webswing server that
actually runs VASSAL.

The sibling of this repo's `docker/` image, which runs stock VASSAL 3.7.24 under
Webswing Lite. That one is the engine; this is the place you arrive at. They live
together because adding a module touches both — a module needs a Webswing app
entry, an icon, and a catalog entry — and they share a palette.

---

## Why it exists

Webswing's built-in landing page is an application-selection dialog: one tile per
configured module and nothing else. It has no concept of a *table*, so there is no
way to see which games are in progress, who is at them, or to join a friend
without opening the module and hand-navigating VASSAL's own Server Controls.

This portal adds that layer.

## How it gets its data

Two live sources, no polling from the browser:

**The VASSAL lobby pushes to us.** `VASSAL.chat.node.Server` accepts a `-URL`
argument; when set, its `StatusReporter` thread POSTs the entire roster to
`<base>updateConnections` as a form field named `STATUS`, holding lines of:

```
moduleId <TAB> roomId <TAB> playerName <NEWLINE>
```

It fires on change with a 2-second floor, and it **requires HTTP 201** in reply —
any other status is treated as a failure and the reporter doubles its retry
interval, out to a two-hour ceiling. A well-meaning `200` silently freezes the
table list. The reporter cannot set headers, so the shared secret rides in the
URL path: the lobby is launched with
`-URL http://vassal-portal:3000/lobby/<LOBBY_PUSH_TOKEN>/`.

That feed carries module, room and display name — and nothing else. No seat or
side, no lock state, no turn number.

**Webswing's admin console tells us who has a session.** Webswing exposes no
session REST API; listing sessions, killing one, and mirroring one all live behind
a single WebSocket at `/async/adminconsole`. It is protobuf-framed (one encoded
`AdminConsoleFrameMsgIn/OutProto` per binary message, no envelope of our own) and
authenticated purely by a handshake JWT — HS256 over the raw UTF-8 bytes of
Webswing's `webswing.connection.secret`, subject `handshake`, sent as the first
message or the server disconnects.

Two consequences:

- That secret is effectively a **root credential** for the Webswing server. It
  stays server-side here and never reaches a browser.
- **Only one admin-console connection may exist at a time**, so this app must run
  as a single replica. A second would fight the first for the channel.

`proto/` vendors `AdminConsoleProto.proto` and `CommonProto.proto` from upstream
Webswing; `protobufjs` parses them at runtime.

Both sources fan out to the browser over one SSE stream (`/api/stream`), with a
15-second heartbeat and `X-Accel-Buffering: no` so nothing in the proxy chain
buffers it into uselessness.

## Identity

There is no login page. Authentication happens at the reverse proxy (Traefik +
Authentik forward-auth) and the username arrives as a header — the same contract
the Webswing container's `XForwardedUserSecurityModule` uses, so the two can never
disagree about who a user is.

Two guards make the header safe to trust:

1. `X-Forwarded-For` must be present. Traefik always sets it; a container talking
   to the portal directly on the stack network does not.
2. The username must match the same character class the Webswing realm enforces
   (`[A-Za-z0-9](?:[A-Za-z0-9._@-]*[A-Za-z0-9])?`, 64 max).

`X-authentik-groups` is pipe-split and matched against `PORTAL_ADMIN_GROUPS` to
decide who sees operator controls.

## Routing

The portal and Webswing **must** share one hostname: Webswing sends
`X-Frame-Options: SAMEORIGIN`, so a portal on a different host could never embed
the game canvas. Webswing's URL space makes the split clean — every application
URL is self-contained under its own prefix (`/his/css/…`, `/his/javascript/…`,
`/his/file`, `/his/async/websocket`), and at the root Webswing only needs `/rest`,
`/async`, `/login`, `/css` and `/javascript`.

So Traefik routes those prefixes to Webswing at a higher priority and gives the
portal the catch-all. Adding a module means adding its prefix to that rule.

## The catalog

Module metadata lives in `lib/catalog.ts`, not in Webswing. Webswing's
`/rest/apps` carries only name/url/icon, and it is gated behind the browser's
token exchange rather than the forward-auth header, so it is not usable as a
metadata source from a server-side client.

Tile art is drawn as inline SVG from primitives (`components/module-art.tsx`),
mirroring the motifs of the Webswing selector icons in the companion repo. It is
original artwork — no publisher box art is redistributed.

## Configuration

See [`.env.example`](.env.example). In the homelab these are injected by Komodo
from a SOPS/OpenBao vault; nothing sensitive is committed.

## Development

```bash
pnpm install
LOBBY_PUSH_TOKEN=dev pnpm dev
```

Simulate a lobby push:

```bash
printf 'Here I Stand\tMain Room\tchase\nHere I Stand\tReformation Night\tjordan\n' > /tmp/status
curl -i -X POST --data-urlencode STATUS@/tmp/status \
  http://127.0.0.1:3000/lobby/dev/updateConnections   # expect 201
```

Requests need the forward-auth headers the proxy would add:

```bash
curl -H 'X-Forwarded-For: 127.0.0.1' -H 'X-authentik-username: chase' \
  http://127.0.0.1:3000/api/state
```

## Licence

AGPL-3.0, same as the rest of this repo — it vendors protobuf schemas from
Webswing, which is AGPL. See [`../LICENSE`](../LICENSE).
