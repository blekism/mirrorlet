#!/usr/bin/env bash
# Builds UxPlay with MSYS2 (UCRT64) and stages a self-contained copy
# (uxplay.exe + every DLL + the GStreamer plugins it needs) into vendor/uxplay.
#
# Run from an "MSYS2 UCRT64" shell, in the project root:
#   bash scripts/build-uxplay.sh
#
# Required MSYS2 packages (the CI workflow installs these):
#   pacman -S --needed git mingw-w64-ucrt-x86_64-{gcc,cmake,ninja,pkgconf,openssl,libplist,\
#     gstreamer,gst-plugins-base,gst-plugins-good,gst-plugins-bad,gst-libav,pango}
set -euo pipefail

# UxPlay 1.74 (master): has its own mDNS, so Apple's Bonjour is NOT needed.
UXPLAY_REPO="${UXPLAY_REPO:-https://github.com/FDH2/UxPlay}"
UXPLAY_REF="${UXPLAY_REF:-fbd040e70e754e01fa7e6df810fecd08b6484ada}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${WORK:-$ROOT/.uxplay-build}"
STAGE="$ROOT/vendor/uxplay"
PREFIX="${MINGW_PREFIX:-/ucrt64}"

if [[ "${MSYSTEM:-}" != "UCRT64" ]]; then
  echo "Run this from an MSYS2 UCRT64 shell (MSYSTEM is '${MSYSTEM:-unset}')." >&2
  exit 1
fi

echo "==> Fetching UxPlay @ $UXPLAY_REF"
if [[ ! -d "$WORK/src/.git" ]]; then
  git init -q "$WORK/src"
  git -C "$WORK/src" remote add origin "$UXPLAY_REPO"
fi
git -C "$WORK/src" fetch -q --depth 1 origin "$UXPLAY_REF"
git -C "$WORK/src" checkout -q --force FETCH_HEAD

echo "==> Building"
# -mwindows = GUI subsystem: uxplay.exe gets no console window, so Mirrorlet can spawn it
# WITHOUT windowsHide (which would otherwise hide GStreamer's video window as well).
# stdout/stderr still reach Mirrorlet through the pipes it passes in.
cmake -S "$WORK/src" -B "$WORK/build" -G Ninja -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_EXE_LINKER_FLAGS=-mwindows
cmake --build "$WORK/build" --parallel

echo "==> Staging into $STAGE"
rm -rf "$STAGE"
mkdir -p "$STAGE/bin" "$STAGE/lib/gstreamer-1.0" "$STAGE/libexec/gstreamer-1.0"
cp "$WORK/build/uxplay.exe" "$STAGE/bin/"
cp "$PREFIX/libexec/gstreamer-1.0/gst-plugin-scanner.exe" "$STAGE/libexec/gstreamer-1.0/"
cp "$PREFIX/bin/gst-inspect-1.0.exe" "$STAGE/bin/"   # handy for troubleshooting
cp "$WORK/src/LICENSE" "$STAGE/UXPLAY-LICENSE.txt"

# GStreamer plugins UxPlay's mirroring, audio, rotation and recording pipelines use.
# "required" ones must exist; "optional" ones are copied when present.
REQUIRED_PLUGINS=(
  coreelements typefindfunctions app playback autodetect
  videoconvertscale videofilter audioconvert audioresample volume level
  libav videoparsersbad audioparsers d3d11 wasapi
  jpeg imagefreeze pango isomp4
)
OPTIONAL_PLUGINS=( d3d12 wasapi2 directsound rtp udp dxva )

plugin_file() {
  # Prints the plugin DLL path for a plugin name, or nothing if missing.
  local f
  f="$(gst-inspect-1.0 "$1" 2>/dev/null | awk '$1=="Filename"{ $1=""; sub(/^ +/, ""); print; exit }' | tr -d '\r')"
  [[ -n "$f" ]] && cygpath -u "$f"
}

missing=0
for p in "${REQUIRED_PLUGINS[@]}"; do
  f="$(plugin_file "$p" || true)"
  if [[ -z "$f" || ! -f "$f" ]]; then echo "!! required GStreamer plugin missing: $p" >&2; missing=1; continue; fi
  cp "$f" "$STAGE/lib/gstreamer-1.0/"
  echo "   plugin $p -> $(basename "$f")"
done
for p in "${OPTIONAL_PLUGINS[@]}"; do
  f="$(plugin_file "$p" || true)"
  if [[ -n "$f" && -f "$f" ]]; then cp "$f" "$STAGE/lib/gstreamer-1.0/"; echo "   plugin $p -> $(basename "$f") (optional)"; fi
done
[[ $missing -eq 0 ]] || { echo "Install the missing GStreamer packages and re-run." >&2; exit 1; }

echo "==> Collecting DLL dependencies"
# ldd lists transitive deps; keep only DLLs that come from MSYS2 (not Windows itself).
collect() {
  ldd "$1" 2>/dev/null | awk '{print $3}' | grep -E "^${PREFIX}/bin/.+\.dll$" || true
}
declare -A seen=()
queue=( "$STAGE/bin/uxplay.exe" "$STAGE/bin/gst-inspect-1.0.exe" "$STAGE/libexec/gstreamer-1.0/gst-plugin-scanner.exe" )
for f in "$STAGE"/lib/gstreamer-1.0/*.dll; do queue+=( "$f" ); done
while ((${#queue[@]})); do
  item="${queue[0]}"; queue=( "${queue[@]:1}" )
  while read -r dll; do
    [[ -z "$dll" ]] && continue
    name="$(basename "$dll")"
    [[ -n "${seen[$name]:-}" ]] && continue
    seen[$name]=1
    cp "$dll" "$STAGE/bin/"
    queue+=( "$dll" )
  done < <(collect "$item")
done
echo "   copied ${#seen[@]} DLLs"

du -sh "$STAGE"
echo "==> Done: $STAGE/bin/uxplay.exe"
