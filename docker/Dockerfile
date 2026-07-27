# Production image: stock VASSAL under Webswing Lite, X-Forwarded-User realm.
# Build context = repo root:  docker build -f docker/Dockerfile .
#
# All third-party artifacts are downloaded at build time with pinned sha256 —
# nothing binary is committed to this repo (module files carry publisher art).

# ── Stage 1: assemble + patch ────────────────────────────────────────────────
FROM eclipse-temurin:21-jdk-noble AS build

RUN apt-get update && apt-get install -y --no-install-recommends curl bzip2 unzip \
 && rm -rf /var/lib/apt/lists/*

ARG WEBSWING_VERSION=26.4.5
ARG WEBSWING_SHA256=7bc964125a5fae5aeab3d9aaeebf584f778c623a5baf103ef05e864a812b19aa
ARG VASSAL_VERSION=3.7.24
ARG VASSAL_SHA256=67f73ed6848c1bdce125ab1643f1d28d06399f488bb65821552c72ce87175c2e

WORKDIR /build

# Webswing Lite release dist
RUN curl -fsSL -o webswing.zip \
      "https://github.com/manticore-projects/webswing/releases/download/${WEBSWING_VERSION}/webswing-${WEBSWING_VERSION}.zip" \
 && echo "${WEBSWING_SHA256}  webswing.zip" | sha256sum -c - \
 && unzip -q webswing.zip -d webswing-dist

# VASSAL engine (whole lib/ — Vengine.jar manifest Class-Path needs every sibling)
RUN curl -fsSL -o vassal.tar.bz2 \
      "https://github.com/vassalengine/vassal/releases/download/${VASSAL_VERSION}/VASSAL-${VASSAL_VERSION}-linux.tar.bz2" \
 && echo "${VASSAL_SHA256}  vassal.tar.bz2" | sha256sum -c - \
 && tar -xjf vassal.tar.bz2

# VASSAL patches, compiled against the shipped jars and spliced back into
# Vengine.jar — VASSAL itself is not rebuilt. See each file's header for why it
# cannot be done from outside the engine:
#   Player.java       — connect and join the room the portal chose
#   PlayerRoster.java — spectators take <observer> without being asked
COPY patches/Player.java patches/PlayerRoster.java /build/patches/
RUN set -e; \
    LIB=/build/VASSAL-${VASSAL_VERSION}/lib; \
    mkdir -p /build/out/vassal; \
    javac -nowarn -cp "$LIB/*" -d /build/out/vassal \
      /build/patches/Player.java /build/patches/PlayerRoster.java; \
    test -f /build/out/vassal/VASSAL/launch/Player.class; \
    test -f /build/out/vassal/VASSAL/build/module/PlayerRoster.class; \
    (cd /build/out/vassal && jar uf "$LIB/Vengine.jar" \
       VASSAL/launch/Player*.class VASSAL/build/module/PlayerRoster*.class)

# Game modules (from the VASSAL module library; per-module sha256 pins)
COPY docker/modules.list /build/modules.list
RUN mkdir -p /opt/vassal/modules && cd /opt/vassal/modules \
 && while read -r name url sha; do \
      [ -z "$name" ] && continue; \
      echo "fetching $name"; \
      curl -fsSL -o "$name" "$url" && echo "$sha  $name" | sha256sum -c - || exit 1; \
    done < /build/modules.list

# Patch the war: AudioClip.getFormat() fix (DataLine contract) spliced into the
# toolkit jar, and compile the X-Forwarded-User realm into an ext jar.
COPY src /build/src
COPY patches /build/patches
RUN set -e; \
    WS=/build/webswing-dist; \
    WAR=$WS/webswing-server-${WEBSWING_VERSION}.war; \
    mkdir -p /build/cp /build/out; \
    cd /build; \
    unzip -q -j "$WAR" \
      "WEB-INF/lib/webswing-app-toolkit-${WEBSWING_VERSION}.jar" \
      "WEB-INF/lib/webswing-server-common-${WEBSWING_VERSION}.jar" \
      "WEB-INF/lib/jetty-servlet-api-4.0.9.jar" \
      "WEB-INF/lib/slf4j-api-2.0.18.jar" \
      -d cp; \
    cp $WS/api/webswing-api-${WEBSWING_VERSION}.jar $WS/api/webswing-server-security-${WEBSWING_VERSION}.jar cp/; \
    # 1. AudioClip patch -> toolkit jar -> back into the war
    javac --add-exports java.desktop/sun.awt=ALL-UNNAMED \
          --add-exports java.desktop/sun.java2d=ALL-UNNAMED \
          --add-exports java.desktop/sun.font=ALL-UNNAMED \
          -cp "cp/*" -d out/audio patches/AudioClip.java; \
    cd out/audio && jar uf /build/cp/webswing-app-toolkit-${WEBSWING_VERSION}.jar org/webswing/audio/*.class && cd /build; \
    mkdir -p warpatch/WEB-INF/lib; \
    cp cp/webswing-app-toolkit-${WEBSWING_VERSION}.jar warpatch/WEB-INF/lib/; \
    cd warpatch && jar uf "$WAR" WEB-INF/lib/webswing-app-toolkit-${WEBSWING_VERSION}.jar && cd /build; \
    # 2. X-Forwarded-User realm -> ext jar
    javac -cp "cp/*" -d out/sec $(find src -name '*.java'); \
    mkdir -p $WS/ext; \
    (cd out/sec && jar cf $WS/ext/vassal-webswing-security.jar org); \
    # 3. modpatch jar at rootDir for resolveJdkPatchJar()
    cd /build && unzip -q -j "$WAR" "WEB-INF/lib/modpatch-java-desktop-${WEBSWING_VERSION}.jar" -d mp \
 && cp mp/modpatch-java-desktop-${WEBSWING_VERSION}.jar $WS/modpatch-java.desktop.jar

# ── Stage 2: runtime ─────────────────────────────────────────────────────────
FROM eclipse-temurin:21-jre-noble

# X CLIENT libraries only (no X server, no Xvfb): libawt_xawt.so links against
# them; the linker needs them present even though no DISPLAY is ever opened.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      fontconfig fonts-dejavu-core fonts-dejavu-extra fonts-noto-core \
      libx11-6 libxext6 libxrender1 libxtst6 libxi6 \
 && rm -rf /var/lib/apt/lists/* \
 && fc-cache -f \
 && groupadd -r -g 990 webswing && useradd -r -u 990 -g webswing -m webswing

ARG WEBSWING_VERSION=26.4.5
ARG VASSAL_VERSION=3.7.24

COPY --from=build --chown=webswing:webswing /build/webswing-dist/webswing-server-${WEBSWING_VERSION}.war /opt/webswing/
COPY --from=build --chown=webswing:webswing /build/webswing-dist/welcome /opt/webswing/welcome
COPY --from=build --chown=webswing:webswing /build/webswing-dist/api /opt/webswing/api
COPY --from=build --chown=webswing:webswing /build/webswing-dist/ext /opt/webswing/ext
COPY --from=build --chown=webswing:webswing /build/webswing-dist/modpatch-java.desktop.jar /opt/webswing/
COPY --from=build --chown=webswing:webswing /build/VASSAL-${VASSAL_VERSION}/lib /opt/vassal/lib
COPY --from=build --chown=webswing:webswing /opt/vassal/modules /opt/vassal/modules

COPY --chown=webswing:webswing docker/webswing.config docker/jetty.properties /opt/webswing/
COPY --chown=webswing:webswing docker/entrypoint.sh /opt/webswing/entrypoint.sh
# Module tiles for the app-selection dialog (SecuredPathConfig.icon, 256x256).
# Regenerate with tools/make-icons.py.
COPY --chown=webswing:webswing docker/icons /opt/webswing/icons
COPY --chown=webswing:webswing phase0/skel /opt/vassal/skel
COPY --chown=webswing:webswing phase0/vassal-java /opt/vassal/bin/vassal-java

RUN chmod +x /opt/webswing/entrypoint.sh /opt/vassal/bin/vassal-java \
 && mkdir -p /data/users /data/transfers /opt/webswing/logs /opt/webswing/tmp \
 && chown -R webswing:webswing /data /opt/webswing

USER webswing
WORKDIR /opt/webswing
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bash -c 'exec 3<>/dev/tcp/localhost/8080 && printf "GET / HTTP/1.0\r\n\r\n" >&3 && head -1 <&3 | grep -qF HTTP' || exit 1

ENTRYPOINT ["/opt/webswing/entrypoint.sh"]
