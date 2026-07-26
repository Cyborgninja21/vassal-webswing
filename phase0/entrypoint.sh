#!/bin/sh
# Foreground launcher for the Webswing server (scratch bring-up).
set -eu

cd /opt/webswing
mkdir -p /opt/webswing/logs /data/users /data/transfers

exec java \
  -server -Xmx1g -Xms256m \
  -XX:+ExitOnOutOfMemoryError \
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
  -jar /opt/webswing/webswing-server-26.4.5.war \
  -h 0.0.0.0 \
  -j /opt/webswing/jetty.properties \
  -c /opt/webswing/webswing.config \
  -pf /opt/webswing/webswing.properties
