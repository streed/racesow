# syntax=docker/dockerfile:1
#
# Warsow TV: two roles from one image (selected by the ROLE env var).
#
#   ROLE=relay    -> wswtv_server.x86_64: a QTV-style relay that `+connect`s
#                    OUTWARD to a game server and re-serves it on tv_port 44440.
#                    Renders nothing.
#   ROLE=capture  -> warsow.x86_64 (the GL client) run headless under Xvfb + Mesa
#                    software GL (llvmpipe), auto-connected as a spectator, its
#                    framebuffer grabbed by ffmpeg and encoded to HLS. When the
#                    watched server has no players, a branded RACESOW "waiting"
#                    card is shown instead (feh) so the stream is never a black
#                    or empty-map screen.
#
# Both binaries ship in the official warsow-2.1.2 tarball. Ubuntu 18.04 for
# glibc/libstdc++ compatibility with the 2018-era binaries (same base as the
# dedicated-server image).
FROM ubuntu:18.04

ENV DEBIAN_FRONTEND=noninteractive \
    WARSOW_DIR=/warsow

# Runtime libs the GL client dlopen()s/links, software OpenGL (Mesa llvmpipe) +
# GLX, a virtual X server, the idle-card renderer (feh + a font), and ffmpeg.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl bash \
        libc6 libstdc++6 zlib1g libcurl4 \
        libsdl2-2.0-0 libopenal1 libjpeg-turbo8 libpng16-16 \
        libogg0 libvorbis0a libvorbisfile3 libtheora0 libfreetype6 \
        libgl1-mesa-glx libgl1-mesa-dri libglu1-mesa mesa-utils \
        xvfb x11-utils x11-xserver-utils xauth feh xdotool \
        fonts-dejavu-core \
        ffmpeg procps \
    && rm -rf /var/lib/apt/lists/*

# --- Download and unpack the official Warsow 2.1.2 distribution --------------
# We keep the GL client (warsow.x86_64) and the TV relay (wswtv_server.x86_64) —
# the exact binaries the dedicated-server image strips out. Base game data
# (basewsw/*.pk3) is required so the client can actually render maps.
ARG WARSOW_URL=https://warsow.net/warsow-2.1.2.tar.gz
RUN set -eux; \
    mkdir -p "${WARSOW_DIR}"; \
    curl -fSL "${WARSOW_URL}" -o /tmp/warsow.tar.gz; \
    tar -xzf /tmp/warsow.tar.gz -C "${WARSOW_DIR}" --strip-components=1; \
    rm -f /tmp/warsow.tar.gz; \
    cd "${WARSOW_DIR}"; \
    test -f warsow.x86_64; \
    test -f wswtv_server.x86_64

# --- TV scripts + assets -----------------------------------------------------
COPY tv/entrypoint.sh tv/relay-run.sh tv/capture-run.sh tv/getstatus.sh tv/make-card.sh /opt/tv/
COPY tv/assets /opt/tv/assets
RUN chmod +x /opt/tv/*.sh

# Non-root; /hls is the segment output (usually a tmpfs volume shared with nginx).
RUN useradd -r -m -d /home/wtv wtv \
    && mkdir -p /hls \
    && chown -R wtv:wtv "${WARSOW_DIR}" /opt/tv /hls
USER wtv
WORKDIR ${WARSOW_DIR}

EXPOSE 44440/udp 44440/tcp
# Run with docker --init (compose: `init: true`) so PID-1 signal/zombie reaping
# is handled; the entrypoint also traps TERM/INT to kill its Xvfb/ffmpeg/client.
ENTRYPOINT ["/opt/tv/entrypoint.sh"]
