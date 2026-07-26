# Phase 0 scratch bring-up: VASSAL 3.7.24 under Webswing Lite 26.4.5
# (docs/plans/vassal-web-webswing.md §3.1 — headless is the point: no X packages)
FROM eclipse-temurin:21-jre-noble

# X CLIENT libraries only (no X server, no Xvfb): libawt_xawt.so links against
# them and the dynamic linker needs them present even though no DISPLAY is ever
# opened (Webswing's patched PlatformGraphicsInfo short-circuits the X11 path).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      fontconfig \
      fonts-dejavu-core \
      fonts-dejavu-extra \
      fonts-noto-core \
      libx11-6 \
      libxext6 \
      libxrender1 \
      libxtst6 \
      libxi6 \
 && rm -rf /var/lib/apt/lists/* \
 && fc-cache -f

# Webswing dist (war + welcome page + api jars).
# The war carries a patched webswing-app-toolkit (AudioClip.getFormat null fix) —
# Phase 0 punch-list; lands properly in the public fork in Phase 2.
COPY build/webswing-server-26.4.5.war /opt/webswing/
COPY dist/webswing/welcome /opt/webswing/welcome
COPY dist/webswing/api /opt/webswing/api

# VASSAL: full lib/ — Vengine.jar's manifest Class-Path references every sibling jar
COPY dist/VASSAL-3.7.24/lib /opt/vassal/lib
COPY modules /opt/vassal/modules

# Skeleton home (prefs: wizard off, private-lobby ServerAddressBook) + per-session
# seeding wrapper invoked by Webswing as jreExecutable.
COPY build/skel /opt/vassal/skel
COPY build/vassal-java /opt/vassal/bin/vassal-java
RUN chmod +x /opt/vassal/bin/vassal-java

COPY build/webswing.config build/jetty.properties build/webswing.properties /opt/webswing/
# The java.desktop patch jar goes where resolveJdkPatchJar() looks
# (${webswing.rootDir}/modpatch-java.desktop.jar) — headless child JVMs.
COPY build/modpatch-java.desktop.jar /opt/webswing/modpatch-java.desktop.jar
COPY build/entrypoint.sh /opt/webswing/entrypoint.sh
RUN chmod +x /opt/webswing/entrypoint.sh && mkdir -p /data/users /data/transfers /opt/webswing/logs

WORKDIR /opt/webswing
EXPOSE 8080
ENTRYPOINT ["/opt/webswing/entrypoint.sh"]
