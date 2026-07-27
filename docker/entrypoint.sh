#!/bin/bash
# Foreground Webswing server launcher.
#
# Env:
#   WEBSWING_CONNECTION_SECRET  JWT signing secret (>=128 chars). Generated
#                               ephemerally if unset (sessions won't survive a
#                               container restart — set it in production).
#   WEBSWING_AUTH_HEADER        username header (default X-authentik-username)
#   WEBSWING_EDGE_SECRET        optional shared secret required from the proxy
#   JAVA_XMX                    server heap (default 1g)
#   WEBSWING_CONFIG_DIR         where the live webswing.config lives (default
#                               /data/config). Must be a writable DIRECTORY on a
#                               volume: the portal publishes ingested modules by
#                               asking Webswing to rewrite this file, and those
#                               app paths have to survive a container recreate.
set -euo pipefail

cd /opt/webswing
mkdir -p /opt/webswing/logs /data/users /data/transfers

# Seed the live config from the image's baked default exactly once. Never
# overwrite: after first boot this file is the record of every module an
# operator has published, and the built-in app entries are already in it.
CONFIG_DIR="${WEBSWING_CONFIG_DIR:-/data/config}"
CONFIG_FILE="$CONFIG_DIR/webswing.config"
if mkdir -p "$CONFIG_DIR" 2>/dev/null && [ -w "$CONFIG_DIR" ]; then
  if [ ! -f "$CONFIG_FILE" ]; then
    cp /opt/webswing/webswing.config "$CONFIG_FILE"
    echo "seeded $CONFIG_FILE from the image default"
  fi
else
  # No writable config volume mounted (Phase 0/1 scratch runs, CI smoke tests):
  # fall back to the read-only baked copy. Built-in modules still work; module
  # ingest will not be able to publish.
  echo "WARN: $CONFIG_DIR is not writable — using the baked config; module publishing disabled." >&2
  CONFIG_FILE=/opt/webswing/webswing.config
fi

if [ -z "${WEBSWING_CONNECTION_SECRET:-}" ]; then
  echo "WARN: WEBSWING_CONNECTION_SECRET not set — generating an ephemeral secret." >&2
  WEBSWING_CONNECTION_SECRET=$(tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 160)
fi

cat > /opt/webswing/webswing.properties <<EOF
webswing.connection.secret = ${WEBSWING_CONNECTION_SECRET}
webswing.logsDir = logs/
EOF

WAR=$(ls /opt/webswing/webswing-server-*.war | head -1)

exec java \
  -server -Xmx"${JAVA_XMX:-1g}" -Xms256m \
  -XX:+ExitOnOutOfMemoryError \
  -Djava.io.tmpdir=/opt/webswing/tmp \
  -Dwebswing.websocketMessageSizeLimit=1024000 \
  --add-modules=java.desktop \
  --add-exports=java.desktop/sun.awt=ALL-UNNAMED \
  --add-exports=java.desktop/sun.awt.dnd=ALL-UNNAMED \
  --add-exports=java.desktop/sun.awt.datatransfer=ALL-UNNAMED \
  --add-exports=java.desktop/sun.awt.image=ALL-UNNAMED \
  --add-exports=java.desktop/sun.java2d=ALL-UNNAMED \
  --add-exports=java.desktop/sun.java2d.pipe=ALL-UNNAMED \
  --add-exports=java.desktop/sun.java2d.loops=ALL-UNNAMED \
  --add-exports=java.desktop/sun.font=ALL-UNNAMED \
  --add-exports=java.desktop/sun.print=ALL-UNNAMED \
  --add-exports=java.desktop/java.awt.peer=ALL-UNNAMED \
  --add-exports=java.desktop/java.awt.dnd=ALL-UNNAMED \
  --add-exports=java.base/sun.nio.cs=ALL-UNNAMED \
  --add-opens=java.desktop/sun.awt.image=ALL-UNNAMED \
  -jar "$WAR" \
  -h 0.0.0.0 \
  -j /opt/webswing/jetty.properties \
  -c "$CONFIG_FILE" \
  -pf /opt/webswing/webswing.properties
