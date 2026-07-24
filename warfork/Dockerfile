# syntax=docker/dockerfile:1
#
# Phase 0 spike: STOCK Warfork dedicated race server.
#
# Unlike the Warsow image (../server/Dockerfile), which builds a patched engine
# + racemod from source, this image runs the OFFICIAL Warfork dedicated server
# pulled from Steam (appid 1136510, anonymous) with the STOCK `race` gametype.
# Its only job is to answer the Phase 0 questions before we invest in a port:
#   1. does the platform (masterserver, downloads, race gametype) work at all;
#   2. does the server enforce module purity / anti-cheat that would block a
#      custom libgame (decides natives-vs-script-only for the real port).
#
# No mod, no engine patches. steamcmd/steamcmd is Debian; wf_server links the
# usual qfusion runtime set even headless, so install those libs.
FROM steamcmd/steamcmd:latest

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl \
        libcurl4 zlib1g libsdl2-2.0-0 libopenal1 \
        libjpeg62-turbo libpng16-16 libvorbisfile3 libtheora0 libfreetype6 \
    && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /entrypoint.sh
COPY configs/server.cfg /opt/warfork/server.cfg
RUN chmod +x /entrypoint.sh

# Warfork dedicated: game UDP + HTTP download/query port (LinuxGSM defaults).
EXPOSE 44400/udp 44444/tcp

ENTRYPOINT ["/entrypoint.sh"]
