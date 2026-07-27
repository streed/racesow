# syntax=docker/dockerfile:1
#
# Racesow WARFORK 2.16 race server.
#
# Unlike ../server/Dockerfile (which downloads the dead Warsow 2.1.2 binary
# distribution and patches DenMSC's game module), this image BUILDS the current
# warfork-qfusion 2.16 engine + a racesow game module FROM SOURCE (no Steam;
# BUILD_STEAMLIB=0), then runs OUR shared racemod gametype as the `racesow`
# fs_game. It feeds the SAME racesow.org stats and joins the SAME cross-server
# mesh as the Warsow servers (one codebase, one leaderboard — see
# docs/warfork-port-design.md). Proven layering (see that doc §8):
#
#   1. lift Gelmo's racesow projectile/prejump natives onto vanilla Warfork
#      (creates the RS_ResetPjState binding our patches anchor on),
#   2. apply OUR RS_Api*/RS_Mirror*/wrghost enginepatches UNCHANGED (Warfork &
#      Warsow share the qfusion game-module lineage, so every anchor matches),
#   3. package the shared racemod gametype with the AS2024 script-patch.
#
# Build from the REPO ROOT (needs server/enginepatches + server/racemod too):
#   docker build -f warfork/Dockerfile -t warfork-race:racesow .

# ===========================================================================
# Stage 1: build wf_server + the racesow-native game module from source.
# ===========================================================================
FROM registry.gitlab.steamos.cloud/steamrt/sniper/sdk:latest AS builder

# gcc-12-monolithic per warfork-qfusion's own linux-build.yml; python3 for the
# patch scripts; git to clone + init submodules.
RUN apt-get update && apt-get install -y --no-install-recommends \
        gcc-12-monolithic python3 git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ARG WARFORK_REPO=https://github.com/TeamForbiddenLLC/warfork-qfusion.git
# Pin the exact tree the port was validated against (Warfork 2.16, proto 27).
ARG WARFORK_REF=3b60d3ba79f372afa73bf299ddf94039151a8360
WORKDIR /src
RUN git clone "${WARFORK_REPO}" . \
    && git checkout "${WARFORK_REF}" \
    # every source/extern submodule EXCEPT crashpad (huge, unused: USE_CRASHPAD=0).
    && git -c submodule.source/extern/crashpad.update=none \
           submodule update --init --recursive --depth 1

# --- (1) racesow base projectile/prejump natives (vendored from Gelmo) --------
# gs_racesow.* (pj_jumps/dashes/walljumps -> RS_QueryPjState/RS_ResetPjState) and
# g_racesow.* (RS_removeProjectiles owner-filter + rs_* weapon-def cvars). The
# CMake globs game/*.cpp + gameshared/*.c so they compile automatically; the
# patch wires the includes + AngelScript bindings. MUST precede our patches.
COPY warfork/enginepatches/g_racesow.cpp  source/game/g_racesow.cpp
COPY warfork/enginepatches/g_racesow.h    source/game/g_racesow.h
COPY warfork/enginepatches/gs_racesow.c   source/gameshared/gs_racesow.c
COPY warfork/enginepatches/gs_racesow.h   source/gameshared/gs_racesow.h
COPY warfork/enginepatches/patch-pjstate-natives.py /tmp/patch-pjstate-natives.py
RUN cd source && python3 /tmp/patch-pjstate-natives.py \
    && grep -q 'asFunc_RS_ResetPjState' game/g_ascript.cpp \
    && grep -q 'G_RemoveProjectiles( Entity @ )' game/g_ascript.cpp \
    && grep -q '#include "gs_racesow.h"' gameshared/gs_public.h

# --- (2) our RS_Api* reporting + RS_Mirror* mesh + WR-ghost cull natives -------
# These anchor on the RS_ResetPjState entry just created, plus the (identical to
# Warsow) asGlobFuncs table / curl-link / Cmd_Say_f / entity_shared_t anchors.
# NOTE dropped: patch-udp-download (Steam handles DL); patch-quad-fix (edits the
# now-Gelmo g_racesow.*, niche cvar) — see design doc. motd-live: TODO recheck.
COPY server/enginepatches/g_rs_api.cpp        source/game/g_rs_api.cpp
COPY server/enginepatches/g_rs_mirror.cpp     source/game/g_rs_mirror.cpp
COPY server/enginepatches/g_rs_mirrorbots.cpp source/game/g_rs_mirrorbots.cpp
COPY server/enginepatches/patch-api-natives.py    /tmp/patch-api-natives.py
COPY server/enginepatches/patch-mirror-natives.py /tmp/patch-mirror-natives.py
COPY server/enginepatches/patch-wrghost-cull.py   /tmp/patch-wrghost-cull.py
RUN cd source \
    && python3 /tmp/patch-api-natives.py \
    && python3 /tmp/patch-mirror-natives.py \
    && python3 /tmp/patch-wrghost-cull.py \
    && grep -q 'asFunc_RS_ApiReportRace'  game/g_ascript.cpp \
    && grep -q 'asFunc_RS_MirrorRefresh'  game/g_ascript.cpp \
    && grep -q 'asFunc_RS_ApiFetchRanks'  game/g_ascript.cpp \
    && grep -q 'RS_MirrorLocalChat'       game/g_cmds.cpp \
    && grep -q 'rs_isWrGhost'             game/g_public.h \
    && grep -q 'rs_isWrGhost'             qcommon/snap_write.c \
    && grep -q 'curl'                     game/CMakeLists.txt

