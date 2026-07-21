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

# ===========================================================================
# Stage 1: build the patched game module (libgame_x86_64.so).
#
# The hrace gametype calls racesow natives the STOCK Warsow game module lacks
# (RS_QueryPjState / RS_ResetPjState / G_RemoveProjectiles(Entity@)), so the
# gametype script fails to compile on stock Warsow. We build a patched game
# module from DenMSC's warsow_21_sdk fork (which registers those natives),
# linked against the official AngelScript 2.29.2 (Warsow 2.1.2's ABI). See
# Dockerfile.gamemod for the standalone/iteration version of this stage.
# ===========================================================================
FROM ubuntu:18.04 AS gamemod
# The dev libraries beyond build-essential are needed only to CONFIGURE the
# full qfusion tree for the dedicated-server build (find_package REQUIRED);
# on Linux the engine dlopen()s them at runtime rather than linking.
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential cmake git ca-certificates curl unzip python3 \
        libcurl4-openssl-dev zlib1g-dev libogg-dev libvorbis-dev \
        libtheora-dev libfreetype6-dev libjpeg-dev libpng-dev libsdl2-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
ARG GAMESRC_REPO=https://github.com/DenMSC/racemod_2.1
ARG GAMESRC_BRANCH=race-demos
RUN git clone --depth 1 -b "${GAMESRC_BRANCH}" "${GAMESRC_REPO}" repo
ARG ANGELSCRIPT_URL=https://www.angelcode.com/angelscript/sdk/files/angelscript_2.29.2.zip
RUN mkdir -p repo/libsrcs/angelscript \
    && curl -fSL "${ANGELSCRIPT_URL}" -o /tmp/as.zip \
    && unzip -q /tmp/as.zip -d repo/libsrcs/angelscript \
    && rm -f /tmp/as.zip
# AngelScript 2.29.2 predates GCC 5's removal of the std::has_trivial_* traits;
# swap in the standard std::is_trivially_* names so it builds on GCC 7 (18.04).
RUN AS_H=repo/libsrcs/angelscript/sdk/angelscript/include/angelscript.h \
    && sed -i \
        -e 's/has_trivial_default_constructor/is_trivially_default_constructible/g' \
        -e 's/has_trivial_copy_constructor/is_trivially_copy_constructible/g' \
        -e 's/has_trivial_copy_assign/is_trivially_copy_assignable/g' \
        -e 's/has_trivial_destructor/is_trivially_destructible/g' \
        "$AS_H"
# Pre-build libangelscript.a where CMake's ANGELSCRIPT_LIBRARY expects it (the
# in-CMake angelscript custom target uses a shell-style command CMake can't exec).
RUN make -C repo/libsrcs/angelscript/sdk/angelscript/projects/gnuc -j"$(nproc)"
RUN sed -i -E \
        's#add_custom_target\(angelscript .*#add_custom_target(angelscript ${CMAKE_COMMAND} -E echo angelscript-prebuilt)#' \
        repo/source/CMakeLists.txt
# 6. Direct-to-API race reporting: add the RS_ApiReportRace native (libcurl on
#    a worker thread) so the hrace gametype POSTs finishes straight to the
#    stats /api/ingest — no racelog-scraping sidecar needed. g_rs_api.cpp is
#    picked up by the game CMakeLists' *.cpp glob; the patch script registers
#    the AngelScript binding and links curl. The greps assert it landed.
COPY enginepatches/g_rs_api.cpp /build/repo/source/game/g_rs_api.cpp
COPY enginepatches/patch-api-natives.py /tmp/patch-api-natives.py
WORKDIR /build/repo/source
RUN python3 /tmp/patch-api-natives.py \
    && grep -q "RS_ApiReportRace" game/g_ascript.cpp \
    && grep -q "RS_ApiReportWrDemo" game/g_ascript.cpp \
    && grep -q "asFunc_RS_ApiFetchGhost" game/g_ascript.cpp \
    && grep -q "asFunc_RS_ApiFlag" game/g_ascript.cpp \
    && grep -q "asFunc_RS_ApiFetchBlocked" game/g_ascript.cpp \
    && grep -q "asFunc_RS_ApiFetchMotd" game/g_ascript.cpp \
    && grep -q "curl pthread" game/CMakeLists.txt

