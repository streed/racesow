# syntax=docker/dockerfile:1
#
# Racesow WARFORK 2.15.1 race server.
#
# Pinned to v2.15.1 (APP_PROTOCOL_VERSION 26) — this MATCHES the Warfork Steam
# clients players actually run. Building from 2.16 (proto 27) broke the map
# download handshake ("Unknown server command: initdownload" → "Download request
# timed out" → "Couldn't load maps/<x>.bsp"): the client/server download command
# set differs across that version gap.
#
# Builds warfork-qfusion @ v2.15.1 from source (ubuntu:20.04 + clang, no Steam:
# BUILD_STEAMLIB=0; 2.15.1 vendors its deps in-tree so there are NO submodules),
# lifts Gelmo's racesow projectile natives + applies our RS_Api*/RS_Mirror*/
# wrghost patches (all anchors verified on 2.15.1), paks the base assets (2.15.1
# has no `deploy` target), and runs OUR racemod as the `racesow` fs_game. All
# patch anchors + the AS2024 script-patch (2.15.1's AngelScript is method-style,
# same as 2.16) apply unchanged.
#
# Build from the REPO ROOT:
#   docker build -f warfork/Dockerfile -t warfork-race:racesow .

# ===========================================================================
# Stage 1: build wf_server + the racesow game module from 2.15.1 source.
# ===========================================================================
FROM ubuntu:20.04 AS builder
ARG DEBIAN_FRONTEND=noninteractive
# 2.15.1's own Dockerfile recipe: clang + these -dev libs; + python3 for patches.
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl clang cmake build-essential ca-certificates git zip unzip python3 \
        libsdl2-dev libopenal-dev libvorbis-dev libtheora-dev \
        libfreetype6-dev libcurl4-gnutls-dev \
    && rm -rf /var/lib/apt/lists/*

ARG WARFORK_REPO=https://github.com/TeamForbiddenLLC/warfork-qfusion.git
ARG WARFORK_REF=v2.15.1
WORKDIR /src
RUN git clone --depth 1 -b "${WARFORK_REF}" "${WARFORK_REPO}" .

# --- (1) racesow base projectile/prejump natives (vendored from Gelmo) --------
COPY warfork/enginepatches/g_racesow.cpp  source/game/g_racesow.cpp
COPY warfork/enginepatches/g_racesow.h    source/game/g_racesow.h
COPY warfork/enginepatches/gs_racesow.c   source/gameshared/gs_racesow.c
COPY warfork/enginepatches/gs_racesow.h   source/gameshared/gs_racesow.h
COPY warfork/enginepatches/patch-pjstate-natives.py /tmp/patch-pjstate-natives.py
# The pmove counters that FEED RS_QueryPjState. Without them the natives bind
# but always answer false, so the prejump rule (1 jump / 1 dash / 1 walljump
# before the start line) is silently unenforced. Warsow's module is built from
# DenMSC/racemod_2.1, which already carries these hooks; vanilla Warfork does
# not. Anchors verified byte-identical on 2.15.1.
COPY warfork/enginepatches/patch-pjcount-hooks.py /tmp/patch-pjcount-hooks.py
RUN cd source && python3 /tmp/patch-pjstate-natives.py \
    && python3 /tmp/patch-pjcount-hooks.py \
    && grep -q 'asFunc_RS_ResetPjState' game/g_ascript.cpp \
    && grep -q 'G_RemoveProjectiles( Entity @ )' game/g_ascript.cpp \
    && [ "$(grep -c 'racesow - pjcount' gameshared/gs_pmove.c)" = 4 ] \
    && grep -q 'clear prejump counters' gameshared/gs_pmove.c

# --- (2) our RS_Api* reporting + RS_Mirror* mesh + WR-ghost cull natives -------
COPY server/enginepatches/g_rs_api.cpp        source/game/g_rs_api.cpp
COPY server/enginepatches/g_rs_mirror.cpp     source/game/g_rs_mirror.cpp
COPY server/enginepatches/g_rs_mirrorbots.cpp source/game/g_rs_mirrorbots.cpp
COPY server/enginepatches/patch-api-natives.py    /tmp/patch-api-natives.py
COPY server/enginepatches/patch-mirror-natives.py /tmp/patch-mirror-natives.py
COPY server/enginepatches/patch-wrghost-cull.py   /tmp/patch-wrghost-cull.py
# Hide the cross-server mirror-bot ghosts (SVF_FAKECLIENT slots) from the
# getstatus/heartbeat player list, exactly as the Warsow image does — otherwise
# mesh ghosts leak out as real players on THIS server (inflated browser count,
# same player shown on two servers). The patch's sv_oob.c anchors match Warfork
# 2.15.1 byte-for-byte, so the shared script applies unchanged.
COPY server/enginepatches/patch-status-hide-bots.py /tmp/patch-status-hide-bots.py
# Live MOTD: re-read sv_MOTDString per "svmotd" request so an /admin/motd edit
# (pushed to sv_MOTDString by hrace/motd.as via the RS_ApiFetchMotd native) shows
# to newly connecting players without a restart. Anchor (SV_MOTD_Get_f) matches
# Warfork 2.15.1's server/sv_motd.c, so the shared script applies unchanged.
COPY server/enginepatches/patch-motd-live.py /tmp/patch-motd-live.py
# Quiet the connect/disconnect console spam from infra fake-clients (WR ghost +
# mesh mirror bots). Same game/p_client.cpp anchors as Warsow 2.1.2 (verified
# byte-identical in Warfork 2.15.1), so the shared script applies unchanged.
COPY server/enginepatches/patch-quiet-fakeclient-connect.py /tmp/patch-quiet-fakeclient-connect.py
RUN cd source \
    && python3 /tmp/patch-api-natives.py \
    && python3 /tmp/patch-mirror-natives.py \
    && python3 /tmp/patch-wrghost-cull.py \
    && python3 /tmp/patch-status-hide-bots.py \
    && python3 /tmp/patch-motd-live.py \
    && python3 /tmp/patch-quiet-fakeclient-connect.py \
    && grep -q 'asFunc_RS_ApiReportRace'  game/g_ascript.cpp \
    && grep -q 'asFunc_RS_MirrorRefresh'  game/g_ascript.cpp \
    && grep -q 'asFunc_RS_ApiFetchRanks'  game/g_ascript.cpp \
    && grep -q 'asFunc_RS_ApiFetchAnnounce' game/g_ascript.cpp \
    && grep -q 'asFunc_RS_ApiFetchPlayerRecord' game/g_ascript.cpp \
    && grep -q 'asFunc_RS_ApiFetchSavedStart' game/g_ascript.cpp \
    && grep -q 'asFunc_RS_ApiSaveStart' game/g_ascript.cpp \
    && grep -q 'asFunc_RS_ApiFetchAwards' game/g_ascript.cpp \
    && grep -q 'asFunc_RS_ApiFetchTourney' game/g_ascript.cpp \
    && grep -q 'asFunc_RS_ApiTourneyJoin' game/g_ascript.cpp \
    && grep -q 'RS_MirrorLocalChat'       game/g_cmds.cpp \
    && grep -q 'rs_isWrGhost'             game/g_public.h \
    && grep -q 'rs_isWrGhost'             qcommon/snap_write.c \
    && grep -q 'racesow-docker: mirror-bot ghosts' server/sv_oob.c \
    && grep -q 'racesow-docker: live MOTD' server/sv_motd.c \
    && grep -q 'racesow-docker: fake clients' game/p_client.cpp

# --- build wf_server + game module (2.15.1: plain cmake, no preset/submodules) -
RUN export CC=clang CXX=clang++ \
    && cmake -S source -B build -DCMAKE_BUILD_TYPE=RelWithDebInfo -DBUILD_STEAMLIB=0 \
    && cmake --build build --target wf_server -j"$(nproc)" \
    && cmake --build build --target game      -j"$(nproc)" \
    # Assert our natives compiled into the module (log-string literals unique to
    # our impls — guards the silent-ship-unpatched-binary failure mode).
    && SO=source/build/basewf/libgame_x86_64.so \
    && strings "$SO" | grep -q 'RS_ApiReportRace' \
    && strings "$SO" | grep -q 'RS_ApiFetchPlayerRecord' \
    && strings "$SO" | grep -q 'RS_ApiFetchAnnounce' \
    && strings "$SO" | grep -q 'RS_ApiFetchSavedStart' \
    && strings "$SO" | grep -q 'RS_ApiSaveStart' \
    && strings "$SO" | grep -q 'RS_ApiFetchTourney' \
    && strings "$SO" | grep -q 'RS_ApiTourneyJoin' \
    && strings "$SO" | grep -q 'rs_api: spooled undeliverable report' \
    && strings "$SO" | grep -q 'rs_mirror: configured' \
    && strings "$SO" | grep -q 'RS_SetHideWrGhost' \
    && strings "$SO" | grep -q 'RS_QueryPjState' \
    # The prejump counters must be CALLED, not merely present: `strings` would
    # pass on a build where patch-pjcount-hooks.py silently no-op'd, and the
    # symptom (prejump unenforced) is invisible until a player exploits it.
    # Call-site COUNT is not asserted — clang tail-merges PM_Jump's two
    # increments into one call — only that each is reached at least once.
    && objdump -d "$SO" > /tmp/libgame.dis \
    && grep -q 'call.*<RS_IncrementJumps>'     /tmp/libgame.dis \
    && grep -q 'call.*<RS_IncrementDashes>'    /tmp/libgame.dis \
    && grep -q 'call.*<RS_IncrementWallJumps>' /tmp/libgame.dis \
    && rm -f /tmp/libgame.dis \
    && objdump -p "$SO" | grep -qi 'NEEDED.*curl'

# --- pak the base assets into basewf (no `deploy` target in 2.15.1) -----------
# assets/data*_21* are loose trees (scripts/maps/configs); zip each into a
# basewf pak the engine loads. Deterministic (-X, sorted) for stable checksums.
RUN cd assets \
    && for d in data*; do [ -d "$d" ] && ( cd "$d" && find . -type f | sort | zip -qX -@ "/src/source/build/basewf/$d.pk3" ); done \
    && ls -la /src/source/build/basewf/*.pk3

# ===========================================================================
# Stage 2: runtime (ubuntu:20.04, matching the 2.15.1 build toolchain libs).
# ===========================================================================
FROM ubuntu:20.04
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl zip unzip python3 coreutils \
        libsdl2-2.0-0 libopenal1 libvorbisfile3 libtheora0 libfreetype6 \
        libcurl3-gnutls zlib1g \
    && rm -rf /var/lib/apt/lists/*

ENV WF_DIR=/warfork \
    FS_GAME=racesow

# Built engine + packaged basewf (racesow-native libgame + base data paks).
COPY --from=builder /src/source/build ${WF_DIR}

# --- package our racemod as the `racesow` fs_game (with AS2024 script-patch) --
COPY server/racemod/source/progs /tmp/racesow/progs
COPY warfork/scriptpatches/patch-scripts-as2024.py /tmp/patch-scripts-as2024.py
RUN set -eux; \
    python3 /tmp/patch-scripts-as2024.py /tmp/racesow/progs; \
    mkdir -p "${WF_DIR}/${FS_GAME}"; \
    cd /tmp/racesow; \
    zip -rqX "${WF_DIR}/${FS_GAME}/hrace.pk3" . -x '.*'; \
    rm -rf /tmp/racesow; \
    unzip -p "${WF_DIR}/${FS_GAME}/hrace.pk3" progs/gametypes/hrace.gt >/dev/null

# --- client UI/HUD pak (racehud v8 + the "Race options" menu) -----------------
# hrace.as GT_InitGametype pure-indexes racemod_ui_v8.txt, so with sv_pure the
# connecting client is told to download this pak automatically (it is the same
# ui/porkui/ RmlUi system Warfork's basewf uses). Deterministic pak (fixed
# mtimes, sorted, UTC) so every server references the same checksum. The name
# deliberately does NOT end in "pure" — clients refuse explicit-pure paks from
# anywhere but the (dead) official mirror. Same clientdata as the Warsow image.
COPY server/clientdata /tmp/clientdata
RUN set -eux; \
    cd /tmp/clientdata; \
    find ui huds gfx scripts sounds racemod_ui_v8.txt -exec touch -t 200901010000.00 {} +; \
    find ui huds gfx scripts sounds racemod_ui_v8.txt -type f ! -name '.*' | sort \
        | TZ=UTC zip -X -D "${WF_DIR}/${FS_GAME}/racemod_ui_v8_local.pk3" -@; \
    unzip -p "${WF_DIR}/${FS_GAME}/hrace.pk3" progs/gametypes/hrace.as | grep -q 'racemod_ui_v8.txt'; \
    unzip -Z1 "${WF_DIR}/${FS_GAME}/racemod_ui_v8_local.pk3" | grep -qx 'racemod_ui_v8.txt'; \
    rm -rf /tmp/clientdata

# --- server config + shared map cycle + entrypoint ---------------------------
COPY warfork/configs/server.cfg "${WF_DIR}/${FS_GAME}/configs/server/server.cfg"
COPY server/configs/mappool.txt "${WF_DIR}/${FS_GAME}/mappool.txt"
COPY warfork/entrypoint.sh /entrypoint.sh
# Same watchdog as the Warsow image — one script, both games (it reads SV_PORT).
COPY server/gamehealth.sh /usr/local/bin/gamehealth.sh
RUN chmod +x /entrypoint.sh /usr/local/bin/gamehealth.sh

RUN useradd -r -m -d /home/warfork warfork \
    && mkdir -p "${WF_DIR}/${FS_GAME}/demos" "${WF_DIR}/${FS_GAME}/topscores" "${WF_DIR}/${FS_GAME}/racelog" \
    && chown -R warfork:warfork "${WF_DIR}"
USER warfork
WORKDIR ${WF_DIR}

# game UDP, http/pak TCP, cross-server mesh UDP
EXPOSE 44410/udp 44411/tcp 44451/udp

ENTRYPOINT ["/entrypoint.sh"]
