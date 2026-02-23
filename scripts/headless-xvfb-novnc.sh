#!/usr/bin/env bash
set -euo pipefail

# Headless launcher for Agentify Desktop on Linux servers (browser access).
#
# What it does:
# - Creates a virtual X display via Xvfb
# - Starts a lightweight window manager (fluxbox)
# - Starts a localhost-only VNC server (x11vnc)
# - Exposes VNC in the browser via noVNC (websockify + static files)
#
# Connect from your laptop using SSH/Tailscale port-forwarding:
#   ssh -L 6080:127.0.0.1:6080 ubuntu@<tailscale-ip-or-hostname>
# Then open:
#   http://127.0.0.1:6080/vnc.html?autoconnect=1

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

DISPLAY_NUM="${DISPLAY_NUM:-99}"
DISPLAY=":${DISPLAY_NUM}"

VNC_PORT="${VNC_PORT:-5901}"
NOVNC_PORT="${NOVNC_PORT:-6080}"

SCREEN_W="${SCREEN_W:-1440}"
SCREEN_H="${SCREEN_H:-900}"
SCREEN_D="${SCREEN_D:-24}"

NOVNC_WEB_DIR="${NOVNC_WEB_DIR:-/usr/share/novnc}"

say() { printf "\n%s\n" "$*"; }
die() { printf "\nERROR: %s\n" "$*" >&2; exit 1; }

command -v Xvfb >/dev/null 2>&1 || die "Xvfb not found (install: sudo apt-get install xvfb)"
command -v fluxbox >/dev/null 2>&1 || die "fluxbox not found (install: sudo apt-get install fluxbox)"
command -v x11vnc >/dev/null 2>&1 || die "x11vnc not found (install: sudo apt-get install x11vnc)"
command -v websockify >/dev/null 2>&1 || die "websockify not found (install: sudo apt-get install novnc websockify)"
command -v npm >/dev/null 2>&1 || die "npm not found"

if [[ ! -f "${NOVNC_WEB_DIR}/vnc.html" ]]; then
  die "noVNC web dir missing vnc.html at ${NOVNC_WEB_DIR} (install: sudo apt-get install novnc)"
fi

say "Agentify Desktop (headless + browser)"
say "Repo: ${REPO_ROOT}"
say "DISPLAY: ${DISPLAY}"
say "VNC: 127.0.0.1:${VNC_PORT} (localhost-only)"
say "noVNC: http://127.0.0.1:${NOVNC_PORT}/vnc.html?autoconnect=1 (localhost-only)"

cleanup() {
  set +e
  [[ -n "${WEBSOCKIFY_PID:-}" ]] && kill "${WEBSOCKIFY_PID}" >/dev/null 2>&1 || true
  [[ -n "${X11VNC_PID:-}" ]] && kill "${X11VNC_PID}" >/dev/null 2>&1 || true
  [[ -n "${FLUXBOX_PID:-}" ]] && kill "${FLUXBOX_PID}" >/dev/null 2>&1 || true
  [[ -n "${XVFB_PID:-}" ]] && kill "${XVFB_PID}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

say "1) Starting Xvfb..."
Xvfb "${DISPLAY}" \
  -screen 0 "${SCREEN_W}x${SCREEN_H}x${SCREEN_D}" \
  -nolisten tcp \
  >/dev/null 2>&1 &
XVFB_PID=$!

say "2) Starting fluxbox..."
DISPLAY="${DISPLAY}" fluxbox >/dev/null 2>&1 &
FLUXBOX_PID=$!

say "3) Starting VNC server (x11vnc)..."
x11vnc \
  -display "${DISPLAY}" \
  -rfbport "${VNC_PORT}" \
  -localhost \
  -nopw \
  -forever \
  -shared \
  -quiet \
  >/dev/null 2>&1 &
X11VNC_PID=$!

say "4) Starting noVNC (websockify)..."
# Bind websockify to 127.0.0.1 only. Use SSH/Tailscale port forwarding.
websockify \
  --web "${NOVNC_WEB_DIR}" \
  "127.0.0.1:${NOVNC_PORT}" \
  "127.0.0.1:${VNC_PORT}" \
  >/dev/null 2>&1 &
WEBSOCKIFY_PID=$!

say "5) Starting Agentify Desktop (Electron)..."
say "Tip: set AGENTIFY_DESKTOP_SHOW_TABS=true to show tabs by default."

cd "${REPO_ROOT}"
AGENTIFY_DESKTOP_SHOW_TABS="${AGENTIFY_DESKTOP_SHOW_TABS:-true}" \
DISPLAY="${DISPLAY}" \
npm run start
