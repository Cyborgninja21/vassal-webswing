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
set -euo pipefail

cd /opt/webswing
mkdir -p /opt/webswing/logs /data/users /data/transfers

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
  -c /opt/webswing/webswing.config \
  -pf /opt/webswing/webswing.properties