# 7. Cross-server player mirroring: the RS_Mirror* natives (UDP mesh on a
#    worker thread, see g_rs_mirror.cpp) let peered servers exchange live
#    player positions and chat. The patch also hooks Cmd_Say_f so public chat
#    reaches the mesh. Runs after patch-api-natives.py (anchor order).
COPY enginepatches/g_rs_mirror.cpp /build/repo/source/game/g_rs_mirror.cpp
COPY enginepatches/g_rs_mirrorbots.cpp /build/repo/source/game/g_rs_mirrorbots.cpp
COPY enginepatches/patch-mirror-natives.py /tmp/patch-mirror-natives.py
RUN python3 /tmp/patch-mirror-natives.py \
    && grep -q "asFunc_RS_MirrorRefresh" game/g_ascript.cpp \
    && grep -q "asFunc_RS_MirrorBotAdd" game/g_ascript.cpp \
    && grep -q "asFunc_RS_MirrorPeerCount" game/g_ascript.cpp \
    && grep -q "asFunc_RS_SetHideWrGhost" game/g_ascript.cpp \
    && grep -q "RS_MirrorLocalChat" game/g_cmds.cpp \
    && grep -q "RS_MirrorLocalChat" game/g_gameteams.cpp

# 7b. Per-client world-record ghost visibility: two server-only booleans on
#     entity_shared_t + one filter in SNAP_SnapCullEntity so a player can hide
#     just the WR ghost for themselves ("wrghost off"), without touching mesh
#     ghosts, other viewers, the scoreboard, or the wire format. The RS_Set-
#     HideWrGhost native (g_rs_mirrorbots.cpp) drives it. Patches g_public.h
#     (needed by the game build below) and qcommon/snap_write.c (needed by the
#     dedicated-server build later). The greps assert both edits landed.
COPY enginepatches/patch-wrghost-cull.py /tmp/patch-wrghost-cull.py
RUN python3 /tmp/patch-wrghost-cull.py \
    && grep -q "rs_isWrGhost" game/g_public.h \
    && grep -q "rs_hideWrGhost" game/g_public.h \
    && grep -q "rs_isWrGhost" qcommon/snap_write.c \
    && grep -q "rs_hideWrGhost" qcommon/snap_write.c

# 8. Quad rocket-jump fix (rs_quad_fix, default 0): racesow's self-knockback
#    recompute in G_RadiusDamage discards the fire-time QUAD_KNOCKBACK_SCALE, so
#    quad does nothing for rocket/plasma/grenade jumps -- unlike Quake3/defrag,
#    where knockback tracks quad-scaled damage. This re-applies the x3 boost
#    behind the rs_quad_fix cvar for testing. Edits g_combat.cpp + g_racesow.{h,cpp};
#    independent of the g_ascript.cpp natives patches above. The greps assert it landed.
COPY enginepatches/patch-quad-fix.py /tmp/patch-quad-fix.py
RUN python3 /tmp/patch-quad-fix.py \
    && grep -q "rs_quad_knockback_scale" game/g_racesow.h \
    && grep -q "rs_quad_fix = trap_Cvar_Get" game/g_racesow.cpp \
    && grep -q "rs_quad_knockback_scale = trap_Cvar_Get" game/g_racesow.cpp \
    && grep -q "rs_quad_fix->integer" game/g_combat.cpp \
    && grep -q "rs_quad_knockback_scale->value" game/g_combat.cpp

