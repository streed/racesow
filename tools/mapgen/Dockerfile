# mapgen toolchain: a pinned q3map2 plus the Python generator.
#
# The build context is tools/ (the generator imports tools/mapfix):
#
#   docker build -t racesow-mapgen -f tools/mapgen/Dockerfile tools
#   docker run --rm --user "$(id -u):$(id -g)" -v "$PWD/build:/out" racesow-mapgen \
#       build examples/gen_first_light.json --out /out
#   docker run --rm --user "$(id -u):$(id -g)" -e ANTHROPIC_API_KEY -v "$PWD/build:/out" \
#       racesow-mapgen generate "a fast icy loop with two big jumps" --out /out
#
# q3map2 comes from netradiant-custom, pinned by commit: its -game qfusion
# writes the FBSP v1 format Warsow loads. The tree needs GCC 14 — GCC 13 and
# Clang 18 both reject its C++20 (designated initialisers with explicit
# constructors; alias-template CTAD) — which is why this is Ubuntu 24.04.
FROM ubuntu:24.04 AS q3map2
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential g++-14 git ca-certificates pkg-config \
        libxml2-dev libglib2.0-dev libjpeg-dev libpng-dev zlib1g-dev \
        libassimp-dev libminizip-dev \
    && rm -rf /var/lib/apt/lists/*
ARG NETRADIANT_REPO=https://github.com/Garux/netradiant-custom
ARG NETRADIANT_COMMIT=8216133984031afaa9a857b56ea66dd9c3d54b26
WORKDIR /build
RUN git init nr && cd nr \
    && git remote add origin "${NETRADIANT_REPO}" \
    && git fetch --depth 1 origin "${NETRADIANT_COMMIT}" \
    && git checkout --quiet FETCH_HEAD
RUN make -C nr -j"$(nproc)" CC=gcc-14 CXX=g++-14 \
        DEPENDENCIES_CHECK=off DOWNLOAD_GAMEPACKS=no binaries-q3map2 \
    && nr/install/q3map2.x86_64 --help 2>&1 | grep -q -- "-game"

FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 python3-pip ca-certificates \
        libassimp5 libglib2.0-0t64 libjpeg-turbo8 libminizip1t64 libpng16-16t64 libxml2 \
    && pip3 install --no-cache-dir --break-system-packages "anthropic>=1.8,<2" \
    && rm -rf /var/lib/apt/lists/*
COPY --from=q3map2 /build/nr/install/q3map2.x86_64 /usr/local/bin/q3map2
COPY mapfix /opt/tools/mapfix
COPY mapgen /opt/tools/mapgen
ENV Q3MAP2=/usr/local/bin/q3map2
WORKDIR /opt/tools/mapgen
# The unit + compile tests run at build time: an image that cannot compile the
# example course is never produced.
RUN python3 -c "import build, sys; sys.exit(0 if build.find_q3map2() else 1)" \
    && python3 test_mapgen.py \
    && rm -rf __pycache__ ../mapfix/__pycache__
ENTRYPOINT ["python3", "/opt/tools/mapgen/mapgen.py"]
