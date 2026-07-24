#!/usr/bin/env bash
#
# Build a STOCK Warfork Linux dedicated server + game module from source.
#
# Why from source (not SteamCMD): the Warfork Dedicated Server (appid 1136510)
# is NOT anonymously downloadable right now — the public Steam build fails to
# commit ("Missing configuration") and the current `beta` branch is gated to
# licensed accounts. warfork-qfusion is GPLv2, so we build the bits ourselves.
# This is also the path the real racesow port needs (custom game module).
#
# The build matches TeamForbidden's own recipe (Dockerfile + linux-build.yml):
#   - base image  : registry.gitlab.steamos.cloud/steamrt/sniper/sdk  (+ gcc-12)
#   - configure   : cmake --preset workflow-linux-release
#   - our overrides: -DBUILD_STEAMLIB=0 -DUSE_CRASHPAD=0  (no Steamworks SDK,
#                    no crashpad -> no giant crashpad submodule, no Steam login)
#   - target      : wf_server  (pulls in game + angelwrap + tracy)
#   - assets      : make deploy  (runs package_assets.cmake -> basewf/)
#
# Output: source/build/warfork-qfusion/{wf_server.x86_64, basewf/libgame_x86_64.so, ...}
# and a copy staged into ./dist for the runtime image.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/TeamForbiddenLLC/warfork-qfusion.git}"
SRC="${SRC:-$HOME/warfork-build/warfork-qfusion}"
CONFIG="${CONFIG:-release}"
BUILDER_IMAGE="${BUILDER_IMAGE:-warfork-builder}"
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "==> Source tree: $SRC"
if [[ ! -d "$SRC/.git" ]]; then
    echo "==> Cloning $REPO_URL (shallow)"
    mkdir -p "$(dirname "$SRC")"
    git clone --depth 1 "$REPO_URL" "$SRC"
fi

# Init every source/extern submodule EXCEPT crashpad (huge; unused with
# USE_CRASHPAD=0). angelscript is vendored in-tree (third-party/), not a submodule.
echo "==> Initialising submodules (skipping crashpad)"
git -C "$SRC" -c submodule.source/extern/crashpad.update=none \
    submodule update --init --recursive --depth 1

# Builder image = sniper SDK + gcc-12-monolithic (repo's own Dockerfile).
if ! docker image inspect "$BUILDER_IMAGE" >/dev/null 2>&1; then
    echo "==> Building $BUILDER_IMAGE"
    docker build -t "$BUILDER_IMAGE" "$SRC"
fi

echo "==> Building wf_server + game module ($CONFIG) in $BUILDER_IMAGE"
docker run --rm -v "$SRC:/root/warfork" -w /root/warfork/source "$BUILDER_IMAGE" \
    bash -euxc '
        export CC=gcc-12 CXX=g++-12
        cmake -B build --preset workflow-linux-'"$CONFIG"' \
            -DBUILD_STEAMLIB=0 -DUSE_CRASHPAD=0
        cmake --build build --target wf_server -j"$(nproc)"
        cmake --build build --target deploy   -j"$(nproc)"
    '

# The preset's binaryDir is ${sourceDir}/build, i.e. source/build/warfork-qfusion.
OUT="$SRC/source/build/warfork-qfusion"
echo "==> Collecting artifacts from $OUT"
mkdir -p "$HERE/dist"
cp -av "$OUT/wf_server"* "$HERE/dist/" 2>/dev/null || true
# Stage the built game module + assets tree for the runtime image.
rsync -a --delete "$OUT/basewf/" "$HERE/dist/basewf/" 2>/dev/null || cp -a "$OUT/basewf" "$HERE/dist/"

echo "==> Done. Server: $HERE/dist/  (wf_server + basewf/)"
ls -la "$HERE/dist" || true