RUN cmake -DQFUSION_GAME=Warsow -DGAME_MODULES_ONLY=ON -DCMAKE_BUILD_TYPE=Release . \
    && make game -j"$(nproc)" \
    && cp build/basewsw/libgame_x86_64.so /libgame_x86_64.so \
    # The module must carry the natives and require libcurl at runtime. The
    # Release .so is fully stripped and the natives are hidden-visibility, so
    # NO symbol table can prove they compiled in (nm shows "no symbols";
    # nm -D lacks them). Instead assert on log-string literals that exist
    # ONLY in g_rs_api.cpp — present iff the implementation was compiled in —
    # plus the registration string from the g_ascript patch.
    && strings /libgame_x86_64.so | grep -q "RS_ApiReportRace" \
    && strings /libgame_x86_64.so | grep -q "rs_api: dropping report" \
    && strings /libgame_x86_64.so | grep -q "rs_api: top-scores fetch failed" \
    # replay feature: WR demo pointer + ghost upload/fetch natives, and the
    # per-client race-demo binding (racerecord) the demo capture calls.
    && strings /libgame_x86_64.so | grep -q "RS_ApiReportWrDemo" \
    && strings /libgame_x86_64.so | grep -q "RS_ApiFetchGhost" \
    && strings /libgame_x86_64.so | grep -q "rs_api: ghost fetch failed" \
    # in-game /flag: the RS_ApiFlag native registration string.
    && strings /libgame_x86_64.so | grep -q "RS_ApiFlag" \
    # live map blocklist: the fetch native + its worker log string.
    && strings /libgame_x86_64.so | grep -q "RS_ApiFetchBlocked" \
    && strings /libgame_x86_64.so | grep -q "rs_api: blocked-maps fetch failed" \
    # live MOTD: the fetch native + its worker log string.
    && strings /libgame_x86_64.so | grep -q "RS_ApiFetchMotd" \
    && strings /libgame_x86_64.so | grep -q "rs_api: motd fetch failed" \
    && strings /libgame_x86_64.so | grep -q "racerecord" \
    && strings /libgame_x86_64.so | grep -q "rs_mirror: configured" \
    && strings /libgame_x86_64.so | grep -q "rs_mirror: bot slot" \
    # per-client WR-ghost toggle native registration string (survives stripping)
    && strings /libgame_x86_64.so | grep -q "RS_SetHideWrGhost" \
    # rs_quad_fix cvar names survive stripping as trap_Cvar_Get string literals
    && strings /libgame_x86_64.so | grep -q "rs_quad_fix" \
    && strings /libgame_x86_64.so | grep -q "rs_quad_knockback_scale" \
    && objdump -p /libgame_x86_64.so | grep -q "NEEDED.*libcurl"

# --- Patched dedicated server binary ----------------------------------------
# Stock Warsow's UDP pak-download path is broken: clients save non-official
# pak downloads under downloads/ and request transfer chunks under that name,
# but SV_NextDownload_f compares (and echoes) the server-side name, so every
# transfer dies with "nextdl message for wrong filename". Production servers
# never hit this because they served paks over HTTP — but the only HTTP source
# clients accept for pure content is the official update mirror, which is now
# a dead/parked domain. Patch the server to accept the downloads/-prefixed
# name and echo the client's name back, then build the dedicated server from
# the same tree. (The patch is a COPY'd script, NOT a RUN heredoc: the classic
# docker builder parses heredocs but does not feed them to stdin, silently
# skipping the body.) The greps assert the patch really landed.
COPY enginepatches/patch-udp-download.py /tmp/patch-udp-download.py
RUN python3 /tmp/patch-udp-download.py \
    && grep -q "racesow-docker" server/sv_client.c
# Hide cross-server mirror-bot ghosts from getstatus/heartbeats so the web live
# page and server browser don't double-count a mirrored player on both servers.
COPY enginepatches/patch-status-hide-bots.py /tmp/patch-status-hide-bots.py
RUN python3 /tmp/patch-status-hide-bots.py \
    && grep -q "racesow-docker: mirror-bot ghosts" server/sv_oob.c
# Live MOTD: stock Warsow snapshots sv_MOTDString into svs.motd only at map
# spawn, but the gametype now sets that cvar at runtime from the central
# /api/game/motd (hrace/motd.as). Re-read it on every client "svmotd" request
# so an admin edit shows to the very next connect, not the next map change.
COPY enginepatches/patch-motd-live.py /tmp/patch-motd-live.py
RUN python3 /tmp/patch-motd-live.py \
    && grep -q "racesow-docker: live MOTD" server/sv_motd.c
RUN cmake -DQFUSION_GAME=Warsow -DGAME_MODULES_ONLY=OFF -DCMAKE_BUILD_TYPE=Release . \
    && make wsw_server -j"$(nproc)" \
    && cp build/wsw_server.x86_64 /wsw_server.x86_64 \
    # the patched error string must be embedded in the binary
    && strings /wsw_server.x86_64 | grep -q 'nextdl message for wrong filename "'

# ===========================================================================
# Stage 2: the Warsow 2.1.2 dedicated race server.
# ===========================================================================
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

