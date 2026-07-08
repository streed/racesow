# syntax=docker/dockerfile:1
#
# Warsow 2.1.2 dedicated race server + hrace racemod.
#
# The image is self-contained: it downloads the official Warsow 2.1.2 Linux
# distribution at build time and compiles the racemod into a .pk3 that is
# dropped into a dedicated `racemod` fs_game directory.
#
# Warsow 2.1 is a 2018-era build, so we base on Ubuntu 18.04 for glibc /
# libstdc++ compatibility with the shipped x86_64 binaries.

FROM ubuntu:18.04

# The racemod source is now vendored at ./racemod/source (our fork of
# DenMSC/wsw-race, branch racemod — see racemod/UPSTREAM) and copied into the
# image below. The RACEMOD_* args are legacy from the git-clone setup and are
# unused; they are kept only so the instruction chain (and therefore the
# cached ~465 MB Warsow download layer) is not invalidated.
ARG RACEMOD_REPO=https://github.com/DenMSC/wsw-race.git
ARG RACEMOD_BRANCH=racemod
ARG WARSOW_URL=https://warsow.net/warsow-2.1.2.tar.gz

ENV DEBIAN_FRONTEND=noninteractive \
    WARSOW_DIR=/warsow \
    FS_GAME=racemod

# --- Runtime + build dependencies -------------------------------------------
# The dedicated server dlopen()s angelwrap/irc and links a handful of shared
# libraries even in headless mode; install the runtime set plus git/zip to
# build the racemod pk3.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        zip \
        unzip \
        libc6 \
        libstdc++6 \
        zlib1g \
        libcurl4 \
        libsdl2-2.0-0 \
        libopenal1 \
        libjpeg-turbo8 \
        libpng16-16 \
        libvorbisfile3 \
        libtheora0 \
        libfreetype6 \
    && rm -rf /var/lib/apt/lists/*

# --- Download and unpack the official Warsow 2.1.2 distribution --------------
# Strip the parts a Linux x86_64 dedicated server does not need (Windows/macOS
# libraries, 32-bit binaries and the graphical client) to keep the image small.
RUN set -eux; \
    mkdir -p "${WARSOW_DIR}"; \
    curl -fSL "${WARSOW_URL}" -o /tmp/warsow.tar.gz; \
    tar -xzf /tmp/warsow.tar.gz -C "${WARSOW_DIR}" --strip-components=1; \
    rm -f /tmp/warsow.tar.gz; \
    cd "${WARSOW_DIR}"; \
    # keep only the linux x86_64 dedicated-server pieces
    rm -f  warsow warsow.i386 warsow.x86_64 wsw_server.i386 || true; \
    rm -f  wswtv_server wswtv_server_x64.exe || true; \
    find libs -type f \( -name '*.dll' -o -name '*.dylib' -o -name '*_i386.so' -o -name '*_x86.so' \) -delete || true; \
    ls -la; \
    test -f wsw_server.x86_64

# --- Build the racemod (hrace gametype) into a pk3 ---------------------------
# The mod source is vendored at ./racemod/source — our fork with local
# additions such as the race event log (hrace/racelog.as). The pk3 is simply a
# zip of the `source/` tree; Warsow's AngelScript VM compiles the gametype
# scripts at runtime. It is dropped into a dedicated fs_game directory so the
# base install stays pristine.
COPY racemod/source /tmp/racemod/source
RUN set -eux; \
    mkdir -p "${WARSOW_DIR}/${FS_GAME}"; \
    cd /tmp/racemod/source; \
    zip -r "${WARSOW_DIR}/${FS_GAME}/hrace.pk3" . -x '.*'; \
    rm -rf /tmp/racemod; \
    ls -la "${WARSOW_DIR}/${FS_GAME}"

# --- Server configuration + entrypoint --------------------------------------
COPY configs/server.cfg  "${WARSOW_DIR}/${FS_GAME}/configs/server/server.cfg"
COPY configs/mappool.txt "${WARSOW_DIR}/${FS_GAME}/mappool.txt"
COPY entrypoint.sh       /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Run as a non-root user.
RUN useradd -r -m -d /home/warsow warsow \
    && chown -R warsow:warsow "${WARSOW_DIR}"
USER warsow
WORKDIR ${WARSOW_DIR}

# Warsow's default server port (UDP). TV port 27960/44400 not exposed here.
EXPOSE 44400/udp

ENTRYPOINT ["/entrypoint.sh"]