# --- build wf_server + game module + packaged assets --------------------------
RUN cd source \
    && export CC=gcc-12 CXX=g++-12 \
    && cmake -B build --preset workflow-linux-release -DBUILD_STEAMLIB=0 -DUSE_CRASHPAD=0 \
    && cmake --build build --target wf_server -j"$(nproc)" \
    && cmake --build build --target game      -j"$(nproc)" \
    && cmake --build build --target deploy    -j"$(nproc)" \
    # Assert our natives really compiled into the stripped module (log-string
    # literals that exist ONLY in our impls — the heredoc-noop silent-ship guard).
    && SO=build/warfork-qfusion/basewf/libgame_x86_64.so \
    && strings "$SO" | grep -q 'RS_ApiReportRace' \
    && strings "$SO" | grep -q 'rs_api: spooled undeliverable report' \
    && strings "$SO" | grep -q 'rs_mirror: configured' \
    && strings "$SO" | grep -q 'RS_SetHideWrGhost' \
    && strings "$SO" | grep -q 'RS_QueryPjState' \
    && objdump -p "$SO" | grep -qi 'NEEDED.*curl'

# ===========================================================================
# Stage 2: runtime. wf_server dlopen()s its deps, so the sniper runtime carries
# everything it needs. (TODO: slim to steamrt/sniper/platform to shrink.)
# ===========================================================================
FROM registry.gitlab.steamos.cloud/steamrt/sniper/sdk:latest

RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 zip ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV WF_DIR=/warfork \
    FS_GAME=racesow

# The built engine + packaged basewf (incl. the racesow-native libgame, loose in
# basewf so it is the base module for every fs_game).
COPY --from=builder /src/source/build/warfork-qfusion ${WF_DIR}

# --- package the shared racemod gametype as the `racesow` fs_game -------------
# Copy the SINGLE-SOURCE scripts, apply the Warfork AS2024 script-patch to THIS
# COPY only (server/racemod/source stays Warsow-compatible), then pak them. The
# engine's AngelScript VM compiles them at boot.
COPY server/racemod/source/progs /tmp/racesow/progs
COPY warfork/scriptpatches/patch-scripts-as2024.py /tmp/patch-scripts-as2024.py
RUN set -eux; \
    python3 /tmp/patch-scripts-as2024.py /tmp/racesow/progs; \
    mkdir -p "${WF_DIR}/${FS_GAME}"; \
    cd /tmp/racesow; \
    zip -r "${WF_DIR}/${FS_GAME}/hrace.pk3" . -x '.*'; \
    rm -rf /tmp/racesow; \
    # sanity: the gametype manifest + a patched call landed in the pak
    unzip -p "${WF_DIR}/${FS_GAME}/hrace.pk3" progs/gametypes/hrace.gt >/dev/null

# --- server config + entrypoint ----------------------------------------------
COPY warfork/configs/server.cfg "${WF_DIR}/${FS_GAME}/configs/server/server.cfg"
# Same curated map cycle the Warsow servers use (server/configs/mappool.txt), so
# the rotation is consistent across both games (entrypoint reads it).
COPY server/configs/mappool.txt "${WF_DIR}/${FS_GAME}/mappool.txt"
COPY warfork/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Non-root. demos/topscores/racelog dirs pre-created so bind/named-volume mounts
# come up writable by the server user.
RUN useradd -r -m -d /home/warfork warfork \
    && mkdir -p "${WF_DIR}/${FS_GAME}/demos" "${WF_DIR}/${FS_GAME}/topscores" "${WF_DIR}/${FS_GAME}/racelog" \
    && chown -R warfork:warfork "${WF_DIR}"
USER warfork
WORKDIR ${WF_DIR}

# game UDP, http/pak TCP, cross-server mesh UDP (see docker-compose.warfork.yml)
EXPOSE 44410/udp 44411/tcp 44451/udp

ENTRYPOINT ["/entrypoint.sh"]