# --- Drop in the patched game module (from stage 1) -------------------------
# Package libgame_x86_64.so into a pk3 in the mod dir. The name deliberately
# does NOT end in "pure": stock Warsow keeps its libgame in the non-pure
# basewsw/modules_21.pk3, so the mod-dir pak wins the module search (fs_game
# paths are searched before basewsw), while staying OFF the sv_pure list —
# clients refuse to download pk3s containing native libraries, so a pure-listed
# module pak would fail every stock client with "Pure check failed".
# (sv_pure_forcemodulepk3 in server.cfg points clients at the stock
# modules_21.pk3 they already have.)
COPY --from=gamemod /libgame_x86_64.so /tmp/libgame_x86_64.so
RUN set -eux; \
    cd /tmp; \
    zip -X "${WARSOW_DIR}/${FS_GAME}/modules_racesow_21.pk3" libgame_x86_64.so; \
    rm -f /tmp/libgame_x86_64.so

# --- Swap in the patched dedicated server binary (from stage 1) --------------
# Fixes the UDP pak-download filename mismatch (see stage 1). The stock binary
# is kept alongside for a quick rollback.
RUN cp "${WARSOW_DIR}/wsw_server.x86_64" "${WARSOW_DIR}/wsw_server.x86_64.stock"
COPY --from=gamemod /wsw_server.x86_64 ${WARSOW_DIR}/wsw_server.x86_64

# --- Client UI/HUD data pk3 (the in-game "Racemod Options" menu) -------------
# The gametype's "Race options" button runs `menu_open racemod_main` on the
# client, which needs ui/porkui/racemod_main.rml — a client-side asset stock
# Warsow lacks. Vendored from DenMSC/racemod_data (see clientdata/UPSTREAM).
# The name deliberately does NOT end in "pure": clients refuse to download
# explicit-pure paks from anywhere but the official update mirror (long dead).
# Instead the gametype pure-indexes a file inside this pak (see
# GT_InitGametype in racemod/source/progs/gametypes/hrace.as), which puts it
# on the pure list as a referenced pak — those the client downloads straight
# from this server over the game connection.
COPY clientdata /tmp/clientdata
RUN set -eux; \
    cd /tmp/clientdata; \
    # Deterministic pak: fixed mtimes, sorted entries, UTC DOS times — every
    # rebuild of the same clientdata tree is byte-identical, so all servers
    # reference the same checksum. A drifted checksum under the same pak name
    # means "Pure check failed" for every client holding the other copy.
    find ui huds gfx scripts sounds racemod_ui_v7.txt -exec touch -t 200901010000.00 {} +; \
    find ui huds gfx scripts sounds racemod_ui_v7.txt -type f ! -name '.*' | sort \
        | TZ=UTC zip -X -D "${WARSOW_DIR}/${FS_GAME}/racemod_ui_v7_local.pk3" -@; \
    # the gametype must pure-index the marker this pak actually ships, else
    # clients are never told to download it (the recurring v3/v4 drift bug)
    unzip -p "${WARSOW_DIR}/${FS_GAME}/hrace.pk3" progs/gametypes/hrace.as | grep -q 'racemod_ui_v7.txt'; \
    unzip -Z1 "${WARSOW_DIR}/${FS_GAME}/racemod_ui_v7_local.pk3" | grep -qx 'racemod_ui_v7.txt'; \
    rm -rf /tmp/clientdata

# --- Server configuration + entrypoint --------------------------------------
COPY configs/server.cfg  "${WARSOW_DIR}/${FS_GAME}/configs/server/server.cfg"
COPY configs/mappool.txt "${WARSOW_DIR}/${FS_GAME}/mappool.txt"
COPY entrypoint.sh       /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Run as a non-root user. /pakshare is the export point for the optional HTTP
# pak mirror (docker-compose.yml pakserver); pre-owning it makes the named
# volume writable by the server user when this container initializes it.
RUN useradd -r -m -d /home/warsow warsow \
    && mkdir -p /pakshare \
    && chown -R warsow:warsow "${WARSOW_DIR}" /pakshare
USER warsow
WORKDIR ${WARSOW_DIR}

# Warsow's default server port (UDP). TV port 27960/44400 not exposed here.
EXPOSE 44400/udp

ENTRYPOINT ["/entrypoint.sh"]
